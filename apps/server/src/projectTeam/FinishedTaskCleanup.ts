import {
  CommandId,
  type OrchestrationV2ThreadShell,
  type ProjectTask,
  ProjectTaskEventId,
  type PullRequestState,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { MINUTE_MS, isLeadBusy, makeIdGenerator, makePeriodicGate, nowIso } from "./common.ts";

/** How often finished tasks are checked. The first check runs at startup. */
export const FINISHED_TASK_CLEANUP_INTERVAL_MS = 5 * MINUTE_MS;
const CHECKED_STAGES = ["in_review", "done", "cancelled"] as const;
const EVENT_LOOKBACK = 50;
/** Task log note written once per task; its presence means the task was already cleaned up. */
export const CLEANUP_NOTE = "Task finished: archived the lead thread to free its worktree.";

/**
 * Whether a task is finished, so its lead thread and worktree can go.
 * `pullRequestState` is null when the task has no PR or its state could not be read.
 * An open PR keeps everything: the lead may still push review fixes.
 */
export function isTaskFinished(
  task: Pick<ProjectTask, "stage" | "prUrl">,
  pullRequestState: PullRequestState | null,
): boolean {
  if (task.stage === "cancelled") return true;
  if (task.prUrl === null) return task.stage === "done";
  return pullRequestState === "merged" || pullRequestState === "closed";
}

const normalizeUrl = (url: string) =>
  url
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");

/** The lead thread's link to the task's PR, if the thread knows it. */
export function findPullRequestRef(
  lead: Pick<
    OrchestrationV2ThreadShell,
    "projectId" | "pullRequests" | "linkedPullRequest" | "branchPullRequest"
  >,
  prUrl: string,
): { readonly host?: string; readonly repository: string; readonly number: number } | null {
  const wanted = normalizeUrl(prUrl);
  const candidates = [
    ...(lead.pullRequests ?? []),
    ...(lead.linkedPullRequest == null ? [] : [lead.linkedPullRequest]),
    ...(lead.branchPullRequest == null ? [] : [lead.branchPullRequest]),
  ];
  const match = candidates.find((candidate) => normalizeUrl(candidate.url) === wanted);
  if (match === undefined) return null;
  return {
    ...("host" in match ? { host: match.host } : {}),
    repository: match.repository,
    number: match.number,
  };
}

/** Threads below `rootId` in the lineage, deepest first, so the root is archived last. */
function descendantsOf(
  rootId: ThreadId,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  const found: Array<OrchestrationV2ThreadShell> = [];
  let frontier: ReadonlyArray<ThreadId> = [rootId];
  while (frontier.length > 0) {
    const parents = new Set<string>(frontier);
    const children = threads.filter(
      (thread) =>
        thread.lineage.parentThreadId !== null &&
        parents.has(thread.lineage.parentThreadId) &&
        !found.some((seen) => seen.id === thread.id),
    );
    found.push(...children);
    frontier = children.map((child) => child.id);
  }
  return found.toReversed();
}

export class FinishedTaskCleanup extends Context.Service<
  FinishedTaskCleanup,
  {
    /** One pass over every project: archives the lead threads of finished tasks. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/projectTeam/FinishedTaskCleanup") {}

const make = Effect.gen(function* () {
  const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const newId = yield* makeIdGenerator;

  const pullRequestState = (lead: OrchestrationV2ThreadShell, prUrl: string) =>
    Effect.gen(function* () {
      const ref = findPullRequestRef(lead, prUrl);
      if (ref === null) return null;
      const summary = yield* pullRequests.summary(
        { projectId: lead.projectId, ...ref },
        { recoverTransientFailure: false },
      );
      return summary.state;
    }).pipe(Effect.orElseSucceed(() => null));

  const cleanUpTask = (
    task: ProjectTask,
    projectThreads: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) =>
    Effect.gen(function* () {
      if (task.leadThreadId === null) return;
      // Only active threads are listed, so an archived or deleted lead is skipped.
      const lead = projectThreads.find((thread) => thread.id === task.leadThreadId);
      if (lead === undefined) return;
      const state = task.prUrl === null ? null : yield* pullRequestState(lead, task.prUrl);
      if (!isTaskFinished(task, state)) return;
      // A thread the user unarchived after cleanup stays as they left it.
      const events = yield* repository.listTaskEvents({ taskId: task.id, limit: EVENT_LOOKBACK });
      if (events.some((event) => event.kind === "note" && event.body === CLEANUP_NOTE)) return;
      if (yield* isLeadBusy(threads, lead.id)) return;
      const descendants = descendantsOf(lead.id, projectThreads);
      if (descendants.some((thread) => thread.activeRunId !== null)) return;

      // Helpers (e.g. provider subagents) share the lead's worktree, and the archive
      // cleanup keeps a worktree any active thread still uses, so they go first.
      for (const thread of [...descendants, lead]) {
        yield* threads.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`project-team:cleanup:${task.id}:${thread.id}`),
          threadId: thread.id,
        });
      }
      yield* repository.appendTaskEvent({
        id: ProjectTaskEventId.make(yield* newId("task-event")),
        projectId: task.projectId,
        taskId: task.id,
        kind: "note",
        body: CLEANUP_NOTE,
        actorThreadId: null,
        createdAt: yield* nowIso,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project team finished task cleanup failed", { taskId: task.id, cause }),
      ),
    );

  const sweepProject = (manager: ProjectTeamRepository.ProjectManagerRecord) =>
    Effect.gen(function* () {
      const tasks = yield* repository.listTasks({
        projectId: manager.projectId,
        stages: CHECKED_STAGES,
      });
      if (tasks.length === 0) return;
      const projectThreads = yield* threads.listProjectThreads({
        projectId: manager.projectId,
        includeSubagents: true,
      });
      yield* Effect.forEach(tasks, (task) => cleanUpTask(task, projectThreads), { discard: true });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project team finished task cleanup failed", {
          projectId: manager.projectId,
          cause,
        }),
      ),
    );

  const sweep: FinishedTaskCleanup["Service"]["sweep"] = repository.listManagers().pipe(
    Effect.flatMap((managers) => Effect.forEach(managers, sweepProject, { discard: true })),
    Effect.catchCause((cause) =>
      Effect.logWarning("project team finished task cleanup failed", { cause }),
    ),
  );

  return { sweep } satisfies FinishedTaskCleanup["Service"];
});

export const layer = Layer.effect(FinishedTaskCleanup, make);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const cleanup = yield* FinishedTaskCleanup;
    const scheduler = yield* Scheduler.Scheduler;
    const everyFiveMinutes = yield* makePeriodicGate(FINISHED_TASK_CLEANUP_INTERVAL_MS);
    yield* scheduler.register(
      "project-team-finished-task-cleanup",
      everyFiveMinutes(cleanup.sweep),
    );
  }),
).pipe(Layer.provide(layer));
