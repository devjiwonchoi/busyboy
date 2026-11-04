import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
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

/** The PM's context is tidied once its latest turn uses this share of the window. */
export const CONTEXT_CARE_THRESHOLD = 0.75;
export const CONTEXT_CARE_MESSAGE_PREFIX = "project-team:compact:";

/**
 * Returns the provider turn whose usage calls for a compaction, or null.
 * Only the latest finished turn counts, so a compaction (which shrinks usage) never repeats.
 */
export function turnNeedingCompaction(
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "id" | "status" | "tokenUsage">>,
): Pick<OrchestrationV2ProviderTurn, "id"> | null {
  const latest = turns.findLast((turn) => turn.status === "completed" && turn.tokenUsage);
  const usage = latest?.tokenUsage;
  if (!latest || !usage || !usage.maxTokens) return null;
  return usage.usedTokens / usage.maxTokens >= CONTEXT_CARE_THRESHOLD ? latest : null;
}

export class ContextCare extends Context.Service<
  ContextCare,
  {
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/projectTeam/ContextCare") {}

const make = Effect.gen(function* () {
  const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // One compaction per provider turn, even if the run is reported again.
  const compactedTurns = yield* Ref.make<ReadonlySet<string>>(new Set());

  const handle: ContextCare["Service"]["handle"] = (event) =>
    Effect.gen(function* () {
      if (event.type !== "run.updated" || event.payload.status !== "completed") return;
      const run = event.payload;
      const manager = yield* repository.getManagerByThreadId(run.threadId);
      if (Option.isNone(manager) || !manager.value.settings.enabled) return;

      // Wait until the PM is idle; the next settled run re-checks.
      // The shell may still report the run that just ended as active.
      const shell = yield* threads.getThreadShell(run.threadId);
      if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) return;
      if (shell.activeRunId !== null && shell.activeRunId !== run.id) return;
      const records = yield* threads.getThreadRecords(run.threadId, ["providerTurns"]);
      const turn = turnNeedingCompaction(records.providerTurns);
      if (turn === null || (yield* Ref.get(compactedTurns)).has(turn.id)) return;
      yield* Ref.update(compactedTurns, (current) => new Set(current).add(turn.id));

      const key = `${CONTEXT_CARE_MESSAGE_PREFIX}${turn.id}`;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(key),
        threadId: run.threadId,
        messageId: MessageId.make(key),
        text: "/compact",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "system",
        creationSource: "server",
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project team context care failed", { threadId: event.threadId, cause }),
      ),
    );

  return { handle } satisfies ContextCare["Service"];
});

export const layer = Layer.effect(ContextCare, make);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const care = yield* ContextCare;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, care.handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project team context care stream failed", { cause }),
        ),
      ),
    );
  }),
).pipe(Layer.provide(layer));
