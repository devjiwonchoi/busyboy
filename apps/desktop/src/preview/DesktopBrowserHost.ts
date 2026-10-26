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
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { createCdpRelayConnection, type CdpRelayConnection } from "./CdpRelay.ts";
import { sendPageCommand } from "./GuestInput.ts";
import * as PasswordSignIn from "./Passwords/PasswordSignIn.ts";

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
/** How often a locked page is checked for a password still in a field. */
const CREDENTIAL_CHECK_MS = 750;
/** A failed sign-in can leave the password in place; it is cleared after this. */
const CREDENTIAL_LOCK_MAX_MS = 60_000;
/** Network events about the submitted form can still arrive after the lock. */
const SCRUB_AFTER_UNLOCK_MS = 120_000;
const SCRUBBED_TEXT = "[saved password]";

/** The ways a password can appear inside a serialized CDP message. */
export const secretForms = (secret: string): ReadonlyArray<string> => {
  const jsonEscaped = JSON.stringify(secret).slice(1, -1);
  return [
    ...new Set([
      secret,
      jsonEscaped,
      JSON.stringify(jsonEscaped).slice(1, -1),
      encodeURIComponent(secret),
      encodeURIComponent(secret).replace(/%20/g, "+"),
    ]),
  ].filter((form) => form.length > 0);
};

export interface DesktopBrowserTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

export interface DesktopBrowserTabDebugger {
  readonly webContents: Electron.WebContents;
  readonly debugger: Electron.Debugger;
}

const keyOf = ({ threadId, tabId }: DesktopBrowserTabKey) => `${threadId}\u0000${tabId}`;

interface AttachedTab {
  readonly key: DesktopBrowserTabKey;
  readonly debuggee: DesktopBrowserTabDebugger;
  relay: CdpRelayConnection | null;
  downloadDirectory: string | null;
  pendingDownloadGuid: string | null;
  agentInputAt: number;
  /** Set while a password filled for the agent may still be in the page. */
  credentialLock: { readonly release: () => void } | null;
  /** Passwords to remove from everything sent to the agent, until a deadline. */
  scrubbed: Array<{ readonly secret: string; until: number }>;
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
    /** True when the agent sent this page input moments ago; it is not autofilled then. */
    readonly isAgentDriving: (source: Electron.WebContents) => boolean;
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

  const scrub = (tab: AttachedTab, message: string) => {
    const now = performance.now();
    tab.scrubbed = tab.scrubbed.filter((entry) => entry.until > now);
    let scrubbed = message;
    for (const entry of tab.scrubbed) {
      for (const form of secretForms(entry.secret)) {
        scrubbed = scrubbed.split(form).join(SCRUBBED_TEXT);
      }
    }
    return scrubbed;
  };

  /**
   * Holds the agent off the page from just before a saved password enters it
   * until the page navigates or no password field holds a value, clearing the
   * fields itself if that takes too long.
   */
  const lockCredentials = (tab: AttachedTab, secret: string) => {
    tab.credentialLock?.release();
    const webContents = tab.debuggee.webContents;
    const entry = { secret, until: Number.POSITIVE_INFINITY };
    tab.scrubbed.push(entry);
    const lockedAt = performance.now();
    let checking = false;

    const release = () => {
      clearInterval(timer);
      webContents.off("did-navigate", release);
      webContents.off("destroyed", release);
      entry.until = performance.now() + SCRUB_AFTER_UNLOCK_MS;
      if (tab.credentialLock?.release === release) {
        tab.credentialLock = null;
      }
    };
    const check = async () => {
      if (performance.now() - lockedAt > CREDENTIAL_LOCK_MAX_MS) {
        await passwordSignIn.clearPasswordFields(webContents);
        release();
        return;
      }
      if (!(await passwordSignIn.pageHoldsPassword(webContents))) {
        release();
      }
    };
    const timer = setInterval(() => {
      if (checking || webContents.isDestroyed()) {
        return;
      }
      checking = true;
      void check().finally(() => {
        checking = false;
      });
    }, CREDENTIAL_CHECK_MS);
    webContents.on("did-navigate", release);
    webContents.on("destroyed", release);
    tab.credentialLock = { release };
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
        signIn: (params) =>
          passwordSignIn.signIn({
            guest: webContents,
            request: params,
            lock: (secret) => lockCredentials(tab, secret),
          }),
        credentialLocked: () => tab.credentialLock !== null,
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
      scrubbed: [],
      onMessage: (_event, method, params, sessionId) => {
        if (method === "Browser.downloadWillBegin") {
          const guid = (params as { guid?: unknown } | undefined)?.guid;
          tab.pendingDownloadGuid = typeof guid === "string" ? guid : null;
        }
        tab.relay?.event(method, params, sessionId);
      },
    };
    tabs.set(id, tab);
    debuggee.debugger.on("message", tab.onMessage);
    // A password filled before the agent arrived is guarded too; its value is
    // unknown here, so reads are refused but nothing can be scrubbed.
    void passwordSignIn.pageHoldsPassword(debuggee.webContents).then((holdsPassword) => {
      if (holdsPassword && tabs.get(id) === tab && tab.credentialLock === null) {
        lockCredentials(tab, "");
      }
    });
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
    [...tabs.values()].some(
      (candidate) =>
        candidate.debuggee.webContents === source &&
        performance.now() - candidate.agentInputAt < AGENT_DRIVING_WINDOW_MS,
    );

  const lockForFilledPassword = (source: Electron.WebContents, password: string) => {
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
    lockForFilledPassword,
  });
});

export const layer = Layer.effect(DesktopBrowserHost, make);
