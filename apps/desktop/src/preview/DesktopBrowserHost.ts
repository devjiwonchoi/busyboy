// @effect-diagnostics nodeBuiltinImport:off - Names download files on the shared disk.
// @effect-diagnostics globalTimers:off - Polls a page's password fields from Electron callbacks.
/**
 * The preview manager owns the tab's single debugger session and hands it here;
 * the relay shares it.
 */
import {
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  type DesktopBrowserEvent as DesktopBrowserEventType,
  type PreviewSignInResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import { Buffer } from "node:buffer";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { createCdpRelayConnection, type CdpRelayConnection } from "./CdpRelay.ts";
import { sendPageCommand } from "./GuestInput.ts";
import { passwordForms } from "./Passwords/CredentialNetworkGuard.ts";
import * as PasswordSignIn from "./Passwords/PasswordSignIn.ts";
import { armSubstitution } from "./Passwords/PasswordSubstitution.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(DesktopBrowserEvent));
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopBrowserCommand));
const lineEncoder = new TextEncoder();
const AGENT_INPUT_COMMAND =
  /"method":"(?:Input\.|Page\.navigate"|Runtime\.(?:evaluate|callFunctionOn)")/;
const AGENT_DOWNLOAD_WINDOW_MS = 5_000;
/**
 * Agent input this recent means the agent caused the click that asked for an
 * autofill; agent clicks are trusted events, so the page cannot tell.
 */
const AGENT_DRIVING_WINDOW_MS = 3_000;
const SCRUBBED_TEXT = "[saved password]";
/** How long an attaching agent's commands wait for the page to be checked. */
const ATTACH_CHECK_MS = 2_000;
/** Strings this long are screenshots or bodies too big to hide a password worth decoding. */
const MAX_DECODED_LENGTH = 64 * 1024;
const BASE64_TEXT = /^[A-Za-z0-9+/_-]{8,}={0,2}$/;
/** Request body fields CDP reports, dropped while a password of unknown value is in the page. */
const BODY_FIELDS = new Set(["postData", "postDataEntries"]);
/** Fields that hold a request or response body, decoded whatever their size. */
const BODY_KEYS = new Set(["postData", "bytes", "body"]);

export interface DesktopBrowserTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

export interface DesktopBrowserTabDebugger {
  readonly webContents: Electron.WebContents;
  readonly debugger: Electron.Debugger;
}

const originOf = (url: string) => {
  try {
    const { origin } = new URL(url);
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
};

const keyOf = ({ threadId, tabId }: DesktopBrowserTabKey) => `${threadId}\u0000${tabId}`;

interface AttachedTab {
  readonly key: DesktopBrowserTabKey;
  readonly debuggee: DesktopBrowserTabDebugger;
  relay: CdpRelayConnection | null;
  downloadDirectory: string | null;
  pendingDownloadGuid: string | null;
  agentInputAt: number;
  /** Set while a password filled for the agent may still be in the page. */
  credentialLock: {
    readonly release: () => void;
    /** The password's value is unknown, so nothing can be scrubbed; bodies are dropped. */
    readonly unknownSecret: boolean;
  } | null;
  /**
   * The agent ran its own JavaScript in the current document, which could be
   * waiting to intercept a login. Cleared when the page loads a new document.
   */
  agentScriptInDocument: boolean;
  readonly onNavigate: () => void;
  /** Settles once the page was checked for a password the person entered. */
  ready: Promise<void>;
  /**
   * Passwords removed from everything sent to the agent for as long as the tab
   * is attached: the browser can still hand back old request bodies later.
   */
  readonly scrubbed: Set<string>;
  /** Consumes the debugger's interception events while a sign-in swaps its password in. */
  interceptor: ((method: string, params: unknown) => boolean) | null;
  /**
   * True from an agent sign-in's start until its swap can no longer happen.
   * The agent stays off the page all that time: it could otherwise read the
   * stand-in and have the page send it somewhere that echoes it back.
   */
  signingIn: boolean;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void;
}

export class DesktopBrowserHost extends Context.Service<
  DesktopBrowserHost,
  {
    readonly events: Stream.Stream<Uint8Array>;
    readonly handleCommandLine: (line: string) => Effect.Effect<void>;
    readonly attach: (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => void;
    readonly detach: (key: DesktopBrowserTabKey) => void;
    readonly humanStartedDownload: (source: Electron.WebContents) => boolean;
    /**
     * True when the agent sent this page input moments ago or ran its own
     * script in it; such a page is not autofilled.
     */
    readonly isAgentDriving: (source: Electron.WebContents) => boolean;
    /** True for a value an agent sign-in put in a page instead of the password. */
    readonly isPasswordStandIn: (value: string) => boolean;
    /**
     * Keeps the agent off a page a saved password was just filled into, as
     * after an agent sign-in. A page no agent is attached to needs nothing.
     */
    readonly lockForFilledPassword: (source: Electron.WebContents, password: string) => void;
    readonly placeDownload: (source: Electron.WebContents, item: Electron.DownloadItem) => boolean;
    readonly pointers: Stream.Stream<{
      readonly key: DesktopBrowserTabKey;
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
    }>;
  }
>()("@t3tools/desktop/preview/DesktopBrowserHost") {}

export const make = Effect.gen(function* () {
  const outbox = yield* PubSub.unbounded<DesktopBrowserEventType>();
  const pointers = yield* PubSub.sliding<{
    readonly key: DesktopBrowserTabKey;
    readonly phase: "move" | "click";
    readonly x: number;
    readonly y: number;
  }>(16);
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const passwordSignIn = yield* PasswordSignIn.PasswordSignIn;
  const tabs = new Map<string, AttachedTab>();
  /**
   * Every stand-in an agent sign-in put in a page this run. A form still
   * holding one must never be offered for saving as the user's password.
   */
  const standIns = new Set<string>();
  /**
   * Sites the agent ran its own script on this run. Its script can outlive
   * the page (a popup, a service worker, stored data), so these sites are
   * never autofilled for a person again until the app restarts.
   */
  const scriptedOrigins = new Set<string>();

  /**
   * Passwords a person's autofill put in a page's current document, kept even
   * while no agent is attached, so one that attaches later is locked out too.
   */
  const filledByDocument = new WeakMap<Electron.WebContents, Set<string>>();

  const scrubText = (forms: ReadonlyArray<string>, text: string, isBody = false) => {
    // CDP hands bodies over as base64 of the whole body, where the password
    // can start at any offset, so its own base64 forms may not appear.
    if (
      forms.length > 0 &&
      (isBody || text.length <= MAX_DECODED_LENGTH) &&
      BASE64_TEXT.test(text)
    ) {
      const decoded = Buffer.from(text, "base64").toString("utf8");
      if (forms.some((form) => decoded.includes(form))) {
        return SCRUBBED_TEXT;
      }
    }
    let scrubbed = text;
    for (const form of forms) {
      scrubbed = scrubbed.split(form).join(SCRUBBED_TEXT);
    }
    return scrubbed;
  };

  const scrub = (tab: AttachedTab, message: string) => {
    const forms = [...tab.scrubbed].flatMap((secret) => passwordForms(secret));
    const dropBodies = tab.credentialLock?.unknownSecret === true;
    if (forms.length === 0 && !dropBodies) {
      return message;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return scrubText(forms, message);
    }
    const walk = (value: unknown, key = ""): unknown => {
      if (typeof value === "string") {
        return scrubText(forms, value, BODY_KEYS.has(key));
      }
      if (Array.isArray(value)) {
        return value.map((item) => walk(item, key));
      }
      if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !(dropBodies && BODY_FIELDS.has(key)))
            .map(([field, inner]) => [field, walk(inner, field)]),
        );
      }
      return value;
    };
    return JSON.stringify(walk(parsed));
  };

  /**
   * Holds the agent off the page until it loads another document. A password
   * can outlive its field (a "show password" toggle, a single-page app's
   * state), so an empty field is not enough to let the agent back in.
   */
  const lockCredentials = (
    tab: AttachedTab,
    secret: string | null,
    { checkNow = false }: { readonly checkNow?: boolean } = {},
  ) => {
    // A lock on a password of unknown value stays one: its bodies stay dropped.
    const unknownSecret = secret === null || tab.credentialLock?.unknownSecret === true;
    tab.credentialLock?.release();
    const webContents = tab.debuggee.webContents;
    if (secret !== null) {
      tab.scrubbed.add(secret);
    }
    const stillShown = () =>
      secret === null
        ? passwordSignIn.pageHoldsPassword(webContents)
        : passwordSignIn.pageContainsSecret(webContents, secret);
    let navigated = false;

    const release = () => {
      webContents.off("did-navigate", onNavigate);
      webContents.off("dom-ready", onReady);
      webContents.off("destroyed", release);
      if (tab.credentialLock?.release === release) {
        tab.credentialLock = null;
      }
    };
    const releaseIfClean = () =>
      void stillShown().then((shown) => {
        if (!shown) {
          release();
        }
      });
    const onNavigate = () => {
      navigated = true;
    };
    // The next document is checked once parsed: a server can echo a submitted
    // password into it, so leaving the page is not enough on its own.
    const onReady = () => {
      if (navigated) {
        navigated = false;
        releaseIfClean();
      }
    };
    webContents.on("did-navigate", onNavigate);
    webContents.on("dom-ready", onReady);
    webContents.on("destroyed", release);
    tab.credentialLock = { release, unknownSecret };
    // A sign-in that stayed on its page (a single-page app) is checked now;
    // one that is loading the next page is checked when it is ready.
    if (checkNow && !webContents.isLoadingMainFrame?.()) {
      releaseIfClean();
    }
  };
  const emit = (event: DesktopBrowserEventType) => runFork(PubSub.publish(outbox, event));

  const relayFor = (tab: AttachedTab) => {
    if (tab.relay) return tab.relay;
    const { webContents, debugger: debuggee } = tab.debuggee;
    const relay: CdpRelayConnection = createCdpRelayConnection(
      {
        send: (method, params, sessionId) =>
          sessionId === undefined
            ? sendPageCommand(webContents, debuggee, method, params)
            : debuggee.sendCommand(method, params, sessionId),
        targetId: () =>
          debuggee
            .sendCommand("Target.getTargetInfo")
            .then((result: { targetInfo: { targetId: string } }) => result.targetInfo.targetId),
        url: () => webContents.getURL(),
        title: () => webContents.getTitle(),
        userAgent: () => webContents.getUserAgent(),
        setDownloadDirectory: (directory) => {
          tab.downloadDirectory = directory;
        },
        signIn: async (params) => {
          if (tab.signingIn) {
            return { status: "unavailable" };
          }
          // The agent stays off the page while the swap can happen: it could
          // otherwise read the stand-in and have the page send it somewhere
          // that echoes the password back.
          tab.signingIn = true;
          let password: string | null = null;
          let result: PreviewSignInResult;
          try {
            result = await passwordSignIn.signIn({
              guest: webContents,
              request: params,
              pageModified: tab.agentScriptInDocument,
              lock: (secret) => {
                // The submit that follows is the agent's, not a person's.
                tab.agentInputAt = performance.now();
                tab.scrubbed.add(secret);
                password = secret;
              },
              substitute: (input) => {
                const substitution = armSubstitution({ debuggee, ...input });
                // It lets events through again once interception is off.
                tab.interceptor = substitution.onDebuggerMessage;
                standIns.add(input.standIn);
                return substitution;
              },
            });
          } finally {
            tab.signingIn = false;
          }
          // The swap is over, but the response may show the password.
          if (result.status === "submitted" && password !== null) {
            lockCredentials(tab, password, { checkNow: true });
          }
          return result;
        },
        ready: () => tab.ready,
        credentialLocked: () => tab.credentialLock !== null || tab.signingIn,
        noteAgentScript: () => {
          tab.agentScriptInDocument = true;
          const origin = originOf(webContents.getURL());
          if (origin !== null) {
            scriptedOrigins.add(origin);
          }
        },
      },
      (message) => {
        if (tab.relay === relay && tabs.get(keyOf(tab.key)) === tab) {
          emit({ type: "cdp", ...tab.key, message: scrub(tab, message) });
        }
      },
    );
    tab.relay = relay;
    return relay;
  };

  /**
   * Without a path Electron would open its Save dialog over the app for a file
   * the agent asked for. CDP names the download just before this runs.
   */
  const placeDownload = (source: Electron.WebContents, item: Electron.DownloadItem) => {
    const tab = [...tabs.values()].find(
      (candidate) => candidate.debuggee.webContents === source && candidate.downloadDirectory,
    );
    if (!tab?.downloadDirectory || !tab.pendingDownloadGuid) return false;
    item.setSavePath(NodePath.join(tab.downloadDirectory, tab.pendingDownloadGuid));
    tab.pendingDownloadGuid = null;
    return true;
  };

  const detach = (key: DesktopBrowserTabKey) => {
    const id = keyOf(key);
    const tab = tabs.get(id);
    if (!tab) return;
    tabs.delete(id);
    tab.credentialLock?.release();
    tab.debuggee.debugger.off("message", tab.onMessage);
    tab.debuggee.webContents.off?.("did-navigate", tab.onNavigate);
    emit({ type: "detached", ...key });
  };

  const attach = (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => {
    const id = keyOf(key);
    if (tabs.get(id)?.debuggee.webContents === debuggee.webContents) return;
    detach(key);
    const tab: AttachedTab = {
      key,
      debuggee,
      relay: null,
      downloadDirectory: null,
      pendingDownloadGuid: null,
      agentInputAt: Number.NEGATIVE_INFINITY,
      credentialLock: null,
      agentScriptInDocument: false,
      scrubbed: new Set(),
      interceptor: null,
      signingIn: false,
      ready: Promise.resolve(),
      onNavigate: () => {
        tab.agentScriptInDocument = false;
      },
      onMessage: (_event, method, params, sessionId) => {
        // The agent never sees the sign-in's paused requests or answers them.
        if (!sessionId && tab.interceptor?.(method, params)) {
          return;
        }
        if (method === "Browser.downloadWillBegin") {
          const guid = (params as { guid?: unknown } | undefined)?.guid;
          tab.pendingDownloadGuid = typeof guid === "string" ? guid : null;
        }
        tab.relay?.event(method, params, sessionId);
      },
    };
    tabs.set(id, tab);
    debuggee.debugger.on("message", tab.onMessage);
    debuggee.webContents.on?.("did-navigate", tab.onNavigate);
    // Passwords a person's autofill already put in this document are known.
    const filled = filledByDocument.get(debuggee.webContents);
    if (filled !== undefined && filled.size > 0) {
      for (const secret of filled) {
        tab.scrubbed.add(secret);
      }
      lockCredentials(tab, [...filled][0]!);
    } else {
      // One the person typed is not. The agent's commands wait for the page
      // to be checked rather than being refused, so automation can set up.
      const checked = passwordSignIn
        .pageHoldsPassword(debuggee.webContents)
        .then((holdsPassword) => {
          if (holdsPassword && tabs.get(id) === tab && tab.credentialLock === null) {
            lockCredentials(tab, null);
          }
        });
      tab.ready = Promise.race([
        checked,
        new Promise<void>((resolve) => setTimeout(resolve, ATTACH_CHECK_MS)),
      ]);
    }
    emit({ type: "attached", ...key });
  };

  const handleCommandLine = (line: string) =>
    Effect.sync(() => {
      const command = decodeCommand(line);
      if (Option.isNone(command)) return;
      const tab = tabs.get(keyOf(command.value));
      if (!tab) return;
      if (command.value.type === "pointer") {
        const { threadId, tabId, phase, x, y } = command.value;
        runFork(PubSub.publish(pointers, { key: { threadId, tabId }, phase, x, y }));
        return;
      }
      if (command.value.type === "release") {
        tab.relay = null;
        return;
      }
      if (AGENT_INPUT_COMMAND.test(command.value.message)) tab.agentInputAt = performance.now();
      relayFor(tab).receive(command.value.message);
    });

  const humanStartedDownload = (source: Electron.WebContents) => {
    const tab = [...tabs.values()].find((candidate) => candidate.debuggee.webContents === source);
    return tab !== undefined && performance.now() - tab.agentInputAt > AGENT_DOWNLOAD_WINDOW_MS;
  };

  const isAgentDriving = (source: Electron.WebContents) =>
    scriptedOrigins.has(originOf(source.getURL?.() ?? "") ?? "") ||
    [...tabs.values()].some(
      (candidate) =>
        candidate.debuggee.webContents === source &&
        (candidate.agentScriptInDocument ||
          performance.now() - candidate.agentInputAt < AGENT_DRIVING_WINDOW_MS),
    );

  const lockForFilledPassword = (source: Electron.WebContents, password: string) => {
    let filled = filledByDocument.get(source);
    if (filled === undefined) {
      const known = new Set<string>();
      filled = known;
      filledByDocument.set(source, known);
      source.on?.("did-navigate", () => known.clear());
    }
    filled.add(password);
    for (const tab of tabs.values()) {
      if (tab.debuggee.webContents === source) {
        lockCredentials(tab, password);
      }
    }
  };

  const announceAll = Effect.suspend(() =>
    Effect.forEach(
      [...tabs.values()],
      (tab) => {
        tab.relay = null;
        return PubSub.publish(outbox, { type: "attached", ...tab.key });
      },
      { discard: true },
    ),
  );

  return DesktopBrowserHost.of({
    pointers: Stream.fromPubSub(pointers),
    // Subscribes before announcing, so no attach falls between the two.
    events: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(outbox);
        yield* announceAll;
        return Stream.fromSubscription(subscription);
      }),
    ).pipe(Stream.map((event) => lineEncoder.encode(`${encodeEvent(event)}\n`))),
    handleCommandLine,
    attach,
    detach,
    placeDownload,
    humanStartedDownload,
    isAgentDriving,
    isPasswordStandIn: (value) => standIns.has(value),
    lockForFilledPassword,
  });
});

export const layer = Layer.effect(DesktopBrowserHost, make);
