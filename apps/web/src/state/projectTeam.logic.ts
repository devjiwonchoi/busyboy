import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";

import { formatRelativeElapsed, formatRelativeTimeLabel } from "../timestampFormat";

export type ProjectManagerStatus = "working" | "needs-you" | "idle";

export const PROJECT_MANAGER_STATUS_LABEL: Record<ProjectManagerStatus, string> = {
  working: "working",
  "needs-you": "needs you",
  idle: "idle",
};

type PresenceInput = Pick<ProjectTeamAttentionSummary, "openCount" | "presence">;

function needsYouCount(summary: PresenceInput): number {
  return summary.presence.waitingOnUser > 0 ? summary.presence.waitingOnUser : summary.openCount;
}

/** Needs-you wins over working: it is the state that asks something of the user. */
export function resolveProjectManagerStatus(input: {
  readonly summary: PresenceInput;
  readonly pmThreadWorking: boolean;
}): ProjectManagerStatus {
  if (needsYouCount(input.summary) > 0) return "needs-you";
  if (input.pmThreadWorking || input.summary.presence.running > 0) return "working";
  return "idle";
}

function formatUntil(isoDate: string, nowMs: number): string {
  const remainingMs = Date.parse(isoDate) - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "soon";
  const relative = formatRelativeElapsed(remainingMs);
  return relative.suffix === null ? "soon" : `in ${relative.value}`;
}

/** One line such as "2 working · 1 needs you · last: nudged #5 · 2m ago". */
export function formatProjectManagerPresence(summary: PresenceInput, nowMs: number): string {
  const { presence } = summary;
  const counts = [
    presence.running > 0 ? `${presence.running} working` : null,
    needsYouCount(summary) > 0 ? `${needsYouCount(summary)} needs you` : null,
    presence.stalled > 0 ? `${presence.stalled} stalled` : null,
    presence.inbox > 0 ? `${presence.inbox} in inbox` : null,
  ].filter((part) => part !== null);
  const parts = counts.length > 0 ? counts : ["Idle"];
  if (presence.lastAction !== null) {
    parts.push(
      `last: ${presence.lastAction.text}`,
      formatRelativeTimeLabel(presence.lastAction.at, nowMs),
    );
  } else if (presence.nextSitrepAt !== null) {
    parts.push(`next sitrep ${formatUntil(presence.nextSitrepAt, nowMs)}`);
  }
  return parts.filter((part) => part !== "").join(" · ");
}
