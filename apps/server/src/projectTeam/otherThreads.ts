import type {
  IsoDateTime,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  ProjectId,
  ProjectOtherThread,
  ProjectOtherThreadRequest,
  ProjectOtherThreadStatus,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import { isoFromMillis, isoMillis } from "./common.ts";

const LATEST_MESSAGE_MAX_CHARS = 200;
const REQUEST_TEXT_MAX_CHARS = 300;
const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const trim = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

const iso = (value: DateTime.Utc): IsoDateTime => DateTime.formatIso(value) as IsoDateTime;

type Shell = OrchestrationV2ThreadShell;

function linkedPullRequest(shell: Shell): { readonly url: string; readonly at: number } | null {
  const linkedAt = (link: { readonly linkedAt?: IsoDateTime }) => {
    const at = link.linkedAt === undefined ? Number.NaN : isoMillis(link.linkedAt);
    return Number.isFinite(at) ? at : 0;
  };
  const links = (shell.pullRequests ?? [])
    .filter((link) => link.source !== "stack-dismissed")
    .toSorted((a, b) => linkedAt(b) - linkedAt(a));
  const latest = links[0];
  if (latest !== undefined) return { url: latest.url, at: linkedAt(latest) };
  const fallback = shell.linkedPullRequest ?? shell.branchPullRequest ?? null;
  return fallback === null ? null : { url: fallback.url, at: 0 };
}

/**
 * The finished turn the user has not looked at yet, which the sidebar shows as ready:
 * the agent handed the thread back and waits for the user's reply.
 */
function unseenCompletedAt(shell: Shell): DateTime.Utc | null {
  if (shell.activeRunId !== null || shell.status !== "completed") return null;
  const completedAt = shell.latestRunCompletedAt ?? null;
  const visitedAt = shell.lastVisitedAt ?? null;
  if (completedAt === null || visitedAt === null) return null;
  return DateTime.toEpochMillis(completedAt) > DateTime.toEpochMillis(visitedAt)
    ? completedAt
    : null;
}

function threadStatus(shell: Shell): ProjectOtherThreadStatus {
  if (shell.pendingRuntimeRequest !== null) return "waiting_on_user";
  if (shell.activeRunId !== null || ACTIVE_RUN_STATUSES.has(shell.status)) return "running";
  if (shell.hasActionableProposedPlan || unseenCompletedAt(shell) !== null) {
    return "waiting_on_user";
  }
  if (shell.status === "failed") return "failed";
  return "idle";
}

/** The pending request's own words, read from the thread's turn items. */
function requestText(
  shell: Shell,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): ProjectOtherThreadRequest | null {
  const pending = shell.pendingRuntimeRequest;
  if (pending === null) {
    if (shell.hasActionableProposedPlan && shell.activeRunId === null) {
      return {
        kind: "plan",
        text: "A proposed plan is waiting for approval.",
        since: iso(shell.latestRunCompletedAt ?? shell.updatedAt),
      };
    }
    const completedAt = unseenCompletedAt(shell);
    if (completedAt === null) return null;
    const lastMessage = shell.latestVisibleMessage;
    return {
      kind: "reply",
      text:
        lastMessage !== null && lastMessage.role === "assistant"
          ? trim(lastMessage.text, REQUEST_TEXT_MAX_CHARS)
          : "Its turn ended and it is waiting for a reply.",
      since: iso(completedAt),
    };
  }
  const since = iso(pending.createdAt);
  const item = turnItems.find(
    (candidate) =>
      (candidate.type === "user_input_request" || candidate.type === "approval_request") &&
      candidate.requestId === pending.id,
  );
  if (item?.type === "user_input_request") {
    const text = item.questions.map((question) => question.question).join(" / ");
    return { kind: "question", text: trim(text, REQUEST_TEXT_MAX_CHARS), since };
  }
  if (item?.type === "approval_request") {
    const text = item.prompt ?? `Approve a ${item.requestKind} request.`;
    return { kind: "approval", text: trim(text, REQUEST_TEXT_MAX_CHARS), since };
  }
  return pending.kind === "user_input"
    ? { kind: "question", text: "A question is waiting for an answer.", since }
    : { kind: "approval", text: `Approve a ${pending.kind} request.`, since };
}

function lastUpdateMillis(shell: Shell, pullRequestAt: number): number {
  return Math.max(
    DateTime.toEpochMillis(shell.createdAt),
    shell.latestRunStartedAt == null ? 0 : DateTime.toEpochMillis(shell.latestRunStartedAt),
    shell.latestRunCompletedAt == null ? 0 : DateTime.toEpochMillis(shell.latestRunCompletedAt),
    shell.pendingRuntimeRequest === null
      ? 0
      : DateTime.toEpochMillis(shell.pendingRuntimeRequest.createdAt),
    pullRequestAt,
  );
}

const STATUS_ORDER: Record<ProjectOtherThreadStatus, number> = {
  waiting_on_user: 0,
  failed: 1,
  running: 2,
  idle: 3,
};

/**
 * Threads in the project that are neither the PM's nor a task lead's, derived from
 * their current state. Waiting-on-user threads come first, then newest first.
 * Pass `withRequestText: false` when only counts are needed, to skip reading turn items.
 */
export const readOtherThreads = (input: {
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  readonly repository: ProjectTeamRepository.ProjectTeamRepository["Service"];
  readonly projectId: ProjectId;
  readonly managerThreadId: ThreadId;
  readonly withRequestText: boolean;
}) =>
  Effect.gen(function* () {
    const tasks = yield* input.repository.listTasks({ projectId: input.projectId });
    const teamThreadIds = new Set<string>([
      input.managerThreadId,
      ...tasks.flatMap((task) => (task.leadThreadId === null ? [] : [task.leadThreadId])),
    ]);
    const shells = (yield* input.threads.listProjectThreads({
      projectId: input.projectId,
      includeSubagents: false,
    })).filter(
      (shell) =>
        !teamThreadIds.has(shell.id) && shell.deletedAt === null && shell.archivedAt === null,
    );
    const entries = yield* Effect.forEach(shells, (shell) =>
      Effect.gen(function* () {
        const turnItems =
          input.withRequestText && shell.pendingRuntimeRequest !== null
            ? (yield* input.threads.getThreadRecords(shell.id, ["turnItems"])).turnItems
            : [];
        const pullRequest = linkedPullRequest(shell);
        const lastUpdate = lastUpdateMillis(shell, pullRequest?.at ?? 0);
        return {
          threadId: shell.id,
          title: shell.title,
          status: threadStatus(shell),
          lastUpdateAt: isoFromMillis(lastUpdate),
          latestMessage:
            shell.latestVisibleMessage === null
              ? null
              : trim(shell.latestVisibleMessage.text, LATEST_MESSAGE_MAX_CHARS),
          branch: shell.branch,
          pullRequestUrl: pullRequest?.url ?? null,
          pendingRequest: requestText(shell, turnItems),
        } satisfies ProjectOtherThread;
      }),
    );
    return entries.toSorted(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        isoMillis(b.lastUpdateAt) - isoMillis(a.lastUpdateAt),
    );
  });

/**
 * Counts toward the PM's "Needs you": an open question, approval or plan. A finished
 * turn waiting for a reply does not, since the sidebar already shows it as ready.
 */
export const isWaitingOnUser = <T extends ProjectOtherThread>(
  thread: T,
): thread is T & {
  readonly pendingRequest: ProjectOtherThreadRequest & {
    readonly kind: Exclude<ProjectOtherThreadRequest["kind"], "reply">;
  };
} => thread.pendingRequest !== null && thread.pendingRequest.kind !== "reply";
