import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as GoalAlignmentReactor from "./GoalAlignmentReactor.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { createAcceptedTask, setUpWorkspace, withTeam } from "./testkit.ts";

describe("GoalAlignmentReactor", () => {
  it.effect("wakes the Director once with missing work and blocked paths, then only on news", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const reactor = yield* GoalAlignmentReactor.GoalAlignmentReactor;
        const { firstPm, secondPm, director } = yield* setUpWorkspace(harness);
        const goalChecks = harness
          .messagesTo(director.threadId)
          .pipe(
            Effect.map((texts) =>
              texts.filter((text) => text.startsWith(GoalAlignmentReactor.GOAL_CHECK_PREFIX)),
            ),
          );

        const { task: api } = yield* createAcceptedTask(firstPm, {
          intake: "New work.",
          title: "Payments API",
          request: "Build the API.",
        });
        // The second project's page waits on the first project's API.
        const { task: page } = yield* createAcceptedTask(secondPm, {
          intake: "New work.",
          title: "Billing page",
          request: "Build the page.",
          waitsOn: [api.id],
        });

        // No goals yet: nothing to check against.
        yield* reactor.check;
        assert.deepStrictEqual(yield* goalChecks, []);

        const { goal: billing } = yield* team.goalWrite(director.threadId, {
          title: "결제 출시",
        });
        const { goal: docs } = yield* team.goalWrite(director.threadId, { title: "문서 정리" });
        yield* team.goalLink(director.threadId, {
          goalId: billing.id,
          link: { taskIds: [api.id, page.id] },
        });

        yield* reactor.check;
        const reported = yield* goalChecks;
        assert.lengthOf(reported, 1);
        const first = reported[0]!;
        assert.include(first, `Missing work: goal "문서 정리" (${docs.id}) has no open work.`);
        assert.match(
          first,
          /Blocked: \S+ Billing page \(Second\) for goal "결제 출시" \(\S+\): waits on \S+ Payments API \(Demo\)\./,
        );
        assert.include(first, `(${billing.id})`);
        assert.notInclude(first, "Resolved:");

        // Nothing changed: no new wake.
        yield* reactor.check;
        assert.lengthOf(yield* goalChecks, 1);

        // New open work with no goal shows up, but within ten minutes of the last wake.
        yield* createAcceptedTask(firstPm, {
          intake: "New work.",
          title: "Unrelated cleanup",
          request: "Tidy up.",
        });
        yield* reactor.check;
        assert.lengthOf(yield* goalChecks, 1);

        yield* TestClock.adjust("10 minutes");
        yield* reactor.check;
        const checks = yield* goalChecks;
        assert.lengthOf(checks, 2);
        const second = checks[1]!;
        assert.include(second, "Unrelated cleanup (Demo) serves no goal.");
        // Only the change: the missing work and the blocked path were already reported.
        assert.notInclude(second, "Missing work");
        assert.notInclude(second, "Blocked:");
      }),
    ),
  );
});
