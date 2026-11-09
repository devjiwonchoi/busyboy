import {
  formatTaskKey,
  type EnvironmentId,
  type ProjectId,
  type ProjectAttentionKind,
  type ProjectDecisionCard,
  type ProjectTaskReference,
  type ProjectTeamAttentionSummary,
  type ProjectWaitingThread,
  type ThreadId,
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

/** A task name and route from the same server as the message that mentions it. */
export type NamedTaskReference = {
  readonly task: ProjectTaskReference;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly key: string;
};

export type TaskReferenceCatalog = {
  readonly byId: ReadonlyMap<string, NamedTaskReference>;
  readonly byKey: ReadonlyMap<string, ReadonlyArray<NamedTaskReference>>;
  readonly contextualProjectId: ProjectId | null;
};

/** Keep server boundaries and historical aliases when resolving a written task key. */
export function buildTaskReferenceCatalog(input: {
  readonly environmentId: EnvironmentId | null;
  readonly contextualProjectId: ProjectId | null;
  readonly entries: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly summary: Pick<ProjectTeamAttentionSummary, "projectId" | "tasks" | "taskKeyPrefix"> & {
      readonly taskKeyAliases?: ReadonlyArray<string>;
    };
  }>;
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly title: string;
  }>;
}): TaskReferenceCatalog {
  const byId = new Map<string, NamedTaskReference>();
  const byKey = new Map<string, NamedTaskReference[]>();
  for (const { environmentId, summary } of input.entries) {
    if (environmentId !== input.environmentId) {
      continue;
    }
    const projectTitle =
      input.projects.find(
        (project) => project.environmentId === environmentId && project.id === summary.projectId,
      )?.title ?? "프로젝트";
    for (const task of summary.tasks) {
      const reference = {
        task,
        projectId: summary.projectId,
        projectTitle,
        key: formatTaskKey(summary.taskKeyPrefix, task.number),
      };
      byId.set(task.id, reference);
      for (const prefix of new Set([summary.taskKeyPrefix, ...(summary.taskKeyAliases ?? [])])) {
        const key = formatTaskKey(prefix, task.number);
        const candidates = byKey.get(key) ?? [];
        candidates.push(reference);
        byKey.set(key, candidates);
      }
    }
  }
  return { byId, byKey, contextualProjectId: input.contextualProjectId };
}

/** A project-local historical key can be unambiguous even after its prefix changed. */
export function taskReferenceCandidates(catalog: TaskReferenceCatalog, key: string) {
  const candidates = catalog.byKey.get(key) ?? [];
  const contextual = candidates.filter(
    (candidate) => candidate.projectId === catalog.contextualProjectId,
  );
  return contextual.length === 1 ? contextual : candidates;
}

export interface LeadThreadTask {
  readonly task: ProjectTaskReference;
  /** The task's key, such as "BU-82". */
  readonly key: string;
}

/** The task this thread leads, or null when it leads none. */
export function taskForLeadThread(
  summary: Pick<ProjectTeamAttentionSummary, "tasks" | "taskKeyPrefix"> | null,
  threadId: ThreadId,
): LeadThreadTask | null {
  const task = summary?.tasks.find((candidate) => candidate.leadThreadId === threadId);
  return summary == null || task === undefined
    ? null
    : { task, key: formatTaskKey(summary.taskKeyPrefix, task.number) };
}

export const isOpenDecisionCard = (card: ProjectDecisionCard): boolean =>
  card.item.answeredAt === null && card.item.supersededAt === null;

/** Something waiting on the user, as the pending bar above the composer lists it. */
export type PendingActionItem =
  | { readonly kind: "card"; readonly id: string; readonly label: string }
  | { readonly kind: "thread"; readonly threadId: ThreadId; readonly label: string };

const CARD_LABEL: Record<ProjectAttentionKind, string> = {
  approval: "승인 대기",
  decision: "결정 필요",
  blocker: "블로커",
};

const THREAD_LABEL: Record<ProjectWaitingThread["kind"], string> = {
  question: "답 기다림",
  approval: "허용 요청",
  plan: "계획 승인",
};

/** Open cards first, oldest first, then the other threads waiting on the user. */
export function pendingActionItems(input: {
  readonly cards: ReadonlyArray<ProjectDecisionCard>;
  readonly waitingThreads: ReadonlyArray<ProjectWaitingThread>;
}): ReadonlyArray<PendingActionItem> {
  return [
    ...input.cards.filter(isOpenDecisionCard).map((card): PendingActionItem => ({
      kind: "card",
      id: card.item.id,
      label: `${CARD_LABEL[card.item.kind]}: ${card.taskTitle}`,
    })),
    ...input.waitingThreads.map((thread): PendingActionItem => ({
      kind: "thread",
      threadId: thread.threadId,
      label: `${thread.title} · ${THREAD_LABEL[thread.kind]}`,
    })),
  ];
}

/**
 * The question cards a thread shows in its timeline, open or closed, oldest first: every
 * card in the project for its PM thread, and the cards a task lead asked for that lead's
 * own thread.
 */
export function decisionCardsForThread(
  summaries: Iterable<Pick<ProjectTeamAttentionSummary, "pmThreadId" | "decisionCards">>,
  threadId: ThreadId,
): ReadonlyArray<ProjectDecisionCard> {
  const cards: ProjectDecisionCard[] = [];
  for (const summary of summaries) {
    const isPmThread = summary.pmThreadId === threadId;
    for (const card of summary.decisionCards) {
      if (isPmThread || card.item.askerThreadId === threadId) cards.push(card);
    }
  }
  return cards.toSorted((a, b) => Date.parse(a.item.createdAt) - Date.parse(b.item.createdAt));
}

/** The workspace Director lives in a hidden system project, not a user project. */
export const isDirectorSummary = (summary: Pick<ProjectTeamAttentionSummary, "kind">): boolean =>
  summary.kind === "director";

/** Splits the Director off the project managers. The first Director wins. */
export function splitDirectorEntry<
  E extends { readonly summary: Pick<ProjectTeamAttentionSummary, "kind"> },
>(entries: readonly E[]): { readonly director: E | null; readonly projects: readonly E[] } {
  let director: E | null = null;
  const projects: E[] = [];
  for (const entry of entries) {
    if (isDirectorSummary(entry.summary)) director ??= entry;
    else projects.push(entry);
  }
  return { director, projects };
}
