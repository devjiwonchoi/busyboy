// @effect-diagnostics globalTimers:off - Guest sessions use plain timers through their port.
// @effect-diagnostics globalDate:off - Unlock windows and username memory compare wall-clock ms.
// @effect-diagnostics nodeBuiltinImport:off - Random request ids for the fill list.
import type { BrowserPasswordAutofillEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

import * as ElectronPowerMonitor from "../../electron/ElectronPowerMonitor.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as BrowserHistory from "../BrowserHistory/BrowserHistory.ts";
import * as DesktopBrowserHost from "../DesktopBrowserHost.ts";
import {
  PASSWORD_CHILD_FRAME_CHANNEL,
  PASSWORD_DROPDOWN_STATE_CHANNEL,
  PASSWORD_FIELD_BLUR_CHANNEL,
  PASSWORD_FIELD_FOCUS_CHANNEL,
  PASSWORD_FIELD_KEY_CHANNEL,
  PASSWORD_FILL_CHANNEL,
  PASSWORD_FORMS_CHANNEL,
  PASSWORD_FRAME_TOKEN_CHANNEL,
  PASSWORD_SUBMIT_CHANNEL,
} from "../GuestProtocol.ts";
import * as BrowserPasswords from "./BrowserPasswords.ts";
import { makeClientSettingsCache } from "./ClientSettingsCache.ts";
import { GuestAutofill, type AutofillFrame } from "./GuestAutofill.ts";
import {
  GuestChildFrame,
  GuestFieldFocus,
  GuestFieldKey,
  GuestFormsReport,
  GuestFrameToken,
  GuestSubmit,
} from "./PasswordGuestMessages.ts";

/** After a successful device check, further fills in the profile skip it for this long. */
export const FILL_UNLOCK_WINDOW_MS = 60_000;
/** Multi-step logins: a username typed on page 1 is remembered this long, in memory only. */
export const TYPED_USERNAME_TTL_MS = 5 * 60 * 1000;
/** Per frame and channel; anything above is dropped. */
const GUEST_MESSAGES_PER_SECOND = 30;

export interface PasswordAutofillShape {
  /** Starts save and fill for a guest. Does nothing for incognito or unknown sessions. */
  readonly attachGuest: (webContents: Electron.WebContents, tabId: string) => () => void;
  readonly choose: (tabId: string, requestId: string, loginId: number) => Effect.Effect<void>;
  readonly dismissFillList: (tabId: string) => Effect.Effect<void>;
  readonly respondToPrompt: (input: {
    readonly tabId: string;
    readonly promptId: string;
    readonly action: "save" | "notNow" | "never";
    readonly username?: string | undefined;
  }) => Effect.Effect<void>;
  readonly peek: (tabId: string, promptId: string) => Effect.Effect<string | null>;
  readonly reopenPrompt: (tabId: string) => Effect.Effect<void>;
  readonly subscribe: (listener: (event: BrowserPasswordAutofillEvent) => void) => () => void;
  /** Ends every unlock window, e.g. when the screen locks. */
  readonly lock: () => void;
}

export class PasswordAutofill extends Context.Service<PasswordAutofill, PasswordAutofillShape>()(
  "@t3tools/desktop/preview/BrowserPasswords/PasswordAutofill",
) {}

const decoders = {
  forms: Schema.decodeUnknownOption(GuestFormsReport),
  focus: Schema.decodeUnknownOption(GuestFieldFocus),
  key: Schema.decodeUnknownOption(GuestFieldKey),
  submit: Schema.decodeUnknownOption(GuestSubmit),
  frameToken: Schema.decodeUnknownOption(GuestFrameToken),
  childFrame: Schema.decodeUnknownOption(GuestChildFrame),
};

export const make = Effect.gen(function* () {
  const passwords = yield* BrowserPasswords.BrowserPasswords;
  const history = yield* BrowserHistory.BrowserHistory;
  const browserHost = yield* DesktopBrowserHost.DesktopBrowserHost;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const sessions = new Map<string, GuestAutofill>();
  const listeners = new Set<(event: BrowserPasswordAutofillEvent) => void>();
  const unlockedUntil = new Map<string, number>();
  const typedUsernames = new Map<string, { username: string; at: number }>();

  const settings = makeClientSettingsCache({
    get: clientSettings.get,
    runFork: (effect) => {
      runFork(effect);
    },
    runPromise: Effect.runPromiseWith(context),
  });
  settings.refresh();

  const emit = (event: BrowserPasswordAutofillEvent) => {
    for (const listener of listeners) listener(event);
  };

  const lock = () => unlockedUntil.clear();
  // A locked or sleeping Mac ends every unlock window (spec 4.3).
  yield* powerMonitor.onSimpleEvent("lock-screen", lock);
  yield* powerMonitor.onSimpleEvent("suspend", lock);

  const authorizeFill = async (profileId: string, site: string) => {
    if ((await settings.read())?.browserPasswordsRequireDeviceAuth === false) return true;
    if ((unlockedUntil.get(profileId) ?? 0) > Date.now()) return true;
    const approved = await passwords.authorize({ action: "fill", site });
    if (approved) unlockedUntil.set(profileId, Date.now() + FILL_UNLOCK_WINDOW_MS);
    return approved;
  };

  const attachGuest = (wc: Electron.WebContents, tabId: string) => {
    const profile = history.profileOf(wc.session);
    // Incognito never saves or fills, and unknown sessions are treated the same.
    if (profile === null || !profile.persistent) return () => {};
    const { profileId } = profile;
    const autofill = new GuestAutofill({
      tabId,
      channels: { fill: PASSWORD_FILL_CHANNEL, dropdownState: PASSWORD_DROPDOWN_STATE_CHANNEL },
      now: Date.now,
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      randomId: () => NodeCrypto.randomUUID(),
      topLevelUrl: () => (wc.isDestroyed() ? "" : wc.getURL()),
      agentActiveWithin: (ms) => browserHost.agentActingWithin(wc, ms),
      vault: () => passwords.vault(profileId),
      settings: () => ({
        offerToSave: settings.current()?.browserOfferToSavePasswords !== false,
      }),
      authorizeFill: (site) => authorizeFill(profileId, site),
      emit,
      notifyChanged: () => passwords.notifyChanged(profileId),
      rememberUsername: (origin, username) =>
        typedUsernames.set(`${profileId}\u0000${origin}`, { username, at: Date.now() }),
      recallUsername: (origin) => {
        const key = `${profileId}\u0000${origin}`;
        const entry = typedUsernames.get(key);
        if (entry === undefined) return null;
        if (Date.now() - entry.at > TYPED_USERNAME_TTL_MS) {
          typedUsernames.delete(key);
          return null;
        }
        return entry.username;
      },
    });
    sessions.get(tabId)?.dispose();
    sessions.set(tabId, autofill);

    const frames = new WeakMap<Electron.WebFrameMain, AutofillFrame>();
    const budgets = new Map<string, { windowStart: number; count: number }>();
    const frameFor = (frame: Electron.WebFrameMain): AutofillFrame => {
      const existing = frames.get(frame);
      if (existing !== undefined) return existing;
      const wrapped: AutofillFrame = {
        key: frame.frameTreeNodeId,
        isMainFrame: frame.parent === null,
        origin: () => (frame.isDestroyed() ? "null" : frame.origin),
        isAlive: () => !frame.isDestroyed() && !frame.detached,
        // Only ever this one frame: credentials never go to its parent or children.
        send: (channel, payload) => {
          if (!frame.isDestroyed() && !frame.detached) frame.send(channel, payload);
        },
      };
      frames.set(frame, wrapped);
      return wrapped;
    };
    const withinBudget = (frameKey: number, channel: string) => {
      const key = `${frameKey}:${channel}`;
      const now = Date.now();
      const budget = budgets.get(key);
      if (budget === undefined || now - budget.windowStart >= 1_000) {
        budgets.set(key, { windowStart: now, count: 1 });
        return true;
      }
      budget.count += 1;
      return budget.count <= GUEST_MESSAGES_PER_SECOND;
    };
    const on = <A>(
      channel: string,
      decode: (raw: unknown) => Option.Option<A>,
      handle: (frame: AutofillFrame, message: A) => void,
    ) => {
      const listener = (event: Electron.IpcMainEvent, raw: unknown) => {
        const sender = event.senderFrame;
        if (sender === null || sender.isDestroyed()) return;
        if (!withinBudget(sender.frameTreeNodeId, channel)) return;
        const message = decode(raw);
        if (Option.isNone(message)) return;
        handle(frameFor(sender), message.value);
      };
      wc.ipc.on(channel, listener);
      return () => wc.ipc.off(channel, listener);
    };
    const offs = [
      on(PASSWORD_FORMS_CHANNEL, decoders.forms, (frame, report) => {
        // A submit always follows its page's forms report, so it sees fresh settings.
        settings.refresh();
        autofill.formsReported(frame, report);
      }),
      on(PASSWORD_FIELD_FOCUS_CHANNEL, decoders.focus, (frame, focus) =>
        autofill.fieldFocused(frame, focus),
      ),
      on(
        PASSWORD_FIELD_BLUR_CHANNEL,
        (raw) => Option.some(raw),
        (frame) => autofill.fieldBlurred(frame),
      ),
      on(PASSWORD_FIELD_KEY_CHANNEL, decoders.key, (frame, key) => autofill.fieldKey(frame, key)),
      on(PASSWORD_SUBMIT_CHANNEL, decoders.submit, (frame, submit) =>
        autofill.submitted(frame, submit),
      ),
      on(PASSWORD_FRAME_TOKEN_CHANNEL, decoders.frameToken, (frame, message) =>
        autofill.frameTokenReported(frame, message),
      ),
      on(PASSWORD_CHILD_FRAME_CHANNEL, decoders.childFrame, (frame, message) =>
        autofill.childFrameReported(frame, message),
      ),
    ];
    const didNavigate = (_event: unknown, url: string) => autofill.topLevelCommitted(url);
    const didFrameNavigate = (
      _event: unknown,
      _url: string,
      _code: number,
      _status: string,
      isMainFrame: boolean,
      frameProcessId: number,
      frameRoutingId: number,
    ) => {
      if (isMainFrame) return;
      const frame = Electron.webFrameMain.fromId(frameProcessId, frameRoutingId);
      if (frame) autofill.frameNavigated(frame.frameTreeNodeId);
    };
    wc.on("did-navigate", didNavigate);
    wc.on("did-frame-navigate", didFrameNavigate);
    return () => {
      for (const off of offs) off();
      if (!wc.isDestroyed()) {
        wc.off("did-navigate", didNavigate);
        wc.off("did-frame-navigate", didFrameNavigate);
      }
      autofill.dispose();
      if (sessions.get(tabId) === autofill) sessions.delete(tabId);
    };
  };

  return PasswordAutofill.of({
    attachGuest,
    choose: (tabId, requestId, loginId) =>
      Effect.promise(() => sessions.get(tabId)?.choose(requestId, loginId) ?? Promise.resolve()),
    dismissFillList: (tabId) => Effect.sync(() => sessions.get(tabId)?.dismissFillList()),
    respondToPrompt: (input) =>
      Effect.sync(() =>
        sessions.get(input.tabId)?.respondToPrompt(input.promptId, input.action, input.username),
      ),
    peek: (tabId, promptId) => Effect.sync(() => sessions.get(tabId)?.peek(promptId) ?? null),
    reopenPrompt: (tabId) => Effect.sync(() => sessions.get(tabId)?.reopenPrompt()),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    lock,
  });
});

export const layer = Layer.effect(PasswordAutofill, make);
