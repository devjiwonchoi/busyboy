import type {
  ProjectTaskReference,
  ProjectTeamAttentionSummary,
  ThreadId,
} from "@t3tools/contracts";

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

/**
 * The project's tasks by number when this thread is the PM or one of its task leads, so "#N"
 * in that thread can show the task's name. Null for every other thread.
 */
export function taskReferencesForThread(
  summary: Pick<ProjectTeamAttentionSummary, "pmThreadId" | "tasks"> | null,
  threadId: ThreadId | null,
): ReadonlyMap<number, ProjectTaskReference> | null {
  if (summary === null || threadId === null || summary.tasks.length === 0) return null;
  const speaksInTasks =
    summary.pmThreadId === threadId || summary.tasks.some((task) => task.leadThreadId === threadId);
  if (!speaksInTasks) return null;
  // The same summary gives the same map, so markdown that depends on it doesn't re-render.
  let tasks = taskMapBySummary.get(summary.tasks);
  if (tasks === undefined) {
    tasks = new Map(summary.tasks.map((task) => [task.number, task]));
    taskMapBySummary.set(summary.tasks, tasks);
  }
  return tasks;
}

const taskMapBySummary = new WeakMap<
  ProjectTeamAttentionSummary["tasks"],
  ReadonlyMap<number, ProjectTaskReference>
>();

export interface LeadThreadTask {
  readonly task: ProjectTaskReference;
  /** The task has an open decision card: the lead is waiting on the user. */
  readonly waitingOnUser: boolean;
}

/** The task this thread leads, or null when it leads none. */
export function taskForLeadThread(
  summary: Pick<ProjectTeamAttentionSummary, "tasks" | "decisionCards"> | null,
  threadId: ThreadId,
): LeadThreadTask | null {
  const task = summary?.tasks.find((candidate) => candidate.leadThreadId === threadId);
  if (summary == null || task === undefined) return null;
  const waitingOnUser = summary.decisionCards.some(
    (card) =>
      card.taskNumber === task.number &&
      card.item.answeredAt === null &&
      card.item.supersededAt === null,
  );
  return { task, waitingOnUser };
}
