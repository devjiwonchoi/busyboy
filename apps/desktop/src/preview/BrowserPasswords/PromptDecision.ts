import type { BrowserLoginSummary } from "@t3tools/contracts";

import type { LoginFormKind } from "./PasswordGuestMessages.ts";

export interface SubmittedLogin {
  readonly kind: LoginFormKind;
  readonly username: string;
  /** The current password on sign-in and change forms. */
  readonly password: string;
  readonly newPassword?: string | undefined;
}

export type PromptDecision =
  | { readonly kind: "none"; readonly why: "neverSave" | "noPassword" }
  | {
      readonly kind: "save";
      readonly username: string;
      readonly password: string;
    }
  | {
      readonly kind: "update";
      readonly loginId: number;
      readonly username: string;
      readonly password: string;
    }
  /** Identical login already saved: just count the use. */
  | { readonly kind: "silent"; readonly loginId: number };

/**
 * What to offer after a successful submission (spec 5.2 "Prompt when").
 * `stored` are the realm's saved logins; `passwordMatches` decrypts one row.
 */
export function decidePrompt(input: {
  readonly submitted: SubmittedLogin;
  readonly stored: ReadonlyArray<BrowserLoginSummary>;
  readonly neverSave: boolean;
  readonly passwordMatches: (loginId: number, password: string) => boolean;
}): PromptDecision {
  const { submitted, stored } = input;
  const nextPassword =
    submitted.kind === "signIn" ? submitted.password : (submitted.newPassword ?? "");
  if (nextPassword.length === 0) return { kind: "none", why: "noPassword" };

  if (submitted.kind === "changePassword") {
    // The account is the one whose stored password was the current one,
    // or the one the form names.
    const byUsername =
      submitted.username.length > 0
        ? stored.find((login) => login.username === submitted.username)
        : undefined;
    const byPassword =
      byUsername ??
      stored.find(
        (login) =>
          submitted.password.length > 0 && input.passwordMatches(login.id, submitted.password),
      );
    if (byPassword !== undefined) {
      return input.passwordMatches(byPassword.id, nextPassword)
        ? { kind: "silent", loginId: byPassword.id }
        : {
            kind: "update",
            loginId: byPassword.id,
            username: byPassword.username,
            password: nextPassword,
          };
    }
  }

  const existing = stored.find((login) => login.username === submitted.username);
  if (existing !== undefined) {
    return input.passwordMatches(existing.id, nextPassword)
      ? { kind: "silent", loginId: existing.id }
      : {
          kind: "update",
          loginId: existing.id,
          username: existing.username,
          password: nextPassword,
        };
  }
  if (input.neverSave) return { kind: "none", why: "neverSave" };
  return { kind: "save", username: submitted.username, password: nextPassword };
}
