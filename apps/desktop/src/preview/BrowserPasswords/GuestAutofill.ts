// @effect-diagnostics globalTimers:off - Plain timers; tests inject their own.
import type {
  BrowserPasswordAutofillEvent,
  BrowserPasswordFillRow,
  BrowserSignInOutcome,
} from "@t3tools/contracts";

import { siteLabel } from "./LoginOrigin.ts";
import type { PasswordDatabase } from "./PasswordDatabase.ts";
import type {
  GuestChildFrame,
  GuestFieldFocus,
  GuestFieldKey,
  GuestFormsReport,
  GuestFrameToken,
  GuestLoginForm,
  GuestRect,
  GuestSubmit,
  PasswordFillCommand,
} from "./PasswordGuestMessages.ts";
import { decidePrompt } from "./PromptDecision.ts";
import { SubmissionTracker, type PendingSubmission } from "./SubmissionTracker.ts";

/** A submission this soon after an agent drove the page is the agent's, not the person's. */
export const AGENT_SUBMIT_WINDOW_MS = 10_000;
/** Focus this soon after agent input came from the agent; the fill list stays closed. */
export const AGENT_FOCUS_WINDOW_MS = 1_500;
/** A save prompt and its typed password are dropped after this long. */
export const SAVE_PROMPT_LIFETIME_MS = 5 * 60 * 1000;
/** After this many more navigations the prompt folds into the key icon. */
export const SAVE_PROMPT_COLLAPSE_AFTER_NAVIGATIONS = 2;
/** Clicking BusyBoy's list blurs the page field first, so closing waits a moment. */
export const FILL_LIST_BLUR_GRACE_MS = 250;

/** One frame of the guest, as main sees it: its committed origin is trusted, nothing else is. */
export interface AutofillFrame {
  readonly key: number;
  readonly isMainFrame: boolean;
  /** `WebFrameMain.origin` read at the moment of use. */
  readonly origin: () => string;
  readonly isAlive: () => boolean;
  readonly send: (channel: string, payload: unknown) => void;
}

export interface AutofillChannels {
  readonly fill: string;
  readonly dropdownState: string;
  readonly submitForm: string;
}

/** How long after asking the form to submit we wait to see the submission. */
export const SIGN_IN_SUBMIT_SEEN_MS = 1_500;

export type SignInChoice =
  | { readonly kind: "saved"; readonly loginId: number }
  | {
      readonly kind: "entered";
      readonly username: string;
      readonly password: string;
      readonly save: boolean;
    };

export type SignInOutcome = BrowserSignInOutcome;

export interface GuestAutofillPort {
  readonly tabId: string;
  readonly channels: AutofillChannels;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly randomId: () => string;
  readonly topLevelUrl: () => string;
  /** True when an agent sent page input to this guest within the window. */
  readonly agentActiveWithin: (ms: number) => boolean;
  readonly vault: () => PasswordDatabase | null;
  readonly settings: () => { readonly offerToSave: boolean };
  /** Runs the device check unless the profile is inside its unlock window. */
  readonly authorizeFill: (site: string) => Promise<boolean>;
  readonly emit: (event: BrowserPasswordAutofillEvent) => void;
  readonly notifyChanged: () => void;
  /** Multi-step logins: last username typed on an origin, kept in main memory only. */
  readonly rememberUsername: (origin: string, username: string) => void;
  readonly recallUsername: (origin: string) => string | null;
}

interface FrameState {
  readonly frame: AutofillFrame;
  forms: ReadonlyArray<GuestLoginForm>;
  token: string | null;
}

interface FillList {
  readonly requestId: string;
  readonly frame: AutofillFrame;
  readonly frameOrigin: string;
  readonly topLevelOrigin: string | null;
  readonly formToken: string;
  readonly rows: ReadonlyArray<BrowserPasswordFillRow>;
  readonly rect: GuestRect;
  selectedIndex: number;
}

interface SavePrompt {
  readonly promptId: string;
  readonly mode: "save" | "update";
  readonly loginId: number | null;
  readonly origin: string;
  readonly frameOrigin: string | null;
  readonly topLevelOrigin: string | null;
  username: string;
  password: string;
  navigationsSinceShown: number;
  collapsed: boolean;
  readonly expiry: unknown;
}

const originOf = (url: string): string | null => {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
};

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
};

const frameOnOriginNow = (frames: Map<number, FrameState>, origin: string) =>
  [...frames.values()].some((state) => state.frame.isAlive() && state.frame.origin() === origin);

/**
 * Logins only belong to real web origins. Opaque origins (sandboxed frames,
 * `data:`, `blob:`, `about:`) never save or fill.
 */
export function isEligibleOrigin(origin: string): boolean {
  if (origin === "null" || origin.length === 0) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Saving and filling for one browser tab (spec §5). Every input from the
 * guest is treated as untrusted: origins come from main's view of the frame,
 * and credentials only ever travel main → that one frame.
 */
export class GuestAutofill {
  private readonly port: GuestAutofillPort;
  private readonly frames = new Map<number, FrameState>();
  private readonly childRects = new Map<string, { parentKey: number; rect: GuestRect }>();
  private readonly tracker: SubmissionTracker;
  private fillList: FillList | null = null;
  private blurTimer: unknown = null;
  private prompt: SavePrompt | null = null;
  private lastFocus: { frame: AutofillFrame; focus: GuestFieldFocus } | null = null;
  /** An agent sign-in the person approved, waiting for its submission and result. */
  private signInPending: {
    readonly frameKey: number;
    readonly formToken: string;
    submitSeen: boolean;
    readonly onSuccess: () => void;
  } | null = null;
  private disposed = false;

  constructor(port: GuestAutofillPort) {
    this.port = port;
    this.tracker = new SubmissionTracker({
      setTimeout: port.setTimeout,
      clearTimeout: port.clearTimeout,
      onSuccess: (submission) => this.submissionSucceeded(submission),
    });
  }

  // ── guest messages ────────────────────────────────────────────────────

  formsReported(frame: AutofillFrame, report: GuestFormsReport): void {
    if (this.disposed) return;
    const state = this.frameState(frame);
    state.forms = report.forms;
    const origin = frame.origin();
    if (report.typedUsername && isEligibleOrigin(origin)) {
      this.port.rememberUsername(origin, report.typedUsername);
    }
    this.tracker.formsReported(frame.key, report.forms);
    if (
      this.fillList?.frame.key === frame.key &&
      !report.forms.some((form) => form.token === this.fillList?.formToken)
    ) {
      this.closeFillList();
    }
  }

  frameTokenReported(frame: AutofillFrame, message: GuestFrameToken): void {
    this.frameState(frame).token = message.token;
  }

  childFrameReported(frame: AutofillFrame, message: GuestChildFrame): void {
    this.childRects.set(message.childToken, { parentKey: frame.key, rect: message.rect });
    if (this.childRects.size > 64) {
      const oldest = this.childRects.keys().next().value;
      if (oldest !== undefined) this.childRects.delete(oldest);
    }
  }

  fieldFocused(frame: AutofillFrame, focus: GuestFieldFocus): void {
    if (this.disposed) return;
    this.cancelBlurClose();
    // Agent focus and clicks never open the list (spec 5.7).
    if (this.port.agentActiveWithin(AGENT_FOCUS_WINDOW_MS)) return;
    this.lastFocus = { frame, focus };
    this.openFillList(frame, focus);
  }

  fieldBlurred(frame: AutofillFrame): void {
    if (this.fillList?.frame.key !== frame.key) return;
    this.cancelBlurClose();
    this.blurTimer = this.port.setTimeout(() => {
      this.blurTimer = null;
      this.closeFillList();
    }, FILL_LIST_BLUR_GRACE_MS);
  }

  fieldKey(frame: AutofillFrame, message: GuestFieldKey): void {
    const list = this.fillList;
    if (list === null || list.frame.key !== frame.key) {
      if (message.key === "ArrowDown" && this.lastFocus?.frame.key === frame.key) {
        if (this.port.agentActiveWithin(AGENT_FOCUS_WINDOW_MS)) return;
        this.openFillList(frame, this.lastFocus.focus);
      }
      return;
    }
    switch (message.key) {
      case "ArrowDown":
        list.selectedIndex = Math.min(list.selectedIndex + 1, list.rows.length - 1);
        this.emitFillList();
        return;
      case "ArrowUp":
        list.selectedIndex = Math.max(list.selectedIndex - 1, -1);
        this.emitFillList();
        return;
      case "Enter": {
        const row = list.rows[list.selectedIndex];
        if (row !== undefined) void this.choose(list.requestId, row.loginId);
        return;
      }
      case "Escape":
      case "Tab":
        this.closeFillList();
        return;
    }
  }

  submitted(frame: AutofillFrame, submit: GuestSubmit): void {
    if (this.disposed) return;
    const signIn = this.signInPending;
    if (signIn !== null && signIn.frameKey === frame.key && signIn.formToken === submit.formToken) {
      // The approved sign-in's own submission: track it, never prompt for it.
      signIn.submitSeen = true;
      this.tracker.submit({
        frameKey: frame.key,
        isMainFrame: frame.isMainFrame,
        frameOrigin: frame.origin(),
        formToken: submit.formToken,
        login: { kind: submit.kind, username: "", password: "" },
        topLevelPath: pathOf(this.port.topLevelUrl()),
        submittedAt: this.port.now(),
      });
      return;
    }
    if (!this.port.settings().offerToSave) return;
    // Agent typing never produces a save prompt (spec 5.7).
    if (this.port.agentActiveWithin(AGENT_SUBMIT_WINDOW_MS)) return;
    const frameOrigin = frame.origin();
    if (!isEligibleOrigin(frameOrigin)) return;
    const username =
      submit.username.length > 0 ? submit.username : (this.port.recallUsername(frameOrigin) ?? "");
    this.tracker.submit({
      frameKey: frame.key,
      isMainFrame: frame.isMainFrame,
      frameOrigin,
      formToken: submit.formToken,
      login: {
        kind: submit.kind,
        username,
        password: submit.password,
        newPassword: submit.newPassword,
      },
      topLevelPath: pathOf(this.port.topLevelUrl()),
      submittedAt: this.port.now(),
    });
  }

  // ── navigation ────────────────────────────────────────────────────────

  topLevelCommitted(url: string): void {
    for (const [key, state] of this.frames) {
      if (!state.frame.isMainFrame) this.frames.delete(key);
      else state.forms = [];
    }
    this.childRects.clear();
    this.closeFillList();
    this.tracker.topLevelCommitted(url);
    const prompt = this.prompt;
    if (prompt !== null && !prompt.collapsed) {
      prompt.navigationsSinceShown += 1;
      if (
        originOf(url) !== prompt.topLevelOrigin ||
        prompt.navigationsSinceShown >= SAVE_PROMPT_COLLAPSE_AFTER_NAVIGATIONS
      ) {
        prompt.collapsed = true;
        this.emitPrompt();
      }
    }
  }

  frameNavigated(frameKey: number): void {
    const state = this.frames.get(frameKey);
    if (state !== undefined) state.forms = [];
    if (this.fillList?.frame.key === frameKey) this.closeFillList();
    this.tracker.frameReplaced(frameKey);
  }

  // ── app renderer requests ─────────────────────────────────────────────

  /** The person picked a login in BusyBoy's list. */
  async choose(requestId: string, loginId: number): Promise<void> {
    const list = this.fillList;
    if (list === null || list.requestId !== requestId) return;
    this.cancelBlurClose();
    const row = list.rows.find((candidate) => candidate.loginId === loginId);
    if (row === undefined) return;
    this.closeFillList();
    const vault = this.port.vault();
    const login = vault?.get(loginId) ?? null;
    if (vault === null || login === null) return;
    if (!(await this.port.authorizeFill(siteLabel(login.origin)))) return;
    // Re-check after the prompt: the page may have moved on while it was up.
    if (this.disposed || !list.frame.isAlive()) return;
    if (list.frame.origin() !== login.signonRealm) return;
    if (originOf(this.port.topLevelUrl()) !== list.topLevelOrigin) return;
    const password = vault.revealPassword(loginId);
    if (password === null) return;
    const command: PasswordFillCommand = {
      formToken: list.formToken,
      username: login.username,
      password,
    };
    list.frame.send(this.port.channels.fill, command);
    vault.recordFill(loginId, this.port.now());
    this.port.notifyChanged();
  }

  /**
   * Fills and submits the page's login form for an agent's preview_sign_in,
   * after the person approved it on the card. Returns only an outcome.
   */
  async signIn(origin: string, choice: SignInChoice): Promise<SignInOutcome> {
    if (this.disposed) return "unavailable";
    const vault = this.port.vault();
    if (vault === null) return "unavailable";
    const findForm = () => {
      for (const state of this.frames.values()) {
        if (!state.frame.isAlive() || state.frame.origin() !== origin) continue;
        const form = state.forms.find((candidate) =>
          candidate.fields.some((field) => field.role !== "username"),
        );
        if (form !== undefined) return { frame: state.frame, form };
      }
      return null;
    };
    const frameOnOrigin = [...this.frames.values()].some(
      (state) => state.frame.isAlive() && state.frame.origin() === origin,
    );
    if (!frameOnOrigin) return "page_left_origin";
    if (findForm() === null) return "no_login_form";

    let username: string;
    let password: string;
    let loginId: number | null = null;
    if (choice.kind === "saved") {
      const login = vault.get(choice.loginId);
      if (login === null || login.signonRealm !== origin) return "unavailable";
      if (!(await this.port.authorizeFill(siteLabel(origin)))) return "unavailable";
      const revealed = vault.revealPassword(login.id);
      if (revealed === null) return "unavailable";
      username = login.username;
      password = revealed;
      loginId = login.id;
    } else {
      username = choice.username;
      password = choice.password;
    }
    // The page may have moved on while the device check was up.
    const target = this.disposed ? null : findForm();
    if (target === null)
      return frameOnOriginNow(this.frames, origin) ? "no_login_form" : "page_left_origin";

    const command: PasswordFillCommand = { formToken: target.form.token, username, password };
    target.frame.send(this.port.channels.fill, command);
    if (loginId !== null) vault.recordFill(loginId, this.port.now());

    const outcome = await new Promise<SignInOutcome>((resolve) => {
      const pending = {
        frameKey: target.frame.key,
        formToken: target.form.token,
        submitSeen: false,
        onSuccess: () => {
          this.port.clearTimeout(noSubmit);
          this.port.clearTimeout(noSuccess);
          resolve("submitted");
        },
      };
      this.signInPending = pending;
      const noSubmit = this.port.setTimeout(() => {
        if (!pending.submitSeen) {
          this.port.clearTimeout(noSuccess);
          resolve("filled");
        }
      }, SIGN_IN_SUBMIT_SEEN_MS);
      const noSuccess = this.port.setTimeout(
        () => resolve("submitted_unconfirmed"),
        SIGN_IN_SUBMIT_SEEN_MS + 10_000,
      );
      target.frame.send(this.port.channels.submitForm, { formToken: target.form.token });
    });
    this.signInPending = null;

    if (outcome === "submitted") {
      const at = this.port.now();
      if (loginId !== null) {
        vault.recordUse(loginId, at);
      } else if (choice.kind === "entered" && choice.save) {
        // The person ticked "Save this login" on the card; no second prompt.
        const existing = vault.find(origin, username);
        if (existing !== null) vault.update(existing.id, { password }, at);
        else
          vault.add({ origin, username, password, source: "saved", createdAt: at, lastUsedAt: at });
      }
      this.port.notifyChanged();
    }
    return outcome;
  }

  dismissFillList(): void {
    this.closeFillList();
  }

  respondToPrompt(
    promptId: string,
    action: "save" | "notNow" | "never",
    username: string | undefined,
  ): void {
    const prompt = this.prompt;
    if (prompt === null || prompt.promptId !== promptId) return;
    // Take the typed password before closing, which wipes it from the prompt.
    const password = prompt.password;
    this.closePrompt();
    const vault = this.port.vault();
    if (vault === null || action === "notNow") return;
    const at = this.port.now();
    if (action === "never") {
      vault.addNeverSave(prompt.origin, at);
      this.port.notifyChanged();
      return;
    }
    const finalUsername = username ?? prompt.username;
    const existing =
      prompt.loginId !== null && finalUsername === prompt.username
        ? vault.get(prompt.loginId)
        : vault.find(prompt.origin, finalUsername);
    if (existing !== null) {
      vault.update(existing.id, { password }, at);
      vault.recordUse(existing.id, at);
    } else {
      const id = vault.add({
        origin: prompt.origin,
        username: finalUsername,
        password,
        source: "saved",
        createdAt: at,
        lastUsedAt: at,
      });
      vault.recordUse(id, at);
    }
    this.port.notifyChanged();
  }

  peek(promptId: string): string | null {
    return this.prompt?.promptId === promptId ? this.prompt.password : null;
  }

  reopenPrompt(): void {
    if (this.prompt === null) return;
    this.prompt.collapsed = false;
    this.prompt.navigationsSinceShown = 0;
    this.emitPrompt();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tracker.discard();
    this.cancelBlurClose();
    this.closeFillList();
    this.closePrompt();
    this.frames.clear();
  }

  // ── internals ─────────────────────────────────────────────────────────

  private frameState(frame: AutofillFrame): FrameState {
    const existing = this.frames.get(frame.key);
    if (existing !== undefined && existing.frame === frame) return existing;
    const state: FrameState = {
      frame,
      forms: existing?.forms ?? [],
      token: existing?.token ?? null,
    };
    this.frames.set(frame.key, state);
    return state;
  }

  /** Where a frame's viewport sits inside the webview, when the chain of parents is known. */
  private frameOffset(frameKey: number, depth = 0): { x: number; y: number } | null {
    const state = this.frames.get(frameKey);
    if (state === undefined || depth > 8) return null;
    if (state.frame.isMainFrame) return { x: 0, y: 0 };
    const placement = state.token === null ? undefined : this.childRects.get(state.token);
    if (placement === undefined) return null;
    const parent = this.frameOffset(placement.parentKey, depth + 1);
    return parent === null
      ? null
      : { x: parent.x + placement.rect.x, y: parent.y + placement.rect.y };
  }

  private openFillList(frame: AutofillFrame, focus: GuestFieldFocus): void {
    const frameOrigin = frame.origin();
    if (!isEligibleOrigin(frameOrigin)) return;
    const form = this.frames.get(frame.key)?.forms.find((f) => f.token === focus.formToken);
    if (form === undefined || !form.fields.some((field) => field.token === focus.fieldToken)) {
      return;
    }
    const vault = this.port.vault();
    if (vault === null) return;
    // Exact realm only: the frame's own origin, no subdomain or suffix matching.
    // That also keeps a password saved for https:// off an http:// page.
    const logins = vault.forRealm(frameOrigin);
    if (logins.length === 0) return;
    const offset = this.frameOffset(frame.key) ?? { x: 0, y: 0 };
    const topLevelOrigin = originOf(this.port.topLevelUrl());
    this.fillList = {
      requestId: this.port.randomId(),
      frame,
      frameOrigin,
      topLevelOrigin,
      formToken: focus.formToken,
      rows: logins.map((login) => ({ loginId: login.id, username: login.username })),
      rect: {
        x: offset.x + focus.rect.x,
        y: offset.y + focus.rect.y,
        width: focus.rect.width,
        height: focus.rect.height,
      },
      selectedIndex: -1,
    };
    frame.send(this.port.channels.dropdownState, { open: true });
    this.emitFillList();
  }

  private emitFillList(): void {
    const list = this.fillList;
    if (list === null) return;
    this.port.emit({
      type: "fillList",
      tabId: this.port.tabId,
      requestId: list.requestId,
      rect: list.rect,
      rows: list.rows,
      frameOrigin: list.frameOrigin === list.topLevelOrigin ? null : list.frameOrigin,
      selectedIndex: list.selectedIndex,
    });
  }

  private closeFillList(): void {
    const list = this.fillList;
    if (list === null) return;
    this.fillList = null;
    if (list.frame.isAlive()) list.frame.send(this.port.channels.dropdownState, { open: false });
    this.port.emit({ type: "fillListClosed", tabId: this.port.tabId });
  }

  private cancelBlurClose(): void {
    if (this.blurTimer !== null) this.port.clearTimeout(this.blurTimer);
    this.blurTimer = null;
  }

  private submissionSucceeded(submission: PendingSubmission): void {
    if (this.disposed) return;
    const signIn = this.signInPending;
    if (signIn !== null && signIn.frameKey === submission.frameKey) {
      signIn.onSuccess();
      return;
    }
    const vault = this.port.vault();
    if (vault === null) return;
    const decision = decidePrompt({
      submitted: submission.login,
      stored: vault.forRealm(submission.frameOrigin),
      neverSave: vault.isNeverSave(submission.frameOrigin),
      passwordMatches: (id, password) => vault.passwordEquals(id, password),
    });
    if (decision.kind === "none") return;
    if (decision.kind === "silent") {
      vault.recordUse(decision.loginId, this.port.now());
      this.port.notifyChanged();
      return;
    }
    this.closePrompt();
    const topLevelOrigin = originOf(this.port.topLevelUrl());
    const promptId = this.port.randomId();
    this.prompt = {
      promptId,
      mode: decision.kind,
      loginId: decision.kind === "update" ? decision.loginId : null,
      origin: submission.frameOrigin,
      frameOrigin: submission.isMainFrame ? null : submission.frameOrigin,
      topLevelOrigin,
      username: decision.username,
      password: decision.password,
      navigationsSinceShown: 0,
      collapsed: false,
      expiry: this.port.setTimeout(() => {
        if (this.prompt?.promptId === promptId) this.closePrompt();
      }, SAVE_PROMPT_LIFETIME_MS),
    };
    this.emitPrompt();
  }

  private emitPrompt(): void {
    const prompt = this.prompt;
    if (prompt === null) return;
    this.port.emit({
      type: "savePrompt",
      tabId: this.port.tabId,
      promptId: prompt.promptId,
      mode: prompt.mode,
      origin: prompt.origin,
      frameOrigin: prompt.frameOrigin,
      username: prompt.username,
      collapsed: prompt.collapsed,
    });
  }

  private closePrompt(): void {
    const prompt = this.prompt;
    if (prompt === null) return;
    this.prompt = null;
    this.port.clearTimeout(prompt.expiry);
    // Drop the typed password as soon as the prompt is gone.
    prompt.password = "";
    this.port.emit({ type: "savePromptClosed", tabId: this.port.tabId });
  }
}
