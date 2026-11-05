import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ProjectTask,
  type ProjectTaskStage,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import { forkParked } from "../serverActivation.ts";
import { isLeadBusy, makeIdGenerator } from "./common.ts";

/** Stages whose lead thread is archived, which also removes its worktree. */
export const FINISHED_TASK_STAGES: ReadonlyArray<ProjectTaskStage> = ["done", "cancelled"];

export const isFinishedStage = (stage: ProjectTaskStage) => FINISHED_TASK_STAGES.includes(stage);

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

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
    /**
     * Archives a done or cancelled task's lead thread and its helpers; the archive
     * then removes the worktree. Waits for an idle lead unless `stopLead` is set,
     * so a lead that marks its own task done can finish its turn.
     */
    readonly archiveLead: (
      task: ProjectTask,
      options?: { readonly stopLead?: boolean; readonly endedRunId?: string },
    ) => Effect.Effect<void>;
    /** Unarchives a reopened task's lead thread and restores its worktree. */
    readonly reviveLead: (task: ProjectTask) => Effect.Effect<void>;
    /** Archives the leads of every task that is already done or cancelled. */
    readonly sweep: Effect.Effect<void>;
    readonly handleEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/projectTeam/FinishedTaskCleanup") {}

const make = Effect.gen(function* () {
  const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const newId = yield* makeIdGenerator;

  const commandId = (kind: string, threadId: ThreadId) =>
    newId(`project-team:${kind}:${threadId}`).pipe(Effect.map(CommandId.make));

  /**
   * A lead may check out its own branch name instead of the one the thread was
   * created on. The archive cleanup keeps a worktree on an unexpected branch, and
   * restore checks out the recorded one, so record the branch actually in use.
   */
  const recordCheckedOutBranch = (lead: OrchestrationV2ThreadShell) =>
    Effect.gen(function* () {
      if (lead.worktreePath === null) return;
      yield* git.invalidateLocalStatus(lead.worktreePath);
      const status = yield* git.localStatus({ cwd: lead.worktreePath });
      const checkedOut = status.refName;
      if (checkedOut === null || checkedOut === "HEAD" || checkedOut === lead.branch) return;
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: yield* commandId("branch", lead.id),
        threadId: lead.id,
        branch: checkedOut,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logInfo("project team could not read a lead's checked-out branch", {
          threadId: lead.id,
          cause,
        }),
      ),
    );

  const archiveLead: FinishedTaskCleanup["Service"]["archiveLead"] = (task, options) =>
    Effect.gen(function* () {
      if (!isFinishedStage(task.stage) || task.leadThreadId === null) return;
      const leadThreadId = task.leadThreadId;
      // Only active threads are listed, so an archived or deleted lead is skipped.
      const projectThreads = yield* threads.listProjectThreads({
        projectId: task.projectId,
        includeSubagents: true,
      });
      const lead = projectThreads.find((thread) => thread.id === leadThreadId);
      if (lead === undefined) return;
      const descendants = descendantsOf(lead.id, projectThreads);
      if (options?.stopLead !== true) {
        if (yield* isLeadBusy(threads, lead.id, options?.endedRunId)) return;
        if (descendants.some((thread) => thread.activeRunId !== null)) return;
      }

      yield* recordCheckedOutBranch(lead);
      // Helpers (e.g. provider subagents) share the lead's worktree, and the archive
      // cleanup keeps a worktree any active thread still uses, so they go first.
      for (const thread of [...descendants, lead]) {
        yield* threads.dispatch({
          type: "thread.archive",
          commandId: yield* commandId("archive", thread.id),
          threadId: thread.id,
        });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project team could not archive a finished task's lead", {
          taskId: task.id,
          cause,
        }),
      ),
    );

  const reviveLead: FinishedTaskCleanup["Service"]["reviveLead"] = (task) =>
    Effect.gen(function* () {
      if (task.leadThreadId === null) return;
      const lead = yield* threads.getThreadShell(task.leadThreadId);
      if (lead === null || lead.deletedAt !== null || lead.archivedAt === null) return;
      yield* threads.dispatch({
        type: "thread.unarchive",
        commandId: yield* commandId("unarchive", lead.id),
        threadId: lead.id,
        restoreWorktree: true,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project team could not revive a reopened task's lead", {
          taskId: task.id,
          cause,
        }),
      ),
    );

  const sweep: FinishedTaskCleanup["Service"]["sweep"] = repository.listManagers().pipe(
    Effect.flatMap((managers) =>
      Effect.forEach(
        managers,
        (manager) =>
          repository
            .listTasks({ projectId: manager.projectId, stages: FINISHED_TASK_STAGES })
            .pipe(
              Effect.flatMap((tasks) =>
                Effect.forEach(tasks, (task) => archiveLead(task), { discard: true }),
              ),
            ),
        { discard: true },
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("project team finished task sweep failed", { cause }),
    ),
  );

  // A lead that marked its task done mid-turn is archived once that turn ends.
  const handleEvent: FinishedTaskCleanup["Service"]["handleEvent"] = (event) =>
    Effect.gen(function* () {
      if (event.type !== "run.updated") return;
      const run = event.payload;
      if (!TERMINAL_RUN_STATUSES.has(run.status)) return;
      const task = yield* repository.findTaskByLeadThreadId(run.threadId);
      if (Option.isNone(task) || !isFinishedStage(task.value.stage)) return;
      yield* archiveLead(task.value, { endedRunId: run.id });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project team finished task cleanup failed", {
          threadId: event.threadId,
          cause,
        }),
      ),
    );

  return { archiveLead, reviveLead, sweep, handleEvent } satisfies FinishedTaskCleanup["Service"];
});

export const layer = Layer.effect(FinishedTaskCleanup, make);

/** Sweeps once at startup, then follows lead turns as they end. */
export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const cleanup = yield* FinishedTaskCleanup;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* forkParked(cleanup.sweep);
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, cleanup.handleEvent).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project team finished task cleanup stream failed", { cause }),
        ),
      ),
    );
  }),
);
