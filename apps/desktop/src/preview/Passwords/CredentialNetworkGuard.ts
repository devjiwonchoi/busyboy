// @effect-diagnostics nodeBuiltinImport:off - Reads request bodies Electron hands over as Buffers.
// @effect-diagnostics globalDate:off - Runs inside Electron's request callback, outside any Effect runtime.
// @effect-diagnostics globalConsole:off - Same callback; a blocked leak must still reach the log.
import { Buffer } from "node:buffer";

import type * as Electron from "electron";
import { getDomain } from "tldts";

/**
 * Where a filled password may be sent. An agent's approved sign-in may only
 * post to the page's own origin, like Codex's browserAuth. A person's autofill
 * may also reach the same site (`example.com` to `login.example.com`), which
 * real sign-in forms rely on.
 */
export type SubmissionScope = "origin" | "site";

/** Requests a page fires while unloading still carry its form; they stay covered this long. */
const GRACE_AFTER_NAVIGATION_MS = 10_000;
/**
 * Right after an agent's sign-in fills the form, nothing may leave for
 * another origin with any data at all, so a script waiting in the page cannot
 * slip the password out in a form these checks would not recognise. It
 * outlasts the 60 seconds after which a password left in the page is cleared.
 */
const STRICT_AFTER_AGENT_FILL_MS = 120_000;

/** Forms a password takes inside a URL, a form body, JSON, or base64. */
export const passwordForms = (secret: string): ReadonlyArray<string> => {
  const jsonEscaped = JSON.stringify(secret).slice(1, -1);
  const bytes = Buffer.from(secret, "utf8");
  const formEncoded = new URLSearchParams({ p: secret }).toString().slice(2);
  return [
    ...new Set([
      secret,
      jsonEscaped,
      JSON.stringify(jsonEscaped).slice(1, -1),
      encodeURIComponent(secret),
      encodeURIComponent(secret).replace(/%20/g, "+"),
      // How a form body encodes it: also escapes ! ' ( ) ~.
      formEncoded,
      formEncoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
      encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
      bytes.toString("base64"),
      bytes.toString("base64url"),
    ]),
  ].filter((form) => form.length > 0);
};

type Guard = {
  readonly forms: ReadonlyArray<string>;
  readonly pageOrigin: string;
  readonly scope: SubmissionScope;
  /** Until when any data bound for another origin is refused, not only the password. */
  readonly strictUntil: number;
  /** When the page left the document; `null` while it is still there. */
  releasedAt: number | null;
};

const originOf = (url: string) => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

const sameSite = (left: URL, right: URL) => {
  if (left.protocol !== right.protocol) {
    return false;
  }
  // Hosting suffixes such as github.io count, so two people's pages there are not one site.
  const leftSite = getDomain(left.hostname, { allowPrivateDomains: true });
  const rightSite = getDomain(right.hostname, { allowPrivateDomains: true });
  // IP addresses and `localhost` have no registrable domain; only the host itself matches.
  return leftSite === null || rightSite === null
    ? left.hostname === right.hostname
    : leftSite === rightSite;
};

const mayReceive = (guard: Guard, requestUrl: string) => {
  const request = originOf(requestUrl);
  const page = originOf(guard.pageOrigin);
  if (request === null || page === null) {
    return false;
  }
  if (request.origin === page.origin) {
    return true;
  }
  return guard.scope === "site" && sameSite(request, page);
};

const carriesPassword = (
  guard: Guard,
  url: string,
  uploadData: ReadonlyArray<Electron.UploadData> | undefined,
) => {
  const texts = [url];
  for (const part of uploadData ?? []) {
    if (part.bytes !== undefined) {
      texts.push(Buffer.from(part.bytes).toString("utf8"));
    } else {
      // A file or blob body cannot be read here, so it cannot be cleared.
      return true;
    }
  }
  return texts.some((text) => guard.forms.some((form) => text.includes(form)));
};

/** A query string, a body, or a socket: anything that can carry data off the page. */
const carriesData = (url: string, uploadData: ReadonlyArray<Electron.UploadData> | undefined) => {
  const parsed = originOf(url);
  return (
    parsed === null ||
    parsed.search !== "" ||
    parsed.protocol === "ws:" ||
    parsed.protocol === "wss:" ||
    (uploadData?.length ?? 0) > 0
  );
};

const guardsByWebContents = new Map<number, Set<Guard>>();
const guardsBySession = new WeakMap<Electron.Session, Set<Guard>>();
const installedSessions = new WeakSet<Electron.Session>();

const live = (guards: Set<Guard> | undefined) => {
  const now = Date.now();
  for (const guard of guards ?? []) {
    if (guard.releasedAt !== null && now - guard.releasedAt > GRACE_AFTER_NAVIGATION_MS) {
      guards?.delete(guard);
    }
  }
  return [...(guards ?? [])];
};

/**
 * Electron allows one `onBeforeRequest` listener per session; preview sessions
 * have no other, so this one owns it.
 */
const install = (session: Electron.Session) => {
  if (installedSessions.has(session)) {
    return;
  }
  installedSessions.add(session);
  session.webRequest.onBeforeRequest((details, callback) => {
    // A service worker's request has no page; it answers to every guard in its session.
    const guards =
      details.webContentsId === undefined
        ? live(guardsBySession.get(session))
        : live(guardsByWebContents.get(details.webContentsId));
    const now = Date.now();
    const leaks = guards.some(
      (guard) =>
        !mayReceive(guard, details.url) &&
        (carriesPassword(guard, details.url, details.uploadData) ||
          (now < guard.strictUntil && carriesData(details.url, details.uploadData))),
    );
    if (leaks) {
      console.warn("Blocked a request that would have sent a saved password to another site.", {
        host: originOf(details.url)?.host ?? null,
      });
    }
    callback(leaks ? { cancel: true } : {});
  });
};

/**
 * Stops the page from sending `secret` anywhere `scope` does not allow, from
 * now until shortly after it navigates to another document.
 */
export const guardPasswordSubmission = ({
  guest,
  secret,
  pageOrigin,
  scope,
}: {
  readonly guest: Electron.WebContents;
  readonly secret: string;
  readonly pageOrigin: string;
  readonly scope: SubmissionScope;
}) => {
  install(guest.session);
  const guard: Guard = {
    forms: passwordForms(secret),
    pageOrigin,
    scope,
    strictUntil: scope === "origin" ? Date.now() + STRICT_AFTER_AGENT_FILL_MS : 0,
    releasedAt: null,
  };

  const byWebContents = guardsByWebContents.get(guest.id) ?? new Set();
  byWebContents.add(guard);
  guardsByWebContents.set(guest.id, byWebContents);
  const bySession = guardsBySession.get(guest.session) ?? new Set();
  bySession.add(guard);
  guardsBySession.set(guest.session, bySession);

  const navigated = () => {
    guard.releasedAt ??= Date.now();
    guest.off("did-navigate", navigated);
  };
  guest.on("did-navigate", navigated);
  guest.once("destroyed", () => {
    guardsByWebContents.delete(guest.id);
    bySession.delete(guard);
  });
};
