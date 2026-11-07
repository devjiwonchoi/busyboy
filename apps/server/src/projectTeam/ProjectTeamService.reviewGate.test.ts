import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestratorMcpDelegateTaskResult,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import type { PullRequestShipState } from "./PullRequestShipGate.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import {
  type TeamHarness,
  approvePlan,
  PROJECT_ID,
  reviewClean,
  setUpManager,
  startLead,
  withTeam,
} from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;
const PR_URL = "https://github.com/acme/app/pull/9";
const HEAD = "abc1234";
const opus = ProviderInstanceId.make("claude-work");

const greenPullRequest: PullRequestShipState = {
  state: "open",
  isDraft: true,
  headSha: HEAD,
  mergeability: "mergeable",
  checks: [{ name: "test", status: "success" }],
  unresolvedThreads: 0,
};

/** A running task with proven criteria, ready for its review. */
const builtTask = (harness: TeamHarness, reviewModel: boolean) =>
  Effect.gen(function* () {
    const team = yield* service;
    const pm = yield* setUpManager;
    if (reviewModel) {
      yield* team.updateSettings({
        projectId: PROJECT_ID,
        roleModels: { review: { providerInstanceId: opus, model: "claude-opus-5-5" } },
      });
    }
    const { leadThreadId: lead, task } = yield* startLead(pm, "Ship it", harness.delegate);
    yield* approvePlan(lead);
    yield* team.setEvidence(lead, { criterionId: "c1", evidence: "hello.test.sh passed" });
    harness.shipStates.set(PR_URL, greenPullRequest);
    return { lead, task };
  });

const failure = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  );

const shipIt = (lead: ThreadId) =>
  Effect.flatMap(service, (team) => team.updateTask(lead, { stage: "in_review", prUrl: PR_URL }));

describe("ProjectTeamService review gate", () => {
  it.effect("needs the review model's clean review, not the lead's, to ship", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { lead, task } = yield* builtTask(harness, true);

        // The lead's own clean review is refused, and In Review stays shut.
        const selfReview = yield* failure(reviewClean(lead, HEAD));
        assert.include(selfReview, "must come from it");
        assert.include(selfReview, 'task_delegate(role: "review")');
        assert.include(yield* failure(shipIt(lead)), "no self-review yet");

        // The review session, started by task_delegate, records its own clean review.
        const review = yield* team.delegateStep(
          lead,
          { role: "review", task: "Review main...abc1234 against c1." },
          harness.delegate,
        );
        assert.strictEqual(review.model, "claude-opus-5-5");
        const reviewed = yield* team.setReview(review.childThreadId, {
          clean: true,
          findings: "",
          head: HEAD,
        });
        assert.strictEqual(reviewed.task.review?.by, "reviewer");
        assert.strictEqual(reviewed.task.review?.model, "claude-opus-5-5");
        assert.strictEqual(reviewed.task.id, task.id);

        const shipped = yield* shipIt(lead);
        assert.strictEqual(shipped.task.stage, "in_review");
        const ready = yield* team.markTaskReady(lead, { head: HEAD, localChecks: "" });
        assert.notStrictEqual(ready.task.ready, null);
      }),
    ),
  );

  it.effect("lets the lead record findings, but only the reviewer can clear them", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { lead } = yield* builtTask(harness, true);

        const found = yield* team.setReview(lead, {
          clean: false,
          findings: "hello.sh lacks a shebang",
          head: HEAD,
        });
        assert.strictEqual(found.task.review?.by, "lead");
        assert.include(yield* failure(shipIt(lead)), "not clean");

        // A session that is not a review session cannot record a review.
        const implement = yield* team.delegateStep(
          lead,
          { role: "implement", task: "Add the shebang." },
          harness.delegate,
        );
        assert.include(
          yield* failure(
            team.setReview(implement.childThreadId, { clean: true, findings: "", head: HEAD }),
          ),
          "only for a task lead or the review session",
        );
      }),
    ),
  );

  it.effect("keeps the lead's self-review as the gate when no review model is set", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const { lead } = yield* builtTask(harness, false);
        const reviewed = yield* reviewClean(lead, HEAD);
        assert.strictEqual(reviewed.task.review?.by, "lead");
        const shipped = yield* shipIt(lead);
        assert.strictEqual(shipped.task.stage, "in_review");
      }),
    ),
  );

  it.effect("links a waited-on review session before it records its review", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { lead } = yield* builtTask(harness, true);
        const child = ThreadId.make("review-waited");
        // Like delegate_task with mode "wait": the child runs to the end before the call returns.
        const review = yield* team.delegateStep(
          lead,
          { role: "review", task: "Review it.", mode: "wait" },
          (input, onChildCreated) =>
            Effect.gen(function* () {
              const ran = { childThreadId: child, providerInstanceId: opus, model: "claude-opus-5-5" };
              yield* onChildCreated?.(ran) ?? Effect.void;
              yield* team.setReview(child, { clean: true, findings: "", head: HEAD }).pipe(Effect.orDie);
              return {
                taskId: NodeId.make("node-waited"),
                ...ran,
                status: input.mode === "wait" ? "completed" : "running",
              } as OrchestratorMcpDelegateTaskResult;
            }),
        );
        assert.strictEqual(review.childThreadId, child);
        const shipped = yield* shipIt(lead);
        assert.strictEqual(shipped.task.review?.by, "reviewer");
        assert.strictEqual(shipped.task.stage, "in_review");
      }),
    ),
  );

  it.effect("counts a retried fix step once", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { lead, task } = yield* builtTask(harness, true);
        const sameChild = () =>
          Effect.succeed({
            taskId: NodeId.make("node-fix"),
            childThreadId: ThreadId.make("fix-1"),
            providerInstanceId: opus,
            model: "claude-opus-5-5",
          } as OrchestratorMcpDelegateTaskResult);
        const fix = { role: "fix" as const, task: "Fix it.", clientRequestId: "fix-round-1" };
        yield* team.delegateStep(lead, fix, sameChild);
        yield* team.delegateStep(lead, fix, sameChild);
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const stored = Option.getOrThrow(yield* repository.getTask(task.id));
        assert.strictEqual(stored.metrics.fixRounds, 1);
      }),
    ),
  );

  it.effect("does not count a clean review from a review model the user has replaced", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { lead } = yield* builtTask(harness, true);
        const review = yield* team.delegateStep(
          lead,
          { role: "review", task: "Review it." },
          harness.delegate,
        );
        yield* team.setReview(review.childThreadId, { clean: true, findings: "", head: HEAD });
        yield* team.updateSettings({
          projectId: PROJECT_ID,
          roleModels: { review: { providerInstanceId: opus, model: "claude-fable-5-1" } },
        });
        const refused = yield* failure(shipIt(lead));
        assert.include(refused, "came from claude-opus-5-5, but the review model is now claude-fable-5-1");
      }),
    ),
  );
});
