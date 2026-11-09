import { assert, describe, it } from "@effect/vitest";
import { ProjectTaskId, WorkspaceGoalId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectTeamService from "./ProjectTeamService.ts";
import {
  createAcceptedTask,
  DIRECTOR_PROJECT_ID,
  PROJECT_ID,
  SECOND_PROJECT_ID,
  setUpWorkspace,
  startLead,
  withTeam,
} from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;

const directorSummary = Effect.gen(function* () {
  const team = yield* service;
  const snapshot = yield* team.attentionSnapshot;
  return snapshot.projects.find((summary) => summary.projectId === DIRECTOR_PROJECT_ID)!;
});

describe("ProjectTeamService workspace goals", () => {
  it.effect("adds, edits and links goals, and shows them in team_status and the snapshot", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { firstPm, secondPm, director } = yield* setUpWorkspace(harness);
        const { task: secondTask } = yield* createAcceptedTask(secondPm, {
          intake: "New work.",
          title: "Billing page",
          request: "Build billing.",
        });
        const { task: stray } = yield* createAcceptedTask(firstPm, {
          intake: "New work.",
          title: "Unrelated cleanup",
          request: "Tidy up.",
        });

        const { goal: added } = yield* team.goalWrite(director.threadId, {
          title: "이번 달 결제 출시",
          detail: "카드 결제부터",
        });
        assert.strictEqual(added.title, "이번 달 결제 출시");
        assert.strictEqual(added.detail, "카드 결제부터");
        assert.strictEqual(added.status, "active");
        assert.strictEqual(added.position, 0);
        const { goal: second } = yield* team.goalWrite(director.threadId, { title: "문서 정리" });
        assert.strictEqual(second.position, 1);

        const { goal: edited } = yield* team.goalWrite(director.threadId, {
          goalId: added.id,
          title: "결제 출시",
          detail: null,
        });
        assert.strictEqual(edited.title, "결제 출시");
        assert.strictEqual(edited.detail, null);
        assert.strictEqual(edited.status, "active");

        // The Director's own project is the Director's; the task lives in the second project.
        const { goal: linked } = yield* team.goalLink(director.threadId, {
          goalId: added.id,
          link: { projectIds: [PROJECT_ID], taskIds: [secondTask.id] },
        });
        assert.deepStrictEqual(linked.links, [
          { projectId: PROJECT_ID, taskId: null },
          { projectId: SECOND_PROJECT_ID, taskId: secondTask.id },
        ]);
        // Linking again changes nothing.
        const { goal: relinked } = yield* team.goalLink(director.threadId, {
          goalId: added.id,
          link: { taskIds: [secondTask.id] },
        });
        assert.deepStrictEqual(relinked.links, linked.links);

        const workspace = (yield* team.teamStatus(director.threadId, {})).workspace!;
        assert.deepStrictEqual(
          workspace.goals.map((goal) => [goal.title, goal.links.length]),
          [
            ["결제 출시", 2],
            ["문서 정리", 0],
          ],
        );
        assert.deepStrictEqual(workspace.alignment.goals, [
          {
            goalId: added.id,
            projectIds: [PROJECT_ID, SECOND_PROJECT_ID],
            taskIds: [stray.id, secondTask.id],
          },
          { goalId: second.id, projectIds: [], taskIds: [] },
        ]);
        assert.deepStrictEqual(workspace.alignment.goalsWithoutOpenWork, [second.id]);
        assert.deepStrictEqual(workspace.alignment.unalignedTasks, []);

        const summary = yield* directorSummary;
        assert.deepStrictEqual(summary.goals, workspace.goals);
        assert.deepStrictEqual(summary.goalAlignment, workspace.alignment);
        // PM summaries carry no goals.
        const snapshot = yield* team.attentionSnapshot;
        const pmSummary = snapshot.projects.find((entry) => entry.projectId === PROJECT_ID)!;
        assert.isUndefined(pmSummary.goals);

        // Unlinking the project leaves its task unaligned; archiving drops the goal from alignment.
        yield* team.goalLink(director.threadId, {
          goalId: added.id,
          unlink: { projectIds: [PROJECT_ID] },
        });
        yield* team.goalWrite(director.threadId, { goalId: second.id, status: "archived" });
        const after = (yield* directorSummary).goalAlignment!;
        assert.deepStrictEqual(
          after.goals.map((goal) => goal.goalId),
          [added.id],
        );
        assert.deepStrictEqual(after.unalignedTasks, [{ projectId: PROJECT_ID, taskId: stray.id }]);

        // A deleted project's work drops out of both views alike.
        harness.projects.set(SECOND_PROJECT_ID, {
          ...harness.projects.get(SECOND_PROJECT_ID)!,
          deletedAt: "2026-11-05T00:00:00.000Z",
        });
        const deletedView = (yield* team.teamStatus(director.threadId, {})).workspace!.alignment;
        assert.deepStrictEqual(
          deletedView.goals.map((goal) => goal.taskIds),
          [[]],
        );
        assert.deepStrictEqual((yield* directorSummary).goalAlignment, deletedView);
      }),
    ),
  );

  it.effect("keeps goals to the Director and checks what they link", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { firstPm, director } = yield* setUpWorkspace(harness);
        const { goal } = yield* team.goalWrite(director.threadId, { title: "목표" });

        const fromPm = yield* Effect.flip(team.goalWrite(firstPm, { title: "PM 목표" }));
        assert.include(fromPm.message, "goal_write is not available to a PM");
        const linkFromPm = yield* Effect.flip(
          team.goalLink(firstPm, { goalId: goal.id, link: { projectIds: [PROJECT_ID] } }),
        );
        assert.include(linkFromPm.message, "goal_link is not available to a PM");
        const { leadThreadId: lead } = yield* startLead(firstPm, "Lead work", harness.delegate);
        const fromLead = yield* Effect.flip(team.goalWrite(lead, { title: "리드 목표" }));
        assert.include(fromLead.message, "not available to a task lead");

        const noTitle = yield* Effect.flip(team.goalWrite(director.threadId, {}));
        assert.include(noTitle.message, "needs a title");
        const missingGoal = yield* Effect.flip(
          team.goalWrite(director.threadId, {
            goalId: WorkspaceGoalId.make("goal:missing"),
            title: "x",
          }),
        );
        assert.include(missingGoal.message, "was not found");
        const missingTask = yield* Effect.flip(
          team.goalLink(director.threadId, {
            goalId: goal.id,
            link: { taskIds: [ProjectTaskId.make("task:missing")] },
          }),
        );
        assert.include(missingTask.message, "was not found");
        const empty = yield* Effect.flip(team.goalLink(director.threadId, { goalId: goal.id }));
        assert.include(empty.message, "needs projects or tasks");
      }),
    ),
  );
});
