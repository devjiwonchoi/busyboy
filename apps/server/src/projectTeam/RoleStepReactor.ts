import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RunAttempt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** Run ids already counted; a finished run can be reported more than once. */
const SEEN_LIMIT = 500;

export interface RunTokens {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
}

/**
 * The tokens one run spent: the per-turn usage of every provider turn of the run's
 * attempts. Input includes cache reads and writes, as the providers report it.
 */
export function runTokens(
  runId: string,
  attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>,
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "turnTokenUsage">>,
): RunTokens {
  const attemptIds = new Set<string>(
    attempts.filter((attempt) => attempt.runId === runId).map((attempt) => attempt.id),
  );
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  for (const turn of turns) {
    if (turn.runAttemptId === null || !attemptIds.has(turn.runAttemptId)) continue;
    const usage = turn.turnTokenUsage;
    if (usage === undefined) continue;
    inputTokens += usage.inputTokens ?? 0;
    cachedInputTokens += usage.cachedInputTokens ?? 0;
    cacheCreationTokens += usage.cacheCreationTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
  }
  return { inputTokens, cachedInputTokens, cacheCreationTokens, outputTokens };
}

/**
 * Adds each finished run of a task's model sessions (the lead, and the children it
 * started with task_delegate) to the task's usage: wall time, tokens and estimated cost.
 */
export class RoleStepReactor extends Context.Service<
  RoleStepReactor,
  {
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/projectTeam/RoleStepReactor") {}

const make = Effect.gen(function* () {
  const team = yield* ProjectTeamService.ProjectTeamService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const usage = yield* UsageService.UsageService;
  const seen = yield* Ref.make<ReadonlyArray<string>>([]);

  const handle: RoleStepReactor["Service"]["handle"] = (event) =>
    Effect.gen(function* () {
      if (event.type !== "run.updated") return;
      const run = event.payload;
      if (!TERMINAL_STATUSES.has(run.status) || run.startedAt === null) return;
      const session = yield* team.modelSessionOf(run.threadId);
      if (session === null) return;
      const fresh = yield* Ref.modify(seen, (ids) =>
        ids.includes(run.id) ? [false, ids] : [true, [...ids, run.id].slice(-SEEN_LIMIT)],
      );
      if (!fresh) return;
      const started = run.workStartedAt ?? run.startedAt;
      const finishedMs =
        run.completedAt === null
          ? yield* Effect.map(DateTime.now, DateTime.toEpochMillis)
          : DateTime.toEpochMillis(run.completedAt);
      const durationMs = Math.max(0, finishedMs - DateTime.toEpochMillis(started));
      const records = yield* threads.getThreadRecords(run.threadId, ["attempts", "providerTurns"]);
      const tokens = runTokens(run.id, records.attempts, records.providerTurns);
      const model = session.model ?? run.modelSelection.model;
      const cachedInputTokens = Math.min(tokens.cachedInputTokens, tokens.inputTokens);
      const costUsd =
        tokens.inputTokens + tokens.outputTokens === 0
          ? null
          : yield* usage.estimateCostUsd({
              model,
              uncachedInputTokens: Math.max(
                0,
                tokens.inputTokens - cachedInputTokens - tokens.cacheCreationTokens,
              ),
              cachedInputTokens,
              cacheCreationTokens: tokens.cacheCreationTokens,
              outputTokens: tokens.outputTokens,
            });
      yield* team.recordRunUsage({
        threadId: run.threadId,
        durationMs,
        inputTokens: tokens.inputTokens,
        cachedInputTokens,
        outputTokens: tokens.outputTokens,
        costUsd,
        finishedAt: DateTime.formatIso(DateTime.makeUnsafe(finishedMs)),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project team step usage failed", { threadId: event.threadId, cause }),
      ),
    );

  return { handle } satisfies RoleStepReactor["Service"];
});

export const layer = Layer.effect(RoleStepReactor, make);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* RoleStepReactor;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, reactor.handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project team step usage stream failed", { cause }),
        ),
      ),
    );
  }),
).pipe(Layer.provide(layer));
