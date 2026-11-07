import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { RoleStepReactor } from "./RoleStepReactor.ts";
import {
  type TeamHarness,
  approvePlan,
  setUpManager,
  startLead,
  withTeam,
} from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;
const START_MS = Date.parse("2026-11-04T00:00:00.000Z");

/** A finished run of a session thread that spent the given tokens over `minutes`. */
const finishedRun = (
  harness: TeamHarness,
  threadId: ThreadId,
  run: string,
  usage: { readonly input: number; readonly cached: number; readonly output: number },
  minutes: number,
): OrchestrationV2DomainEvent => {
  const thread = harness.threads.get(threadId) ?? harness.addThread(threadId);
  const attempt = `${run}-attempt`;
  thread.attempts = [...(thread.attempts ?? []), { id: attempt, runId: run }];
  thread.providerTurns = [
    ...(thread.providerTurns ?? []),
    {
      id: ProviderTurnId.make(`${run}-turn`),
      status: "completed",
      runAttemptId: RunAttemptId.make(attempt),
      turnTokenUsage: {
        usageScope: "main_agent",
        usageStatus: "complete",
        inputTokens: usage.input,
        cachedInputTokens: usage.cached,
        outputTokens: usage.output,
        hasSubagents: false,
      },
    },
  ];
  const startedAt = DateTime.makeUnsafe(START_MS);
  return {
    id: EventId.make(`event-${run}`),
    threadId,
    occurredAt: startedAt,
    type: "run.updated",
    payload: {
      id: RunId.make(run),
      threadId,
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
      providerThreadId: null,
      userMessageId: MessageId.make(`message-${run}`),
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed",
      requestedAt: startedAt,
      startedAt,
      completedAt: DateTime.makeUnsafe(START_MS + minutes * 60_000),
      checkpointId: null,
      contextHandoffId: null,
    },
  } as OrchestrationV2DomainEvent;
};

const storedTask = (taskId: Parameters<ProjectTeamRepository.ProjectTeamRepository["Service"]["getTask"]>[0]) =>
  Effect.flatMap(ProjectTeamRepository.ProjectTeamRepository, (repository) =>
    repository.getTask(taskId),
  ).pipe(Effect.map(Option.getOrThrow));

describe("ProjectTeamService step usage", () => {
  it.effect("records time, tokens and cost per role, once per run", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        harness.costPerToken = 0.000_001;
        const team = yield* service;
        const reactor = yield* RoleStepReactor;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Measure it", harness.delegate);

        const implement = yield* team.delegateStep(
          lead,
          { role: "implement", task: "Build t1." },
          harness.delegate,
        );
        const run = finishedRun(
          harness,
          implement.childThreadId,
          "run-implement-1",
          { input: 1_000, cached: 400, output: 200 },
          3,
        );
        yield* reactor.handle(run);
        // A run reported twice counts once.
        yield* reactor.handle(run);
        yield* reactor.handle(
          finishedRun(
            harness,
            implement.childThreadId,
            "run-implement-2",
            { input: 500, cached: 0, output: 100 },
            1,
          ),
        );
        yield* reactor.handle(
          finishedRun(harness, lead, "run-lead-1", { input: 300, cached: 0, output: 50 }, 2),
        );
        // A thread that is no task session is ignored.
        yield* reactor.handle(
          finishedRun(harness, "stranger" as ThreadId, "run-x", { input: 9, cached: 0, output: 9 }, 1),
        );

        const stored = yield* storedTask(task.id);
        assert.deepStrictEqual(stored.stepUsage.implement, {
          durationMs: 4 * 60_000,
          runs: 2,
          inputTokens: 1_500,
          outputTokens: 300,
          costUsd: (1_500 + 300) * 0.000_001,
        });
        assert.deepStrictEqual(stored.stepUsage.plan, {
          durationMs: 2 * 60_000,
          runs: 1,
          inputTokens: 300,
          outputTokens: 50,
          costUsd: 350 * 0.000_001,
        });
        assert.strictEqual(stored.stepUsage.review, undefined);
      }),
    ),
  );

  it.effect("keeps a null cost when the model has no known price", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const reactor = yield* RoleStepReactor;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Unpriced", harness.delegate);
        const review = yield* team.delegateStep(
          lead,
          { role: "review", task: "Review it." },
          harness.delegate,
        );
        yield* reactor.handle(
          finishedRun(harness, review.childThreadId, "run-review", { input: 10, cached: 0, output: 5 }, 1),
        );
        const stored = yield* storedTask(task.id);
        assert.strictEqual(stored.stepUsage.review?.costUsd, null);
        assert.strictEqual(stored.stepUsage.review?.inputTokens, 10);
      }),
    ),
  );

  it.effect("counts the task's size, review findings, fix rounds and CI failures", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Count it", harness.delegate);
        yield* team.updateTask(lead, { size: "medium" });
        yield* approvePlan(lead);
        yield* team.setEvidence(lead, { criterionId: "c1", evidence: "hello.test.sh passed" });

        const review = yield* team.delegateStep(
          lead,
          { role: "review", task: "Review it." },
          harness.delegate,
        );
        yield* team.setReview(review.childThreadId, {
          clean: false,
          findings: "hello.sh lacks a shebang\n\nThe test does not run hello.sh",
          head: "abc1234",
        });
        yield* team.delegateStep(lead, { role: "fix", task: "Fix both." }, harness.delegate);
        yield* team.setReview(review.childThreadId, { clean: true, findings: "", head: "abc1234" });
        yield* team.updateTask(lead, {
          stage: "in_review",
          prUrl: "https://github.com/acme/app/pull/3",
        });
        yield* team.recordShipWake({ leadThreadId: lead, summary: "#3: checks failed", checksFailed: true });
        yield* team.recordShipWake({ leadThreadId: lead, summary: "#3: a comment" });

        const stored = yield* storedTask(task.id);
        assert.deepStrictEqual(stored.metrics, {
          size: "medium",
          reviewFindings: 2,
          fixRounds: 1,
          ciFailures: 1,
        });
      }),
    ),
  );
});
