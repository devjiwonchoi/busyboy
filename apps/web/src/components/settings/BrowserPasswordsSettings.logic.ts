import type { BrowserPasswordsUnavailableReason } from "@t3tools/contracts";

import { formatRelativeTimeLabel } from "~/timestampFormat";

const UNAVAILABLE_MESSAGES: Readonly<Record<BrowserPasswordsUnavailableReason, string>> = {
  encryptionUnavailable:
    "Passwords can't be saved because this computer's secure storage isn't available. Nothing is ever stored unencrypted instead.",
  databaseUnavailable: "Saved passwords for this profile couldn't be opened.",
  incognito: "Private profiles never save passwords.",
};

export function passwordsUnavailableMessage(
  reason: BrowserPasswordsUnavailableReason | undefined,
): string {
  return UNAVAILABLE_MESSAGES[reason ?? "databaseUnavailable"];
}

/** The host (and port) shown for a saved login's origin. */
export function loginSite(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

export function formatLastUsed(lastUsedAt: number | null, nowMs: number = Date.now()): string {
  if (lastUsedAt === null) return "Never";
  return formatRelativeTimeLabel(new Date(lastUsedAt).toISOString(), nowMs);
}
