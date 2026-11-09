import { assert, describe, it } from "@effect/vitest";
import { ProjectTaskId, WorkspaceGoalId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";

import * as ProjectTeamService from "./ProjectTeamService.ts";
import {
  attentionContext,
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

  it.effect("keeps the Director's briefing to one line and shows it in its summary", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { firstPm, director } = yield* setUpWorkspace(harness);
        assert.strictEqual((yield* directorSummary).briefing, null);

        const twoLines = yield* Effect.flip(
          team.writeMemory(director.threadId, {
            topic: "briefing",
            content: "폰 목표는 결정 1건에 막혀 있어요\n결제는 순항 중",
          }),
        );
        assert.include(twoLines.message, "holds one line");

        yield* team.writeMemory(director.threadId, {
          topic: "briefing",
          content: "폰 목표는 푸시 알림 결정 1건에 막혀 있어요\n",
        });
        assert.strictEqual(
          (yield* directorSummary).briefing,
          "폰 목표는 푸시 알림 결정 1건에 막혀 있어요",
        );
        // A PM's own "briefing" topic is just memory: no limit and no field.
        yield* team.writeMemory(firstPm, { topic: "briefing", content: "a\nb" });
        const pmSummary = (yield* team.attentionSnapshot).projects.find(
          (entry) => entry.projectId === PROJECT_ID,
        )!;
        assert.isUndefined(pmSummary.briefing);

        yield* team.deleteMemory(director.threadId, { topic: "briefing" });
        assert.strictEqual((yield* directorSummary).briefing, null);
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

  it.effect("links the Director's goal proposal to its goal once the user adds it", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const { firstPm, director } = yield* setUpWorkspace(harness);
        const { goal } = yield* team.goalWrite(director.threadId, { title: "문서 정리" });
        const propose = (title: string) =>
          team.createTask(director.threadId, {
            projectId: SECOND_PROJECT_ID,
            title,
            request: `${title}.`,
            intake: "Goal has no open work.",
            goal: "문서가 정리된다",
            verification: "문서를 연다",
            goalId: goal.id,
          });

        const { task: proposed } = yield* propose("Write the docs");
        const [card] = yield* repository.listOpenAttentionItems({
          projectId: DIRECTOR_PROJECT_ID,
          taskId: proposed.id,
        });
        assert.strictEqual(card?.kind, "proposal");
        const dismiss = yield* Effect.flip(
          team.dismissAttention(director.threadId, {
            attentionItemId: card!.id,
            reason: "No longer needed.",
          }),
        );
        assert.include(dismiss.message, "Only the user can resolve proposals");
        // Until the user adds it, the goal still has no open work.
        assert.deepStrictEqual((yield* directorSummary).goalAlignment!.goalsWithoutOpenWork, [
          goal.id,
        ]);

        yield* team.answerDecision({
          projectId: DIRECTOR_PROJECT_ID,
          attentionItemId: card!.id,
          answer: "태스크로 추가",
        });
        const alignment = (yield* directorSummary).goalAlignment!;
        assert.deepStrictEqual(alignment.goals, [
          { goalId: goal.id, projectIds: [SECOND_PROJECT_ID], taskIds: [proposed.id] },
        ]);
        assert.deepStrictEqual(alignment.goalsWithoutOpenWork, []);

        // A dropped proposal leaves no link behind.
        const { task: dropped } = yield* propose("Write more docs");
        const [dropCard] = yield* repository.listOpenAttentionItems({
          projectId: DIRECTOR_PROJECT_ID,
          taskId: dropped.id,
        });
        yield* team.answerDecision({
          projectId: DIRECTOR_PROJECT_ID,
          attentionItemId: dropCard!.id,
          answer: "빼기",
        });
        const { workspace } = yield* team.teamStatus(director.threadId, {});
        assert.deepStrictEqual(workspace!.goals[0]!.links, [
          { projectId: SECOND_PROJECT_ID, taskId: proposed.id },
        ]);

        const fromPm = yield* Effect.flip(
          team.createTask(firstPm, {
            title: "PM work",
            request: "Do it.",
            intake: "New.",
            goal: "끝",
            verification: "확인",
            goalId: goal.id,
          }),
        );
        assert.include(fromPm.message, "Only the Director links proposals to goals");
        yield* team.goalWrite(director.threadId, { goalId: goal.id, status: "done" });
        const toDone = yield* Effect.flip(propose("Late docs"));
        assert.include(toDone.message, "is done");
      }),
    ),
  );

  it.effect("nudges a PM about a stuck task at most once a day", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { firstPm, director } = yield* setUpWorkspace(harness);
        const { task } = yield* createAcceptedTask(firstPm, {
          intake: "New work.",
          title: "Payments API",
          request: "Build the API.",
        });
        const nudges = harness
          .messagesTo(firstPm)
          .pipe(Effect.map((texts) => texts.filter((text) => text.startsWith("[디렉터]"))));
        const nudge = () =>
          team.pmNudge(director.threadId, {
            projectId: PROJECT_ID,
            taskId: task.id,
            message: "결제 출시 목표가 이 일을 기다립니다. 시작해 주세요.",
          });

        assert.deepStrictEqual(yield* nudge(), { status: "sent", nextAllowedAt: null });
        const [sent] = yield* nudges;
        assert.match(sent!, /^\[디렉터\] \S+ Payments API\n결제 출시 목표가 이 일을 기다립니다/);

        const again = yield* nudge();
        assert.strictEqual(again.status, "skipped");
        assert.strictEqual(again.nextAllowedAt, "2026-11-05T00:00:00.000Z");
        assert.lengthOf(yield* nudges, 1);

        // Answering a card about another task does not reset this task's limit.
        const { task: other } = yield* createAcceptedTask(firstPm, {
          intake: "New work.",
          title: "Docs",
          request: "Write the docs.",
        });
        const { item } = yield* team.askUser(director.threadId, {
          context: attentionContext({ action: "Which goal?" }),
          kind: "decision",
          taskId: other.id,
          question: "Which goal?",
        });
        yield* TestClock.adjust("1 minute");
        yield* team.answerDecision({
          projectId: DIRECTOR_PROJECT_ID,
          attentionItemId: item.id,
          answer: "Documentation.",
        });
        assert.strictEqual((yield* nudge()).status, "skipped");
        assert.lengthOf(yield* nudges, 1);

        yield* TestClock.adjust("24 hours");
        assert.strictEqual((yield* nudge()).status, "sent");
        assert.lengthOf(yield* nudges, 2);

        const fromPm = yield* Effect.flip(
          team.pmNudge(firstPm, { projectId: PROJECT_ID, taskId: task.id, message: "x" }),
        );
        assert.include(fromPm.message, "pm_nudge is not available to a PM");
        const wrongProject = yield* Effect.flip(
          team.pmNudge(director.threadId, {
            projectId: SECOND_PROJECT_ID,
            taskId: task.id,
            message: "x",
          }),
        );
        assert.include(wrongProject.message, "is not in project");
      }),
    ),
  );

  it.effect("shows the Director's decision card in its chat and answers the Director", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { firstPm, director } = yield* setUpWorkspace(harness);
        const { task } = yield* createAcceptedTask(firstPm, {
          intake: "New work.",
          title: "Payments API",
          request: "Build the API.",
        });
        yield* team.pmNudge(director.threadId, {
          projectId: PROJECT_ID,
          taskId: task.id,
          message: "막혔어요.",
        });

        const { item } = yield* team.askUser(director.threadId, {
          context: attentionContext({ action: "결제 API를 연결할 목표를 정합니다" }),
          kind: "decision",
          taskId: task.id,
          question: "결제 API는 어느 목표인가요?\n목표가 없는 열린 일입니다.",
          options: ["결제 출시 (Recommended)", "문서 정리"],
        });
        assert.deepStrictEqual(
          item.context,
          attentionContext({ action: "결제 API를 연결할 목표를 정합니다" }),
        );
        assert.strictEqual(item.projectId, DIRECTOR_PROJECT_ID);
        assert.strictEqual(item.askerThreadId, director.threadId);
        const card = (yield* directorSummary).decisionCards.find(
          (entry) => entry.item.id === item.id,
        );
        assert.strictEqual(card?.taskTitle, "Payments API");
        assert.deepStrictEqual(card?.item.context, item.context);
        // The PM's chat does not show it.
        const pmSummary = (yield* team.attentionSnapshot).projects.find(
          (entry) => entry.projectId === PROJECT_ID,
        )!;
        assert.isFalse(pmSummary.decisionCards.some((entry) => entry.item.id === item.id));

        yield* TestClock.adjust("1 minute");
        yield* team.answerDecision({
          projectId: DIRECTOR_PROJECT_ID,
          attentionItemId: item.id,
          answer: "결제 출시 (Recommended)",
        });
        const relayed = (yield* Ref.get(harness.sent)).filter(
          (input) => input.threadId === director.threadId,
        );
        assert.lengthOf(relayed, 1);
        assert.include(relayed[0]!.text, "결제 출시 (Recommended)");

        // The answer is news, so the Director may pass it on the same day.
        const relay = yield* team.pmNudge(director.threadId, {
          projectId: PROJECT_ID,
          taskId: task.id,
          message: "사용자가 결제 출시 목표로 정했습니다.",
        });
        assert.strictEqual(relay.status, "sent");

        // The Director closes its own card when it no longer needs the answer.
        const { item: stale } = yield* team.askUser(director.threadId, {
          context: attentionContext({ action: "아직 필요한가요?" }),
          kind: "decision",
          taskId: task.id,
          question: "아직 필요한가요?",
        });
        const closed = yield* team.dismissAttention(director.threadId, {
          attentionItemId: stale.id,
          reason: "PM이 이미 처리함",
        });
        assert.isNotNull(closed.item.supersededAt);

        const approval = yield* Effect.flip(
          team.askUser(director.threadId, {
            context: attentionContext({ action: "OK?" }),
            kind: "approval",
            taskId: task.id,
            question: "OK?",
          }),
        );
        assert.include(approval.message, "only for decisions");
        const noTask = yield* Effect.flip(
          team.askUser(director.threadId, {
            context: attentionContext({ action: "어느 쪽?" }),
            kind: "decision",
            question: "어느 쪽?",
          }),
        );
        assert.include(noTask.message, "needs taskId");
      }),
    ),
  );
});
