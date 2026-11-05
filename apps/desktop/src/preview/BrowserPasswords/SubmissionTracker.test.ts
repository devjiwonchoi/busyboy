import { describe, expect, it } from "@effect/vitest";

import type { GuestLoginForm } from "./PasswordGuestMessages.ts";
import {
  SUBMISSION_SUCCESS_WINDOW_MS,
  SubmissionTracker,
  type PendingSubmission,
} from "./SubmissionTracker.ts";

function harness() {
  const timers = new Map<number, () => void>();
  let next = 0;
  const successes: PendingSubmission[] = [];
  const tracker = new SubmissionTracker({
    setTimeout: (callback, ms) => {
      expect(ms).toBe(SUBMISSION_SUCCESS_WINDOW_MS);
      next += 1;
      timers.set(next, callback);
      return next;
    },
    clearTimeout: (handle) => timers.delete(handle as number),
    onSuccess: (submission) => successes.push(submission),
  });
  const submit = (overrides: Partial<PendingSubmission> = {}) =>
    tracker.submit({
      frameKey: 1,
      isMainFrame: true,
      frameOrigin: "http://127.0.0.1:4000",
      formToken: "form-a",
      login: { kind: "signIn", username: "alice", password: "correct-horse" },
      topLevelPath: "/login",
      submittedAt: 0,
      ...overrides,
    });
  return { tracker, successes, submit, fireTimers: () => [...timers.values()].forEach((t) => t()) };
}

const form = (token: string, passwordFilled: boolean): GuestLoginForm => ({
  token,
  kind: "signIn",
  passwordFilled,
  fields: [
    { token: `${token}-u`, role: "username", rect: { x: 0, y: 0, width: 10, height: 10 } },
    { token: `${token}-p`, role: "currentPassword", rect: { x: 0, y: 20, width: 10, height: 10 } },
  ],
});

describe("SubmissionTracker", () => {
  it("succeeds when the page commits to a different path", () => {
    const h = harness();
    h.submit();
    h.tracker.topLevelCommitted("http://127.0.0.1:4000/welcome");
    expect(h.successes).toHaveLength(1);
    expect(h.tracker.current).toBeNull();
  });

  it("fails when the same page comes back asking for a password", () => {
    const h = harness();
    h.submit();
    h.tracker.topLevelCommitted("http://127.0.0.1:4000/login?error=1");
    h.tracker.formsReported(1, [form("form-b", false)]);
    expect(h.successes).toEqual([]);
    expect(h.tracker.current).toBeNull();
  });

  it("succeeds when the form disappears in place (pushState apps)", () => {
    const h = harness();
    h.submit({ topLevelPath: "/login-formless" });
    h.tracker.formsReported(1, [form("form-a", true)]);
    expect(h.successes).toEqual([]);
    h.tracker.formsReported(1, []);
    expect(h.successes).toHaveLength(1);
  });

  it("fails when the form re-renders with the password emptied", () => {
    const h = harness();
    h.submit();
    h.tracker.formsReported(1, [form("form-a", false)]);
    expect(h.tracker.current).toBeNull();
    expect(h.successes).toEqual([]);
  });

  it("gives up after 10 seconds without a signal", () => {
    const h = harness();
    h.submit();
    h.fireTimers();
    h.tracker.topLevelCommitted("http://127.0.0.1:4000/welcome");
    expect(h.successes).toEqual([]);
  });

  it("tracks an iframe login by its own frame", () => {
    const h = harness();
    h.submit({ frameKey: 7, isMainFrame: false, topLevelPath: "/iframe-host" });
    h.tracker.formsReported(1, []);
    h.tracker.topLevelCommitted("http://127.0.0.1:4000/iframe-host");
    expect(h.successes).toEqual([]);
    h.tracker.frameReplaced(7);
    h.tracker.formsReported(7, []);
    expect(h.successes.map((success) => success.frameKey)).toEqual([7]);
  });
});
