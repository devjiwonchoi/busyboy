import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import * as ProjectTeamService from "./ProjectTeamService.ts";
import { createAcceptedTask, PROJECT_ID, readyPlan, setUpManager, withTeam } from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;

const projectSummary = Effect.flatMap(service, (team) =>
  Effect.map(team.attentionSnapshot, (snapshot) =>
    snapshot.projects.find((project) => project.projectId === PROJECT_ID),
  ),
);

describe("ProjectTeamService project map", () => {
  it.effect("carries the direction line and no direction without the memory", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        assert.strictEqual((yield* projectSummary)?.direction, null);

        yield* team.writeMemory(pm, {
          topic: "direction",
          content:
            "Product direction (user, 2026-11-07, updated 2026-11-08):\n- Make the phone the main way to steer the team.\n- Keep it calm.",
        });
        assert.strictEqual(
          (yield* projectSummary)?.direction,
          "Make the phone the main way to steer the team.",
        );
      }),
    ),
  );

  it.effect("streams a fresh snapshot when the PM changes the direction", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const fiber = yield* team.streamAttention.pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        for (let index = 0; index < 50; index++) yield* Effect.yieldNow;
        yield* team.writeMemory(pm, { topic: "direction", content: "Ship the map." });
        for (let index = 0; index < 50; index++) yield* Effect.yieldNow;
        yield* team.deleteMemory(pm, { topic: "direction" });
        const snapshots = Array.from(yield* Fiber.join(fiber));
        assert.deepStrictEqual(
          snapshots.map((snapshot) => snapshot.projects[0]?.direction),
          [null, "Ship the map.", null],
        );
      }),
    ),
  );

  it.effect("shows a goal's criteria as checks that pass once evidence lands", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { task: added } = yield* createAcceptedTask(pm, {
          intake: "New work.",
          title: "Hello",
          request: "Hello.",
        });
        const { leadThreadId: lead, task } = yield* team.startTask(
          pm,
          { taskId: added.id },
          harness.delegate,
        );
        const { task: subtask } = yield* team.createTask(lead, {
          title: "Hello test",
          request: "Goal: a test for hello.sh.\nVerification: the test runs.",
        });

        const read = yield* team.readSpec(lead, {});
        const plan = readyPlan(read.current.spec);
        yield* team.writeSpec(lead, {
          baseVersion: read.current.version,
          spec: {
            ...plan,
            criteria: [
              ...plan.criteria,
              { id: "c2", text: "hello.sh exits 0", provenBy: "a unit test", evidence: null },
            ],
          },
          note: "Plan",
        });
        yield* team.setEvidence(lead, { criterionId: "c1", evidence: "hello.test.sh passed" });

        const checksOf = Effect.map(projectSummary, (summary) => ({
          goal: summary?.tasks.find((candidate) => candidate.id === task.id)?.checks,
          subtask: summary?.tasks.find((candidate) => candidate.id === subtask.id)?.checks,
        }));
        const first = yield* checksOf;
        assert.deepStrictEqual(first.goal, [
          { text: "hello.sh prints hello", passed: true },
          { text: "hello.sh exits 0", passed: false },
        ]);
        assert.strictEqual(first.subtask, null);

        // A new spec version replaces the cached checks.
        yield* team.setEvidence(lead, { criterionId: "c2", evidence: "exit code checked" });
        assert.deepStrictEqual((yield* checksOf).goal, [
          { text: "hello.sh prints hello", passed: true },
          { text: "hello.sh exits 0", passed: true },
        ]);
      }),
    ),
  );
});
