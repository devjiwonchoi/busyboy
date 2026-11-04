import type { BrowserLoginSummary } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { decidePrompt, type SubmittedLogin } from "./PromptDecision.ts";

const login = (id: number, username: string): BrowserLoginSummary => ({
  id,
  origin: "http://127.0.0.1:4000",
  signonRealm: "http://127.0.0.1:4000",
  username,
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  lastFilledAt: null,
  timesUsed: 0,
  source: "saved",
  hasNote: false,
});

const passwords = new Map([
  [1, "correct-horse"],
  [2, "bob-pass"],
]);
const decide = (submitted: SubmittedLogin, stored: BrowserLoginSummary[], neverSave = false) =>
  decidePrompt({
    submitted,
    stored,
    neverSave,
    passwordMatches: (id, password) => passwords.get(id) === password,
  });

const signIn = (username: string, password: string): SubmittedLogin => ({
  kind: "signIn",
  username,
  password,
});

describe("decidePrompt", () => {
  it("offers to save a new login", () => {
    expect(decide(signIn("alice", "correct-horse"), [])).toEqual({
      kind: "save",
      username: "alice",
      password: "correct-horse",
    });
  });

  it("offers to update when the password changed, and stays silent when it didn't", () => {
    const stored = [login(1, "alice")];
    expect(decide(signIn("alice", "new-horse"), stored)).toEqual({
      kind: "update",
      loginId: 1,
      username: "alice",
      password: "new-horse",
    });
    expect(decide(signIn("alice", "correct-horse"), stored)).toEqual({
      kind: "silent",
      loginId: 1,
    });
  });

  it("does not offer to save on a never-save site, but still updates a saved login", () => {
    expect(decide(signIn("alice", "x"), [], true)).toEqual({ kind: "none", why: "neverSave" });
    expect(decide(signIn("alice", "x"), [login(1, "alice")], true).kind).toBe("update");
  });

  it("offers the new password on sign-up forms", () => {
    expect(
      decide({ kind: "signUp", username: "carol", password: "", newPassword: "fresh" }, []),
    ).toEqual({ kind: "save", username: "carol", password: "fresh" });
    expect(decide({ kind: "signUp", username: "carol", password: "" }, [])).toEqual({
      kind: "none",
      why: "noPassword",
    });
  });

  it("updates the account whose current password was entered on change-password forms", () => {
    const stored = [login(1, "alice"), login(2, "bob")];
    expect(
      decide(
        { kind: "changePassword", username: "", password: "bob-pass", newPassword: "bob-2" },
        stored,
      ),
    ).toEqual({ kind: "update", loginId: 2, username: "bob", password: "bob-2" });
  });
});
