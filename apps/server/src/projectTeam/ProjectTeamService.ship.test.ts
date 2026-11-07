import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type PullRequestWatchChangeKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { PullRequestShipState } from "./PullRequestShipGate.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { ShipWakeReactor } from "./ShipWakeReactor.ts";
import {
  type TeamHarness,
  approvePlan,
  reviewClean,
  setUpManager,
  startLead,
  withTeam,
} from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;
const PR_URL = "https://github.com/acme/app/pull/7";
const HEAD = "abc1234";

const greenPullRequest: PullRequestShipState = {
  state: "open",
  isDraft: true,
  headSha: HEAD,
  mergeability: "mergeable",
  checks: [{ name: "test", status: "success" }],
  unresolvedThreads: 0,
};

/** A lead whose task is In Review with a draft pull request at HEAD. */
const shipLead = (harness: TeamHarness) =>
  Effect.gen(function* () {
    const team = yield* service;
    const pm = yield* setUpManager;
    const { leadThreadId: lead, task } = yield* startLead(pm, "Ship it", harness.delegate);
    yield* approvePlan(lead);
    yield* team.setEvidence(lead, { criterionId: "c1", evidence: "hello.test.sh passed" });
    yield* reviewClean(lead, HEAD);
    yield* team.updateTask(lead, { stage: "in_review", prUrl: PR_URL });
    harness.shipStates.set(PR_URL, greenPullRequest);
    return { pm, lead, task };
  });

const statusOf = (pm: ThreadId, taskId: string) =>
  Effect.gen(function* () {
    const team = yield* service;
    const { tasks } = yield* team.listTasks(pm, {});
    return tasks.find((task) => task.id === taskId)?.status;
  });

const refusal = (lead: ThreadId, localChecks = "") =>
  Effect.flatMap(service, (team) =>
    team.markTaskReady(lead, { head: HEAD, localChecks }).pipe(
      Effect.flip,
      Effect.map((error) => error.message),
    ),
  );

const watchWake = (
  lead: ThreadId,
  changes: ReadonlyArray<PullRequestWatchChangeKind>,
  id = "message:pr-watch:1",
): OrchestrationV2DomainEvent =>
  ({
    id: EventId.make(`event-${id}`),
    threadId: lead,
    occurredAt: DateTime.makeUnsafe("2026-11-04T00:10:00.000Z"),
    type: "message.updated",
    payload: {
      id: MessageId.make(id),
      threadId: lead,
      role: "user",
      createdBy: "agent",
      creationSource: "server",
      text: "Update on pull request #7",
      notification: {
        source: { kind: "monitor", pullRequestChanges: changes },
        outcome: "failed",
        summary: "#7: checks failed",
      },
      createdAt: DateTime.makeUnsafe("2026-11-04T00:10:00.000Z"),
    },
  }) as unknown as OrchestrationV2DomainEvent;

describe("ProjectTeamService ship loop", () => {
  it.effect("takes a draft pull request into In Review and watches it for the lead", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const { pm, lead, task } = yield* shipLead(harness);

        const watch = (yield* Ref.get(harness.dispatched)).find(
          (command) => command.type === "thread.pull-request.watch",
        );
        assert.deepInclude(watch, {
          threadId: lead,
          host: "github.com",
          repository: "acme/app",
          number: 7,
          watching: true,
          link: { url: PR_URL, source: "agent" },
        });
        // An open pull request is In Review until it passes the Ready gate.
        assert.strictEqual(yield* statusOf(pm, task.id), "in_review");
      }),
    ),
  );

  it.effect("refuses Ready while checks fail or run, threads are open or the PR conflicts", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const { lead } = yield* shipLead(harness);
        const withPr = (patch: Partial<PullRequestShipState>) =>
          harness.shipStates.set(PR_URL, { ...greenPullRequest, ...patch });

        withPr({ checks: [{ name: "lint", status: "failure" }] });
        assert.include(yield* refusal(lead), "Checks failed: lint");

        withPr({ checks: [{ name: "test", status: "pending" }] });
        assert.include(yield* refusal(lead), "Checks are still running: test");

        withPr({ unresolvedThreads: 2 });
        assert.include(yield* refusal(lead), "2 review threads are unresolved");

        withPr({ mergeability: "conflicting" });
        assert.include(yield* refusal(lead), "conflicts with its base");

        withPr({ headSha: "fff9999" });
        assert.include(yield* refusal(lead), "head is fff9999, not abc1234: push HEAD first");

        withPr({});
        harness.worktreeHead = () => "ddd4444";
        harness.threads.set(lead, {
          ...harness.addThread(lead),
          worktreePath: "/work/lead",
        });
        assert.include(yield* refusal(lead), "HEAD is ddd4444, not abc1234");
        harness.worktreeHead = () => null;

        harness.shipStates.delete(PR_URL);
        assert.include(yield* refusal(lead), "Could not read");
        assert.deepStrictEqual(harness.markedReady, []);
      }),
    ),
  );

  it.effect("needs a clean self-review of the head being marked Ready", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { lead } = yield* shipLead(harness);
        const stale = yield* team
          .markTaskReady(lead, { head: "eee5555", localChecks: "" })
          .pipe(Effect.flip);
        assert.include(stale.message, "no clean self-review of eee5555");
      }),
    ),
  );

  it.effect("marks the draft ready for review and the task Ready when the gate passes", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { pm, lead, task } = yield* shipLead(harness);

        const { task: ready } = yield* team.markTaskReady(lead, { head: HEAD, localChecks: "" });
        assert.deepStrictEqual(harness.markedReady, [PR_URL]);
        assert.deepInclude(ready.ready, { head: HEAD, gate: "checks", localChecks: "" });
        assert.strictEqual(yield* statusOf(pm, task.id), "ready");

        // Already ready for review: no second mutation.
        yield* team.markTaskReady(lead, { head: HEAD, localChecks: "" });
        assert.deepStrictEqual(harness.markedReady, [PR_URL]);
      }),
    ),
  );

  it.effect("stays In Review when the host refuses to mark the pull request ready", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const { pm, lead, task } = yield* shipLead(harness);
        harness.markReadyRefusal = "forbidden";
        assert.include(yield* refusal(lead), `Run gh pr ready ${PR_URL}`);
        assert.strictEqual(yield* statusOf(pm, task.id), "in_review");
      }),
    ),
  );

  it.effect("takes local evidence on HEAD as the gate when the pull request has no checks", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { pm, lead, task } = yield* shipLead(harness);
        harness.shipStates.set(PR_URL, { ...greenPullRequest, checks: [] });

        assert.include(yield* refusal(lead), "pass the commands and their result as localChecks");

        // Every criterion needs evidence, including one added after In Review.
        const read = yield* team.readSpec(lead, {});
        yield* team.writeSpec(lead, {
          baseVersion: read.current.version,
          spec: {
            ...read.current.spec,
            criteria: [
              ...(read.current.spec.criteria ?? []),
              { id: "c2", text: "lint passes", provenBy: "vp lint", evidence: null },
            ],
          },
          note: "Add a criterion",
        });
        assert.include(yield* refusal(lead, "pnpm test: 12 passed"), "c2 has none");

        yield* team.setEvidence(lead, { criterionId: "c2", evidence: "vp lint: 0 problems" });
        const { task: ready } = yield* team.markTaskReady(lead, {
          head: HEAD,
          localChecks: "pnpm test: 12 passed; vp lint: 0 problems",
        });
        assert.deepInclude(ready.ready, {
          head: HEAD,
          gate: "local",
          localChecks: "pnpm test: 12 passed; vp lint: 0 problems",
        });
        assert.strictEqual(yield* statusOf(pm, task.id), "ready");
      }),
    ),
  );

  it.effect("starts a Ship round and clears Ready on a failed check, comment or conflict", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const reactor = yield* ShipWakeReactor;
        const { pm, lead, task } = yield* shipLead(harness);
        const shipRound = Effect.map(
          team.getTaskDetail({ projectId: task.projectId, taskId: task.id }),
          (detail) => detail.task.shipRound,
        );
        assert.strictEqual(yield* shipRound, 1);

        yield* team.markTaskReady(lead, { head: HEAD, localChecks: "" });
        assert.strictEqual(yield* statusOf(pm, task.id), "ready");

        // Passed checks are not a new round.
        yield* reactor.handle(watchWake(lead, ["checks-passed"], "message:pr-watch:passed"));
        assert.strictEqual(yield* shipRound, 1);
        assert.strictEqual(yield* statusOf(pm, task.id), "ready");

        yield* reactor.handle(watchWake(lead, ["checks-failed"], "message:pr-watch:failed"));
        // The same message reported again counts once.
        yield* reactor.handle(watchWake(lead, ["checks-failed"], "message:pr-watch:failed"));
        assert.strictEqual(yield* shipRound, 2);
        assert.strictEqual(yield* statusOf(pm, task.id), "in_review");

        yield* reactor.handle(watchWake(lead, ["remarks"], "message:pr-watch:remarks"));
        yield* reactor.handle(watchWake(lead, ["conflicting"], "message:pr-watch:conflict"));
        assert.strictEqual(yield* shipRound, 4);
      }),
    ),
  );

  it.effect("clears Ready when the task leaves In Review or records a new review", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { pm, lead, task } = yield* shipLead(harness);

        yield* team.markTaskReady(lead, { head: HEAD, localChecks: "" });
        yield* reviewClean(lead, HEAD);
        assert.strictEqual(yield* statusOf(pm, task.id), "in_review");

        yield* team.markTaskReady(lead, { head: HEAD, localChecks: "" });
        yield* team.setReview(lead, { clean: false, findings: "Missing test", head: HEAD });
        const { task: back } = yield* team.getTaskDetail({
          projectId: task.projectId,
          taskId: task.id,
        });
        assert.strictEqual(back.stage, "running");
        assert.isNull(back.ready);
      }),
    ),
  );

  it.effect("refuses Ready outside In Review", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead } = yield* startLead(pm, "Early", harness.delegate);
        yield* approvePlan(lead);
        const early = yield* team
          .markTaskReady(lead, { head: HEAD, localChecks: "" })
          .pipe(Effect.flip);
        assert.include(early.message, "Only an In Review task with a pull request can be Ready");
      }),
    ),
  );
});
