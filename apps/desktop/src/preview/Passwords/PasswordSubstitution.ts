// @effect-diagnostics nodeBuiltinImport:off - Rewrites request bodies Chromium hands over as base64.
// @effect-diagnostics globalTimers:off - Runs in Electron debugger callbacks, outside any Effect runtime.
/**
 * An agent's sign-in never puts the saved password in the page. The form gets
 * a random stand-in, and the sign-in request leaving for the page's own origin
 * carries the real password in its place. Whatever the page copies, keeps in
 * memory or sends elsewhere (a socket opened earlier, WebRTC, a later request)
 * is the stand-in, which is worthless.
 */
import { Buffer } from "node:buffer";
import * as NodeCrypto from "node:crypto";

const STAND_IN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const MIN_STAND_IN_LENGTH = 16;
/**
 * Turning interception off cancels a rewritten request still in flight, so it
 * stays on this long after the swap, passing everything else through.
 */
const KEEP_INTERCEPTING_MS = 10_000;

/**
 * Letters and digits only, so it reads the same raw, URL-encoded and in JSON,
 * and has upper case, lower case and a digit for sites that check the form.
 */
export const makeStandIn = (password: string) => {
  const length = Math.max(password.length, MIN_STAND_IN_LENGTH);
  const bytes = NodeCrypto.randomBytes(length);
  const characters = [...bytes].map((byte) => STAND_IN_ALPHABET[byte % STAND_IN_ALPHABET.length]);
  characters[0] = "Q";
  characters[1] = "q";
  characters[2] = "7";
  return characters.join("");
};

export interface PausedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers?: Record<string, string>;
  readonly postData?: string;
  readonly postDataEntries?: ReadonlyArray<{ readonly bytes?: string }>;
}

const headerValue = (headers: Record<string, string> | undefined, name: string) =>
  Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1] ?? "";

const bodyText = (request: PausedRequest) =>
  request.postDataEntries !== undefined && request.postDataEntries.length > 0
    ? Buffer.concat(
        request.postDataEntries.map((entry) => Buffer.from(entry.bytes ?? "", "base64")),
      ).toString("utf8")
    : (request.postData ?? null);

/** How the password must be written in this body to read back as itself. */
const encodeFor = (contentType: string, body: string, password: string) => {
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return encodeURIComponent(password).replace(/%20/g, "+");
  }
  const trimmed = body.trimStart();
  if (contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.stringify(password).slice(1, -1);
  }
  return password;
};

/**
 * The body to send instead, base64-encoded as CDP expects, or `null` to send
 * the request untouched. Only a body sent to the page's own origin is
 * rewritten; a URL is never, so the password cannot land in a link, a log or
 * a page that echoes its address.
 */
export const substitutedBody = ({
  request,
  standIn,
  password,
  pageOrigin,
}: {
  readonly request: PausedRequest;
  readonly standIn: string;
  readonly password: string;
  readonly pageOrigin: string;
}): string | null => {
  let origin: string;
  try {
    origin = new URL(request.url).origin;
  } catch {
    return null;
  }
  if (origin !== pageOrigin || request.method === "GET" || request.method === "HEAD") {
    return null;
  }
  const body = bodyText(request);
  if (body === null || !body.includes(standIn)) {
    return null;
  }
  const encoded = encodeFor(headerValue(request.headers, "content-type"), body, password);
  return Buffer.from(body.split(standIn).join(encoded), "utf8").toString("base64");
};

export interface Substitution {
  /** Resolves once requests to the origin are paused; fill only after this. */
  readonly ready: Promise<void>;
  /** Resolves `true` once the sign-in request left with the real password. */
  readonly done: Promise<boolean>;
  readonly cancel: () => void;
}

/**
 * Pauses requests to the page's origin and swaps the password into the first
 * one that carries the stand-in, then stops. Only one: a page that sends the
 * stand-in again, for instance to an endpoint that echoes it back, gets the
 * stand-in. `onDebuggerMessage` must be handed every debugger event from the
 * moment this returns; it returns true for the ones it consumed.
 */
export const armSubstitution = ({
  debuggee,
  standIn,
  password,
  pageOrigin,
  keepInterceptingMs = KEEP_INTERCEPTING_MS,
}: {
  readonly debuggee: Pick<Electron.Debugger, "sendCommand">;
  readonly standIn: string;
  readonly password: string;
  readonly pageOrigin: string;
  readonly keepInterceptingMs?: number;
}): Substitution & {
  readonly onDebuggerMessage: (method: string, params: unknown) => boolean;
} => {
  let settle: (swapped: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  let swapped = false;
  let finished = false;
  let disabled = false;

  const finish = (result: boolean) => {
    if (finished) {
      return;
    }
    finished = true;
    settle(result);
    // Requests paused before interception is off still need answering; until
    // then the listener stays and sends them on untouched.
    const disable = () =>
      void debuggee
        .sendCommand("Fetch.disable")
        .catch(() => undefined)
        .finally(() => {
          disabled = true;
        });
    if (result) {
      setTimeout(disable, keepInterceptingMs);
    } else {
      disable();
    }
  };

  const onDebuggerMessage = (method: string, params: unknown) => {
    if (disabled || !method.startsWith("Fetch.")) {
      return false;
    }
    if (method !== "Fetch.requestPaused") {
      return true;
    }
    const paused = params as { readonly requestId: string; readonly request: PausedRequest };
    const postData =
      swapped || finished
        ? null
        : substitutedBody({ request: paused.request, standIn, password, pageOrigin });
    if (postData !== null) {
      swapped = true;
    }
    void debuggee
      .sendCommand(
        "Fetch.continueRequest",
        postData === null
          ? { requestId: paused.requestId }
          : { requestId: paused.requestId, postData },
      )
      .then(
        () => {
          if (postData !== null) {
            finish(true);
          }
        },
        () => {
          if (postData !== null) {
            finish(false);
          }
        },
      );
    return true;
  };

  const ready = debuggee
    .sendCommand("Fetch.enable", {
      patterns: [{ urlPattern: `${pageOrigin}/*`, requestStage: "Request" }],
    })
    .then(() => undefined);
  return { ready, done, cancel: () => finish(false), onDebuggerMessage };
};
