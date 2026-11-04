// @effect-diagnostics globalTimers:off - Plain timers; tests inject their own.
import type { GuestLoginForm } from "./PasswordGuestMessages.ts";
import type { SubmittedLogin } from "./PromptDecision.ts";

/** How long after a submission a success signal still counts. */
export const SUBMISSION_SUCCESS_WINDOW_MS = 10_000;

export interface PendingSubmission {
  /** The frame's tree node id; stable across that frame's navigations. */
  readonly frameKey: number;
  readonly isMainFrame: boolean;
  /** The committed origin of the frame the form lives in, as main saw it. */
  readonly frameOrigin: string;
  readonly formToken: string;
  readonly login: SubmittedLogin;
  /** Path of the top-level page when the form was submitted. */
  readonly topLevelPath: string;
  readonly submittedAt: number;
}

export interface SubmissionTrackerPort {
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly onSuccess: (submission: PendingSubmission) => void;
}

const pathOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return null;
  }
};

/**
 * Decides whether the last login submission in one guest worked (spec 5.2).
 * Success: the top-level page commits to a different path, or the form (or
 * all its password fields) goes away, within 10 s. Failure: the same form is
 * reported again with its password emptied, or nothing happens in time.
 * Only the latest submission is tracked.
 */
export class SubmissionTracker {
  private readonly port: SubmissionTrackerPort;
  private pending: PendingSubmission | null = null;
  /** The form's frame loaded a new document since the submission. */
  private documentReplaced = false;
  private timer: unknown = null;

  constructor(port: SubmissionTrackerPort) {
    this.port = port;
  }

  get current(): PendingSubmission | null {
    return this.pending;
  }

  submit(submission: PendingSubmission): void {
    this.discard();
    this.pending = submission;
    this.timer = this.port.setTimeout(() => this.discard(), SUBMISSION_SUCCESS_WINDOW_MS);
  }

  discard(): void {
    if (this.timer !== null) this.port.clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.documentReplaced = false;
  }

  /** A frame's latest set of login forms. */
  formsReported(frameKey: number, forms: ReadonlyArray<GuestLoginForm>): void {
    const pending = this.pending;
    if (pending === null || pending.frameKey !== frameKey) return;
    if (this.documentReplaced) {
      // A fresh document has fresh tokens, so judge by what it shows: another
      // password field means the site sent the person back to sign in.
      const asksAgain = forms.some((candidate) =>
        candidate.fields.some((field) => field.role !== "username"),
      );
      if (asksAgain) this.discard();
      else this.succeed();
      return;
    }
    const form = forms.find((candidate) => candidate.token === pending.formToken);
    const hasPassword = form?.fields.some((field) => field.role !== "username") ?? false;
    if (!form || !hasPassword) {
      this.succeed();
      return;
    }
    // The same form came back with the password cleared: the site rejected it.
    if (!form.passwordFilled) this.discard();
  }

  /** A subframe loaded a new document. */
  frameReplaced(frameKey: number): void {
    if (this.pending?.frameKey === frameKey) this.documentReplaced = true;
  }

  /** A subframe went away entirely, taking its form with it. */
  frameRemoved(frameKey: number): void {
    if (this.pending?.frameKey === frameKey) this.succeed();
  }

  topLevelCommitted(url: string): void {
    const pending = this.pending;
    if (pending === null) return;
    const path = pathOf(url);
    if (path !== null && path !== pending.topLevelPath) {
      this.succeed();
      return;
    }
    if (pending.isMainFrame) this.documentReplaced = true;
  }

  private succeed(): void {
    const pending = this.pending;
    this.discard();
    if (pending !== null) this.port.onSuccess(pending);
  }
}
