import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { CONTEXT_CARE_MESSAGE_PREFIX, ContextCare, turnNeedingCompaction } from "./ContextCare.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { PROJECT_ID, setUpManager, withTeam } from "./testkit.ts";

const turn = (
  id: string,
  usedTokens: number,
  status: "completed" | "running" = "completed",
  maxTokens: number | null = 200_000,
) =>
  ({
    id,
    status,
    tokenUsage: { usedTokens, maxTokens, updatedAt: "2026-11-04T00:00:00.000Z" },
  }) as never;

describe("turnNeedingCompaction", () => {
  it("asks for a compaction at 75% of the context window", () => {
    assert.strictEqual(turnNeedingCompaction([turn("t1", 150_000)])?.id, "t1");
  });

  it("leaves the context alone below the threshold", () => {
    assert.isNull(turnNeedingCompaction([turn("t1", 149_999)]));
  });

  it("looks only at the latest finished turn, so a compaction does not repeat", () => {
    assert.isNull(turnNeedingCompaction([turn("t1", 190_000), turn("t2", 20_000)]));
    assert.strictEqual(
      turnNeedingCompaction([turn("t1", 20_000), turn("t2", 190_000, "running")])?.id,
      undefined,
    );
  });

  it("skips turns without a known window size", () => {
    assert.isNull(turnNeedingCompaction([turn("t1", 190_000, "completed", null)]));
  });
});

function runCompleted(
  threadId: ThreadId,
  ordinal = 1,
  ended: { readonly status?: "completed" | "failed"; readonly userMessageId?: string } = {},
): OrchestrationV2DomainEvent {
  const at = DateTime.makeUnsafe("2026-11-04T00:05:00.000Z");
  return {
    id: EventId.make(`event-${threadId}-${ordinal}`),
    threadId,
    occurredAt: at,
    type: "run.updated",
    payload: {
      id: RunId.make(`run-${threadId}-${ordinal}`),
      threadId,
      ordinal,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      providerThreadId: null,
      userMessageId: MessageId.make(ended.userMessageId ?? `message-${threadId}-${ordinal}`),
      rootNodeId: null,
      activeAttemptId: null,
      status: ended.status ?? "completed",
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      checkpointId: null,
      contextHandoffId: null,
    },
  } as OrchestrationV2DomainEvent;
}

const compactions = (harness: Parameters<Parameters<typeof withTeam>[0]>[0]) =>
  Ref.get(harness.dispatched).pipe(
    Effect.map((commands) =>
      commands.flatMap((command) =>
        command.type === "message.dispatch" && command.text === "/compact" ? [command] : [],
      ),
    ),
  );

describe("ContextCare", () => {
  it.effect("compacts an idle PM once when its latest turn filled 75% of the window", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const care = yield* ContextCare;
        const pm = yield* setUpManager;
        harness.threads.get(pm)!.providerTurns = [turn("turn-1", 160_000)];

        yield* care.handle(runCompleted(pm));
        const [compact] = yield* compactions(harness);
        assert.strictEqual(compact?.type, "message.dispatch");
        assert.strictEqual(compact?.threadId, pm);
        if (compact?.type === "message.dispatch") {
          assert.isTrue(compact.messageId.startsWith(CONTEXT_CARE_MESSAGE_PREFIX));
          assert.strictEqual(compact.createdBy, "system");
          assert.strictEqual(compact.creationSource, "server");
        }

        // The same turn reported again does not compact twice.
        yield* care.handle(runCompleted(pm));
        yield* care.handle(runCompleted(pm, 2));
        assert.strictEqual((yield* compactions(harness)).length, 1);
      }),
    ),
  );

  it.effect("waits while the PM has another run in flight", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const care = yield* ContextCare;
        const pm = yield* setUpManager;
        const thread = harness.threads.get(pm)!;
        thread.providerTurns = [turn("turn-1", 160_000)];
        thread.activeRunId = "run-next";
        yield* care.handle(runCompleted(pm));
        assert.strictEqual((yield* compactions(harness)).length, 0);

        thread.activeRunId = null;
        yield* care.handle(runCompleted(pm, 2));
        assert.strictEqual((yield* compactions(harness)).length, 1);
      }),
    ),
  );

  it.effect("leaves a turned-off PM and other threads alone", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const care = yield* ContextCare;
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        harness.threads.get(pm)!.providerTurns = [turn("turn-1", 160_000)];
        const other = harness.addThread(ThreadId.make("other"));
        other.providerTurns = [turn("turn-2", 190_000)];

        yield* care.handle(runCompleted(other.id));
        yield* team.updateSettings({ projectId: PROJECT_ID, enabled: false });
        yield* care.handle(runCompleted(pm));
        assert.strictEqual((yield* compactions(harness)).length, 0);
      }),
    ),
  );

  it.effect("stops compacting a PM after a compaction run fails", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const care = yield* ContextCare;
        const pm = yield* setUpManager;
        const thread = harness.threads.get(pm)!;
        thread.providerTurns = [turn("turn-1", 160_000)];
        yield* care.handle(runCompleted(pm));
        const [compact] = yield* compactions(harness);
        assert.strictEqual(compact?.type, "message.dispatch");
        if (compact?.type !== "message.dispatch") return;

        // The provider cannot compact, so the "/compact" run fails.
        yield* care.handle(
          runCompleted(pm, 2, { status: "failed", userMessageId: compact.messageId }),
        );
        // Later full turns do not queue another compaction.
        thread.providerTurns = [turn("turn-1", 160_000), turn("turn-3", 170_000)];
        yield* care.handle(runCompleted(pm, 3));
        thread.providerTurns = [...thread.providerTurns, turn("turn-4", 180_000)];
        yield* care.handle(runCompleted(pm, 4));
        assert.strictEqual((yield* compactions(harness)).length, 1);
      }),
    ),
  );

  it.effect("keeps compacting after an ordinary PM run fails", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const care = yield* ContextCare;
        const pm = yield* setUpManager;
        harness.threads.get(pm)!.providerTurns = [turn("turn-1", 160_000)];
        yield* care.handle(runCompleted(pm, 1, { status: "failed" }));
        yield* care.handle(runCompleted(pm, 2));
        assert.strictEqual((yield* compactions(harness)).length, 1);
      }),
    ),
  );
});
