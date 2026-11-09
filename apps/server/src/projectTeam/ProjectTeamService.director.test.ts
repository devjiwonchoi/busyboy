import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { epicStage } from "./director.ts";
import { personaInstructions } from "./persona.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import {
  createAcceptedTask,
  DIRECTOR_PROJECT_ID as DIRECTOR,
  PROJECT_ID,
  SECOND_PROJECT_ID as SECOND,
  setUpWorkspace,
  withTeam,
} from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;

describe("ProjectTeamService Director", () => {
  it.effect("routes tasks to projects, wakes their PMs, and keeps the epic in step", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { firstPm, secondPm, director } = yield* setUpWorkspace(harness);
        assert.strictEqual(director.kind, "director");
        assert.strictEqual(director.settings.persona?.name, "Director");
        assert.deepStrictEqual(yield* team.roleOf(director.threadId), {
          type: "director",
          projectId: DIRECTOR,
        });

        const { task: epic } = yield* createAcceptedTask(director.threadId, {
          intake: "New work.",
          title: "Dark mode everywhere",
          request: "Ship dark mode in both apps.",
        });
        assert.strictEqual(epic.projectId, DIRECTOR);
        const { task: first } = yield* createAcceptedTask(director.threadId, {
          intake: "New work.",
          title: "Dark mode in the first app",
          request: "Add a dark theme.",
          projectId: PROJECT_ID,
          parentTaskId: epic.id,
        });
        const { task: second } = yield* createAcceptedTask(director.threadId, {
          intake: "New work.",
          title: "Dark mode in the second app",
          request: "Add a dark theme.",
          projectId: SECOND,
          parentTaskId: epic.id,
          waitsOn: [first.id],
        });
        assert.strictEqual(first.projectId, PROJECT_ID);
        assert.strictEqual(second.projectId, SECOND);

        const prefix = (yield* team.teamStatus(firstPm, {})).taskKeyPrefix;
        const firstWakes = yield* harness.messagesTo(firstPm);
        assert.isTrue(
          firstWakes.some((text) =>
            text.startsWith(
              `[Director added task] ${prefix}-${first.number} Dark mode in the first app`,
            ),
          ),
          firstWakes.join("\n"),
        );
        const secondWakes = yield* harness.messagesTo(secondPm);
        assert.isTrue(secondWakes.some((text) => text.startsWith("[Director added task]")));

        // The epic follows its subtasks.
        yield* team.updateTask(firstPm, { taskId: first.id, stage: "done" });
        const running = yield* team.readTask(director.threadId, { taskId: epic.id });
        assert.strictEqual(running.task.stage, "running");
        yield* team.updateTask(secondPm, { taskId: second.id, stage: "done" });
        const done = yield* team.readTask(director.threadId, { taskId: epic.id });
        assert.strictEqual(done.task.stage, "done");
      }),
    ),
  );

  it.effect("shows the Director every project, its PM's summary, and open epics", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { firstPm, director } = yield* setUpWorkspace(harness);
        yield* team.writeMemory(firstPm, {
          topic: "summary",
          content: "Web app.\nIn flight: login.\nNext: billing.",
        });
        const { task: epic } = yield* createAcceptedTask(director.threadId, {
          intake: "New work.",
          title: "Shared auth",
          request: "One login across apps.",
        });
        const { task: child } = yield* createAcceptedTask(director.threadId, {
          intake: "New work.",
          title: "Login page",
          request: "Build it.",
          projectId: PROJECT_ID,
          parentTaskId: epic.id,
        });

        const status = yield* team.teamStatus(director.threadId, {});
        const workspace = status.workspace;
        assert.isDefined(workspace);
        assert.deepStrictEqual(
          workspace!.projects.map((project) => project.projectId).toSorted(),
          [PROJECT_ID, SECOND].toSorted(),
        );
        const first = workspace!.projects.find((project) => project.projectId === PROJECT_ID)!;
        assert.strictEqual(first.summary, "Web app.\nIn flight: login.\nNext: billing.");
        assert.deepStrictEqual(
          first.openTasks.map((task) => task.id),
          [child.id],
        );
        assert.strictEqual(first.statusCounts.todo, 1);
        assert.strictEqual(workspace!.epics.length, 1);
        assert.strictEqual(workspace!.epics[0]!.task.id, epic.id);
        assert.deepStrictEqual(
          workspace!.epics[0]!.children.map((entry) => [entry.key, entry.status]),
          [[`${first.taskKeyPrefix}-${child.number}`, "todo"]],
        );

        // A PM's own status has no workspace section.
        assert.isUndefined((yield* team.teamStatus(firstPm, {})).workspace);
        // The Director finds tasks in every project.
        const found = yield* team.searchTasks(director.threadId, { query: "Login page" });
        assert.deepStrictEqual(
          found.tasks.map((task) => task.id),
          [child.id],
        );
      }),
    ),
  );

  it.effect("keeps each role to its own lane", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { firstPm, director } = yield* setUpWorkspace(harness);
        const { task: epic } = yield* createAcceptedTask(director.threadId, {
          intake: "New work.",
          title: "Epic",
          request: "Spans projects.",
        });

        const start = yield* Effect.flip(
          team.startTask(director.threadId, { taskId: epic.id }, harness.delegate),
        );
        assert.include(start.message, "not available to the Director");

        const crossProject = yield* Effect.flip(
          createAcceptedTask(firstPm, {
            intake: "New work.",
            title: "Elsewhere",
            request: "No.",
            projectId: SECOND,
          }),
        );
        assert.include(crossProject.message, "own project");

        const toDirector = yield* Effect.flip(
          createAcceptedTask(director.threadId, {
            intake: "New work.",
            title: "Bad",
            request: "No PM there.",
            projectId: ProjectId.make("project-missing"),
          }),
        );
        assert.include(toDirector.message, "has no PM");

        const epicStageChange = yield* Effect.flip(
          team.updateTask(director.threadId, { taskId: epic.id, stage: "running" }),
        );
        assert.include(epicStageChange.message, "follows its subtasks");
        const cancelled = yield* team.updateTask(director.threadId, {
          taskId: epic.id,
          stage: "cancelled",
        });
        assert.strictEqual(cancelled.task.stage, "cancelled");

        const longSummary = yield* Effect.flip(
          team.writeMemory(firstPm, { topic: "summary", content: "1\n2\n3\n4\n5\n6" }),
        );
        assert.include(longSummary.message, "at most 5 lines");
      }),
    ),
  );
});

describe("epicStage", () => {
  it("adds up an epic's subtasks", () => {
    assert.strictEqual(epicStage([]), "inbox");
    assert.strictEqual(epicStage(["inbox", "inbox"]), "inbox");
    assert.strictEqual(epicStage(["done", "inbox"]), "running");
    assert.strictEqual(epicStage(["planning", "inbox"]), "running");
    assert.strictEqual(epicStage(["blocked", "running"]), "blocked");
    assert.strictEqual(epicStage(["done", "cancelled"]), "done");
    assert.strictEqual(epicStage(["cancelled"]), "cancelled");
  });
});

describe("personaInstructions", () => {
  const persona = { name: "Remy", avatar: { kind: "emoji", emoji: "🦊" }, voice: "chill" } as const;

  it("gives a PM the Director's workspace preferences, read-only", () => {
    const text = personaInstructions(persona, [], undefined, {
      kind: "pm",
      workspacePreferences: "- Korean in, Korean out.",
    });
    assert.include(text, "### Workspace preferences (from the Director)");
    assert.include(text, "read-only for you");
    assert.include(text, "- Korean in, Korean out.");
    assert.include(text, "## BusyBoy project manager");
  });

  it("gives the Director its own instructions and no preferences copy", () => {
    const text = personaInstructions(persona, [], undefined, {
      kind: "director",
      workspacePreferences: "- Korean in, Korean out.",
    });
    assert.include(text, "## BusyBoy Director");
    assert.notInclude(text, "## BusyBoy project manager");
    assert.notInclude(text, "Workspace preferences (from the Director)");
  });
});
