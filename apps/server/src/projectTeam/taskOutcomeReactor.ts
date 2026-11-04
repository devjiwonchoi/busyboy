import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ProjectTask,
  type ProjectTaskOutcome,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import { forkParked } from "../serverActivation.ts";
import { isLeadBusy } from "./common.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { ACTIVE_TASK_STAGES } from "./SitrepScheduler.ts";

type TerminalRunStatus = Extract<
  OrchestrationV2Run["status"],
  "completed" | "failed" | "cancelled" | "interrupted"
>;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/**
 * Classifies a finished task lead turn; the first matching rule wins.
 * Only a failed run counts as failed. An interrupted or cancelled turn counts as stalled:
 * a server restart or shutdown ends in-flight runs as cancelled and then continues them,
 * and the continuation's end reclassifies.
 */
export function classifyTaskOutcome(input: {
  readonly task: Pick<ProjectTask, "stage" | "prUrl">;
  readonly openAttentionCount: number;
  readonly status: TerminalRunStatus;
}): ProjectTaskOutcome {
  if (input.openAttentionCount > 0) return "waiting_user";
  if (input.task.prUrl !== null && input.task.stage !== "done") return "in_review";
  if (input.task.stage === "done") return "done";
  if (input.status === "failed") return "failed";
  return "stalled";
}

/**
 * The inbox task the PM could start next: the lowest-numbered one whose
 * dependencies are done or in review. Null when none is ready.
 */
export function nextInboxTask(
  tasks: ReadonlyArray<Pick<ProjectTask, "id" | "number" | "stage" | "waitsOn">>,
): Pick<ProjectTask, "number"> | null {
  const stageById = new Map(tasks.map((task) => [task.id as string, task.stage]));
  const ready = tasks
    .filter((task) => task.stage === "inbox")
    .filter((task) =>
      task.waitsOn.every((dependencyId) => {
        const stage = stageById.get(dependencyId);
        return stage === "done" || stage === "in_review";
      }),
    )
    .toSorted((a, b) => a.number - b.number);
  return ready[0] ?? null;
}

/**
 * The one line that wakes the PM after a task lead's turn, or null to stay quiet.
 * Only a failure, or a finished task that frees room for a ready inbox task, wakes it;
 * stalls are left to StalledTaskSweep.
 */
export function outcomeWakeText(input: {
  readonly task: Pick<ProjectTask, "number" | "title">;
  readonly outcome: ProjectTaskOutcome;
  readonly projectTasks: ReadonlyArray<Pick<ProjectTask, "id" | "number" | "stage" | "waitsOn">>;
  readonly maxConcurrentTasks: number;
}): string | null {
  if (input.outcome === "failed") {
    return `#${input.task.number} failed: ${input.task.title} (the lead's turn failed; a blocker is open)`;
  }
  if (input.outcome !== "done" && input.outcome !== "in_review") return null;
  const active = input.projectTasks.filter((task) =>
    (ACTIVE_TASK_STAGES as ReadonlyArray<string>).includes(task.stage),
  ).length;
  if (active >= input.maxConcurrentTasks) return null;
  const next = nextInboxTask(input.projectTasks);
  if (next === null) return null;
  return `#${input.task.number} done · #${next.number} is next in the inbox`;
}

export class TaskOutcomeReactor extends Context.Service<
  TaskOutcomeReactor,
  {
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/projectTeam/taskOutcomeReactor") {}

const make = Effect.gen(function* () {
  const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
  const team = yield* ProjectTeamService.ProjectTeamService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // A terminal run can be reported more than once; key by lead thread.
  const lastSeen = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

  /** Wakes the PM with one short line when the outcome needs its attention. */
  const wakeManager = (input: {
    readonly task: ProjectTask;
    readonly outcome: ProjectTaskOutcome;
    readonly runId: string;
  }) =>
    Effect.gen(function* () {
      const manager = yield* repository.getManager(input.task.projectId);
      if (Option.isNone(manager) || !manager.value.settings.enabled) return;
      const text = outcomeWakeText({
        task: input.task,
        outcome: input.outcome,
        projectTasks: yield* repository.listTasks({ projectId: input.task.projectId }),
        maxConcurrentTasks: manager.value.settings.maxConcurrentTasks,
      });
      if (text === null) return;
      const pmThreadId = manager.value.threadId;
      const shell = yield* threads.getThreadShell(pmThreadId);
      if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) return;
      // Keyed by run so a retried or re-reported run wakes the PM once.
      const key = `project-team:outcome:${input.runId}`;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(key),
        threadId: pmThreadId,
        messageId: MessageId.make(key),
        text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "system",
        creationSource: "server",
      });
    });

  const handle: TaskOutcomeReactor["Service"]["handle"] = (event) =>
    Effect.gen(function* () {
      // Every lead run counts, not just the first: once the PM has the delegated
      // result, later runs (e.g. after an answer relay) no longer update the subagent.
      if (event.type !== "run.updated") return;
      const run = event.payload;
      // A queued run cancelled before it started (e.g. a superseded nudge) is not a lead turn.
      if (!TERMINAL_STATUSES.has(run.status) || run.startedAt === null) return;
      const runKey = `${run.id}:${run.status}`;
      const previous = (yield* Ref.get(lastSeen)).get(run.threadId);
      if (previous === runKey) return;

      const task = yield* repository.findTaskByLeadThreadId(run.threadId);
      if (Option.isNone(task) || task.value.stage === "cancelled") return;
      yield* Ref.update(lastSeen, (current) => new Map(current).set(run.threadId, runKey));
      const open = yield* repository.listOpenAttentionItems({
        projectId: task.value.projectId,
        taskId: task.value.id,
      });
      const outcome = classifyTaskOutcome({
        task: task.value,
        openAttentionCount: open.length,
        status: run.status as TerminalRunStatus,
      });
      // A lead that fanned out delegated children ends its turn while they work;
      // their completion wakes it, and that turn's end reclassifies.
      if (outcome === "stalled" && (yield* isLeadBusy(threads, run.threadId, run.id))) return;
      const recorded = yield* team.recordOutcome({
        task: task.value,
        outcome,
        ...(outcome === "failed" ? { detail: run.status } : {}),
      });
      yield* wakeManager({
        task: recorded.task,
        outcome,
        runId: run.id,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project team task outcome failed", { threadId: event.threadId, cause }),
      ),
    );

  return { handle } satisfies TaskOutcomeReactor["Service"];
});

export const layer = Layer.effect(TaskOutcomeReactor, make);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* TaskOutcomeReactor;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, reactor.handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project team task outcome stream failed", { cause }),
        ),
      ),
    );
  }),
).pipe(Layer.provide(layer));
