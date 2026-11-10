import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as ProjectTeamService from "./ProjectTeamService.ts";
import { createAcceptedTask, PROJECT_ID, setUpManager, startLead, withTeam } from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;

describe("ProjectTeamService location", () => {
  it.effect(
    "starts a cloud lead in the cloud, keeps the task cloud, and runs its steps there",
    () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const pm = yield* setUpManager;
          const { task: created } = yield* createAcceptedTask(pm, {
            title: "Add hello.sh",
            request: "Add hello.sh.",
            intake: "New work.",
          });

          const { task, leadThreadId } = yield* team.startTask(
            pm,
            { taskId: created.id, location: "cloud" },
            harness.delegate,
          );
          const leadCall = (yield* Ref.get(harness.delegated)).at(-1);
          assert.strictEqual(leadCall?.location, "cloud");
          assert.include(leadCall?.task ?? "", "## Cloud");
          assert.strictEqual(task.location, "cloud");
          assert.strictEqual(
            (yield* team.readTask(pm, { taskId: task.id })).task.location,
            "cloud",
          );
          const reference = (yield* team.attentionSnapshot).projects
            .find((project) => project.projectId === PROJECT_ID)
            ?.tasks.find((entry) => entry.id === task.id);
          assert.strictEqual(reference?.location, "cloud");

          yield* team.delegateStep(
            leadThreadId,
            { role: "review", task: "Review main...HEAD against the criteria." },
            harness.delegate,
          );
          assert.strictEqual((yield* Ref.get(harness.delegated)).at(-1)?.location, "cloud");
        }),
      ),
  );

  it.effect("starts a lead locally by default", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const pm = yield* setUpManager;
        const { task, leadThreadId } = yield* startLead(pm, "Add hello.sh", harness.delegate);
        const leadCall = (yield* Ref.get(harness.delegated)).at(-1);
        assert.strictEqual(leadCall?.location, undefined);
        assert.notInclude(leadCall?.task ?? "", "## Cloud");
        assert.strictEqual(task.location, "local");

        const team = yield* service;
        yield* team.delegateStep(
          leadThreadId,
          { role: "review", task: "Review main...HEAD against the criteria." },
          harness.delegate,
        );
        assert.strictEqual((yield* Ref.get(harness.delegated)).at(-1)?.location, undefined);
      }),
    ),
  );
});
