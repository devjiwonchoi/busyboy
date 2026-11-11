import { assert, describe, it } from "@effect/vitest";
import {
  formatPlanReviewFeedback,
  ProjectId,
  ProjectTaskEventId,
  type ProjectTask,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import {
  approvePlan,
  attentionContext,
  PROJECT_ID,
  SECOND_PROJECT_ID,
  setUpManager,
  setUpWorkspace,
  startLead,
  userSays,
  withTeam,
  writeReadyPlan,
} from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;
const repo = ProjectTeamRepository.ProjectTeamRepository;

const corrections = (projectId: ProjectId = PROJECT_ID) =>
  Effect.flatMap(repo, (repository) => repository.listCorrections({ projectId }));

/** The current time, so a chat message counts as written after the card appeared. */
const now = Effect.map(DateTime.now, DateTime.formatIso);

const askApproval = (lead: ThreadId) =>
  Effect.gen(function* () {
    const team = yield* service;
    yield* writeReadyPlan(lead);
    return yield* team.askUser(lead, {
      context: attentionContext({ action: "Approve the plan?" }),
      kind: "approval",
      question: "Approve the plan?",
    });
  });

/** The user sends plan feedback from the card. */
const requestPlanChanges = (lead: ThreadId, overall: string) =>
  Effect.gen(function* () {
    const team = yield* service;
    const { item } = yield* askApproval(lead);
    const answer = formatPlanReviewFeedback({
      specVersion: item.specVersion,
      comments: [],
      overall,
    });
    yield* team.answerDecision({ projectId: item.projectId, attentionItemId: item.id, answer });
    return { item, answer };
  });

/** Moves a task straight to a stage with a pull request, logging it as the service would. */
const placeTask = (task: ProjectTask, stage: ProjectTask["stage"], prUrl: string) =>
  Effect.gen(function* () {
    const repository = yield* repo;
    const at = yield* now;
    yield* repository.updateTask({ id: task.id, stage, prUrl, now: at });
    yield* repository.appendTaskEvent({
      id: ProjectTaskEventId.make(`event:${task.id}:${stage}`),
      projectId: task.projectId,
      taskId: task.id,
      kind: "stage_changed",
      body: `${task.stage} → ${stage}`,
      actorThreadId: null,
      createdAt: at,
    });
  });

const revertLog = (subject: string) =>
  `abc123\x1f2026-11-04T00:00:00+00:00\x1f${subject}\x1fThis reverts commit def456.\n\x1e\n`;

describe("ProjectTeamService corrections", () => {
  it.effect("records plan feedback from the user, but not approvals or AFK answers", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Hello", harness.delegate);

        // The user asks for changes on the card.
        const { item, answer } = yield* requestPlanChanges(lead, "Smaller, please.");
        const [first] = yield* corrections();
        assert.deepInclude(first, {
          taskId: task.id,
          kind: "plan_changes",
          stage: "plan",
          workKind: "other",
          userText: answer,
          whatDiffered: "Smaller, please.",
          sourceKey: `attention:${item.id}`,
          backfilled: false,
        });

        // The PM relays the user's chat words on the next card.
        const second = yield* askApproval(lead);
        userSays(harness, pm, "웹만 먼저 해 주세요", { createdAt: yield* now });
        yield* team.answerAttention(pm, {
          attentionItemId: second.item.id,
          answer: "웹만 먼저 해 주세요",
        });
        const relayed = yield* corrections();
        assert.strictEqual(relayed.length, 2);
        assert.strictEqual(relayed[1]?.whatDiffered, "웹만 먼저 해 주세요");

        // Approving records nothing.
        yield* approvePlan(lead);
        assert.strictEqual((yield* corrections()).length, 2);

        // Nor does an AFK auto-approval.
        const { leadThreadId: afkLead, task: afkTask } = yield* startLead(
          pm,
          "Away",
          harness.delegate,
        );
        yield* askApproval(afkLead);
        yield* TestClock.adjust("2 minutes");
        yield* team.updateSettings({ projectId: PROJECT_ID, afk: { hours: null } });
        const away = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: afkTask.id });
        assert.strictEqual(away.task.stage, "running");
        assert.strictEqual((yield* corrections()).length, 2);
      }),
    ),
  );

  it.effect("lets the PM record a correction only in the user's own words", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const repository = yield* repo;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Login", harness.delegate);
        yield* approvePlan(lead);

        userSays(harness, pm, "그게 아니라   설정 화면부터 해줘", { id: "msg-1" });
        const recorded = yield* team.recordCorrection(pm, {
          taskId: task.id,
          kind: "direction_change",
          userText: "그게 아니라 설정 화면부터 해줘",
          whatDiffered: "로그인 대신 설정 화면을 먼저",
        });
        assert.isTrue(recorded.recorded);
        assert.deepInclude(recorded.correction, {
          kind: "direction_change",
          stage: "running",
          sourceKey: `chat:msg-1:${task.id}:direction_change`,
        });
        const events = yield* repository.listTaskEvents({ taskId: task.id, limit: 100 });
        assert.isTrue(
          events.some(
            (event) =>
              event.kind === "note" &&
              event.body === "사용자 교정을 기록했어요: 로그인 대신 설정 화면을 먼저",
          ),
        );

        // The same words for the same task are one correction.
        const again = yield* team.recordCorrection(pm, {
          taskId: task.id,
          kind: "direction_change",
          userText: "설정 화면부터 해줘",
          whatDiffered: "설정 화면 먼저",
        });
        assert.isFalse(again.recorded);
        assert.strictEqual((yield* corrections()).length, 1);

        // Words the user never wrote are refused.
        const fabricated = yield* team
          .recordCorrection(pm, {
            taskId: task.id,
            kind: "direction_change",
            userText: "웹은 빼 주세요",
            whatDiffered: "웹 제외",
          })
          .pipe(Effect.flip);
        assert.include(fabricated.message, "the user's own words");

        // A change asked for on a task in review is a pull request correction.
        const { task: reviewed } = yield* startLead(pm, "Billing", harness.delegate);
        yield* placeTask(reviewed, "in_review", "https://github.com/acme/app/pull/3");
        userSays(harness, pm, "PR에서 버튼 색은 파란색으로 바꿔줘");
        const prChange = yield* team.recordCorrection(pm, {
          taskId: reviewed.id,
          kind: "pr_change_request",
          userText: "버튼 색은 파란색으로 바꿔줘",
          whatDiffered: "버튼 색을 파란색으로",
        });
        assert.strictEqual(prChange.correction.stage, "pr");

        // A task lead can't record corrections.
        const byLead = yield* team
          .recordCorrection(lead, {
            taskId: task.id,
            kind: "direction_change",
            userText: "그게 아니라 설정 화면부터 해줘",
            whatDiffered: "x",
          })
          .pipe(Effect.flip);
        assert.include(byLead.message, "not available to a task lead");
        assert.strictEqual((yield* corrections()).length, 2);
      }),
    ),
  );

  it.effect("gives only the Director correction rates, recent corrections and repeats", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { firstPm, director } = yield* setUpWorkspace(harness);
        const { leadThreadId: leadA, task: a } = yield* startLead(
          firstPm,
          "Settings",
          harness.delegate,
        );
        const { leadThreadId: leadB, task: b } = yield* startLead(
          firstPm,
          "Billing",
          harness.delegate,
        );
        yield* requestPlanChanges(leadA, "웹만");
        yield* requestPlanChanges(leadA, "버튼은 그대로");
        yield* approvePlan(leadA);
        // B is approved as written: it passes every stage.
        yield* approvePlan(leadB);

        userSays(harness, director.threadId, "Settings는 다시 모바일 먼저로 가요");
        const recorded = yield* team.recordCorrection(director.threadId, {
          taskId: a.id,
          kind: "direction_change",
          userText: "Settings는 다시 모바일 먼저로 가요",
          whatDiffered: "웹 대신 모바일 먼저",
        });
        assert.strictEqual(recorded.correction.projectId, PROJECT_ID);

        for (const caller of [firstPm, leadA]) {
          const refused = yield* team.correctionsReport(caller, {}).pipe(Effect.flip);
          assert.include(refused.message, "corrections_report is not available");
        }

        const report = yield* team.correctionsReport(director.threadId, {});
        const first = report.rates.find(
          (row) => row.projectId === PROJECT_ID && row.workKind === null,
        )!;
        const stage = (name: string) => first.stages.find((row) => row.stage === name)!;
        assert.deepStrictEqual(stage("plan"), {
          stage: "plan",
          eligible: 2,
          corrected: 1,
          passed: 1,
          rate: 0.5,
        });
        assert.deepInclude(stage("running"), { eligible: 2, corrected: 1, passed: 1 });
        assert.deepInclude(stage("pr"), { eligible: 0, corrected: 0, rate: 0 });
        assert.deepInclude(stage("task"), { eligible: 2, corrected: 1, passed: 1 });
        const second = report.rates.find((row) => row.projectId === SECOND_PROJECT_ID)!;
        assert.deepInclude(
          second.stages.find((row) => row.stage === "task"),
          { eligible: 0 },
        );

        assert.deepStrictEqual(
          report.recent.map((entry) => [entry.kind, entry.title]),
          [
            ["direction_change", "Settings"],
            ["plan_changes", "Settings"],
            ["plan_changes", "Settings"],
          ],
        );
        assert.strictEqual(report.recent[0]?.projectName, "Demo");
        assert.deepStrictEqual(report.repeated, [
          {
            projectId: PROJECT_ID,
            projectName: "Demo",
            workKind: "other",
            stage: "plan",
            count: 2,
            examples: ["버튼은 그대로", "웹만"],
            suggestRule: false,
          },
        ]);

        // A third round on the plan makes it worth a rule.
        const { leadThreadId: leadC } = yield* startLead(firstPm, "Search", harness.delegate);
        yield* requestPlanChanges(leadC, "검색창은 위에");
        const later = yield* team.correctionsReport(director.threadId, { projectId: PROJECT_ID });
        assert.deepInclude(later.repeated[0], { count: 3, suggestRule: true });
        assert.isTrue(later.rates.every((row) => row.projectId === PROJECT_ID));
        assert.strictEqual(b.projectId, PROJECT_ID);
      }),
    ),
  );

  it.effect("records change requests and reverts made on a task's pull request in the app", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { task } = yield* startLead(pm, "Dark mode", harness.delegate);
        yield* placeTask(task, "in_review", "https://github.com/Acme/App/pull/7");

        const review = {
          projectId: PROJECT_ID,
          repository: "acme/app",
          number: 7,
          kind: "pr_change_request",
          userText: "Rename the button\n\nUse 저장 instead.",
        } as const;
        yield* team.recordPullRequestCorrection(review);
        yield* team.recordPullRequestCorrection(review);
        // Another pull request, or a project with no PM, records nothing.
        yield* team.recordPullRequestCorrection({ ...review, number: 8 });
        yield* team.recordPullRequestCorrection({
          ...review,
          projectId: ProjectId.make("project-none"),
        });
        const [change] = yield* corrections();
        assert.deepInclude(change, {
          kind: "pr_change_request",
          stage: "pr",
          userText: review.userText,
          whatDiffered: "Rename the button",
        });
        assert.match(change!.sourceKey, /^review:acme\/app#7:[0-9a-f]{8}$/);

        yield* placeTask(
          { ...task, stage: "in_review" },
          "done",
          "https://github.com/Acme/App/pull/7",
        );
        yield* team.recordPullRequestCorrection({ ...review, kind: "revert", userText: "" });
        // The same revert found on the default branch later stays one row.
        harness.revertLog = () => revertLog('Revert "Add dark mode (#7)" (#9)');
        yield* team.backfillCorrections;
        yield* team.backfillCorrections;
        const all = yield* corrections();
        assert.deepStrictEqual(
          all.map((entry) => [entry.kind, entry.stage, entry.sourceKey.split(":")[0]]),
          [
            ["pr_change_request", "pr", "review"],
            ["revert", "merged", "revert"],
          ],
        );
        assert.deepInclude(all[1], {
          userText: "Reverted in the app",
          whatDiffered: "머지 뒤 되돌림: Dark mode",
          backfilled: false,
        });
      }),
    ),
  );

  it.effect("backfills past corrections once, including reverts on the default branch", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const sql = yield* SqlClient.SqlClient;
        const { firstPm: pm, director } = yield* setUpWorkspace(harness);
        // History from before corrections were recorded.
        const { leadThreadId: lead, task } = yield* startLead(pm, "Profile", harness.delegate);
        const { item } = yield* requestPlanChanges(lead, "사진은 빼고");
        yield* approvePlan(lead);
        yield* team.nudgeTask(pm, {
          taskId: task.id,
          scope: true,
          note: "그게 아니라 프로필 편집부터",
        });
        yield* placeTask(
          { ...task, stage: "running" },
          "in_review",
          "https://github.com/a/b/pull/5",
        );
        yield* team.nudgeTask(pm, {
          taskId: task.id,
          scope: true,
          note: "영어 말고 PR 제목 한국어로",
        });
        // Added scope that doesn't turn the work around is not a correction.
        yield* team.nudgeTask(pm, {
          taskId: task.id,
          scope: true,
          note: "PR 설명에 스크린샷 추가",
        });
        const { task: merged } = yield* startLead(pm, "Theme", harness.delegate);
        yield* placeTask(merged, "done", "https://github.com/a/b/pull/6");
        yield* sql`DELETE FROM project_corrections`;

        harness.revertLog = (root) =>
          root === `/workspace/${PROJECT_ID}`
            ? revertLog("Revert theme").replace("This reverts", "Reverts a/b#6\nThis reverts")
            : null;
        yield* team.backfillCorrections;
        const once = yield* corrections();
        assert.deepStrictEqual(
          once.map((entry) => [entry.kind, entry.userText, entry.backfilled]),
          [
            ["plan_changes", once[0]!.userText, true],
            ["direction_change", "그게 아니라 프로필 편집부터", true],
            ["pr_change_request", "영어 말고 PR 제목 한국어로", true],
            ["revert", "Revert theme", true],
          ],
        );
        assert.strictEqual(once[0]!.sourceKey, `attention:${item.id}`);
        assert.strictEqual(once[3]!.taskId, merged.id);

        yield* team.backfillCorrections;
        assert.strictEqual((yield* corrections()).length, 4);

        const report = yield* team.correctionsReport(director.threadId, {});
        assert.deepStrictEqual(report.backfilled, {
          plan_changes: 1,
          direction_change: 1,
          pr_change_request: 1,
          revert: 1,
        });

        // Notes from after live recording started are the PM's to record, never refilled.
        yield* sql`DELETE FROM project_corrections`;
        yield* sql`UPDATE project_correction_state SET value = '2026-11-01T00:00:00.000Z'`;
        yield* team.backfillCorrections;
        assert.deepStrictEqual(
          (yield* corrections()).map((entry) => [entry.kind, entry.backfilled]),
          [
            ["plan_changes", true],
            // The revert landed after recording started: a new event, not filled history.
            ["revert", false],
          ],
        );
      }),
    ),
  );
});
