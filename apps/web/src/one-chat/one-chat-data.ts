import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, NodeGraph, ScopedThreadRef } from "@t3tools/contracts";
import {
  type ActionCard,
  buildActionCards,
  buildWorkItems,
  type OneChatProject,
  taskWorktreePaths,
  type WorkCounts,
  type WorkItem,
  workCounts,
} from "@t3tools/shared/one-chat";
import * as DateTime from "effect/DateTime";

import { useEnvironmentIds } from "~/state/environments";
import { useProjects, useThreadProjection, useThreadShells } from "~/state/entities";
import { useProjectManagerEntries } from "~/state/projectTeam";
import { useNodeGraph } from "./node-graph";

export interface FeedMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming: boolean;
  /** Epoch millis, to interleave with cards. */
  readonly at: number;
}

const ACTIVE_RUN = new Set(["preparing", "queued", "starting", "running"]);

/** Epoch millis from an ISO string or an Effect DateTime. */
export function toMillis(value: unknown): number {
  if (typeof value === "string") return Date.parse(value) || 0;
  if (DateTime.isDateTime(value)) return DateTime.toEpochMillis(value);
  return 0;
}

interface ProjectionLike {
  readonly thread?: {
    readonly projectId?: string;
    readonly modelSelection?: unknown;
    readonly runtimeMode?: string;
    readonly interactionMode?: string;
  };
  readonly messages?: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly streaming: boolean;
    readonly createdAt: unknown;
  }>;
  readonly runs?: ReadonlyArray<{ readonly status: string }>;
}

/** A thread's user and assistant messages and whether a turn is running. */
export function useThreadView(ref: ScopedThreadRef | null) {
  const projection = useThreadProjection(ref)?.projection as ProjectionLike | undefined;
  const messages: FeedMessage[] = [];
  for (const message of projection?.messages ?? []) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    messages.push({
      id: message.id,
      role: message.role,
      text: message.text,
      streaming: message.streaming,
      at: toMillis(message.createdAt),
    });
  }
  const running =
    (projection?.runs ?? []).some((run) => ACTIVE_RUN.has(run.status)) ||
    messages.some((message) => message.streaming);
  return { messages, running, thread: projection?.thread ?? null };
}

export interface OneChatData {
  readonly environmentId: EnvironmentId | null;
  readonly directorRef: ScopedThreadRef | null;
  readonly directorProjectId: string | null;
  readonly projects: ReadonlyArray<OneChatProject>;
  readonly graph: NodeGraph | null;
  /** Live task worktrees, so their skill records are not counted twice. */
  readonly taskWorktrees: ReadonlyArray<string>;
  readonly workItems: ReadonlyArray<WorkItem>;
  readonly counts: WorkCounts;
  readonly cards: ReadonlyArray<ActionCard>;
}

/**
 * The Director thread and every project's work in the Director's environment, read from the
 * existing state. Cards are answered on the Director's server, so other environments stay out.
 */
export function useOneChatData(): OneChatData {
  const entries = useProjectManagerEntries(useEnvironmentIds());
  const knownProjects = useProjects();
  const threads = useThreadShells();
  const director = entries.find((entry) => entry.summary.kind === "director") ?? null;
  const environmentId = director?.environmentId ?? null;
  const sameEnvironment = entries.filter((entry) => entry.environmentId === environmentId);
  const projects: OneChatProject[] = sameEnvironment.map((entry) => {
    const project = knownProjects.find(
      (candidate) =>
        candidate.environmentId === entry.environmentId &&
        candidate.id === entry.summary.projectId,
    );
    return {
      projectId: entry.summary.projectId,
      name: project?.title ?? entry.summary.projectId,
      summary: entry.summary,
    };
  });
  const graph = useNodeGraph(environmentId);
  const taskWorktrees = taskWorktreePaths(
    projects,
    threads.filter((thread) => thread.environmentId === environmentId),
  );
  const workItems = buildWorkItems(projects, graph, taskWorktrees);
  return {
    environmentId,
    directorRef:
      director === null ? null : scopeThreadRef(director.environmentId, director.summary.pmThreadId),
    directorProjectId: director?.summary.projectId ?? null,
    projects,
    graph,
    taskWorktrees,
    workItems,
    counts: workCounts(workItems),
    cards: buildActionCards(projects),
  };
}
