import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  ProjectTask,
  ProjectTaskOutcome,
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
      yield* team.recordOutcome({
        task: task.value,
        outcome,
        ...(outcome === "failed" ? { detail: run.status } : {}),
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
