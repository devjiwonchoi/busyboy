import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  BACKGROUND_COMPACTION_MESSAGE_PREFIX,
  isBackgroundCompactionMessageId,
} from "@t3tools/shared/claudeCompaction";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";

/**
 * A thread's context is compacted while it is idle once its latest turn uses
 * this share of the window, so the provider rarely has to compact mid-turn.
 * Applies to every thread: the PM, task leads and the user's own threads.
 */
export const CONTEXT_CARE_THRESHOLD = 0.75;
export const CONTEXT_CARE_MESSAGE_PREFIX = BACKGROUND_COMPACTION_MESSAGE_PREFIX;

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
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // One compaction per provider turn, even if the run is reported again.
  const compactedTurns = yield* Ref.make<ReadonlySet<string>>(new Set());
  // Threads whose "/compact" failed, e.g. because the provider cannot compact. Retrying
  // after every turn would fail the same way, so they are left alone until restart.
  const cannotCompact = yield* Ref.make<ReadonlySet<string>>(new Set());

  const handle: ContextCare["Service"]["handle"] = (event) =>
    Effect.gen(function* () {
      if (event.type !== "run.updated") return;
      const run = event.payload;
      if (run.status === "failed" && isBackgroundCompactionMessageId(run.userMessageId)) {
        yield* Ref.update(cannotCompact, (current) => new Set(current).add(run.threadId));
        yield* Effect.logWarning("context care stopped after a failed compaction", {
          threadId: run.threadId,
        });
        return;
      }
      if (run.status !== "completed") return;
      if ((yield* Ref.get(cannotCompact)).has(run.threadId)) return;
      // Only providers that offer /compact; others would just fail the run.
      const provider = (yield* providers.getProviders).find(
        (candidate) => candidate.instanceId === run.providerInstanceId,
      );
      if (!provider?.slashCommands.some((command) => command.name === "compact")) return;

      // Wait until the thread is idle; the next settled run re-checks.
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
        Effect.logWarning("context care failed", { threadId: event.threadId, cause }),
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
        Effect.catchCause((cause) => Effect.logWarning("context care stream failed", { cause })),
      ),
    );
  }),
).pipe(Layer.provide(layer));
