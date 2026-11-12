import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_TASK_STEP_MODELS,
  OrchestratorMcpFailure,
  PLAN_APPROVAL_START,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { PLAN_CHECK_FAILED_PREFIX } from "./ProjectTeamService.ts";
import {
  askPlanApproval,
  attentionContext,
  checkerDelegate,
  leadTask,
  passPlanCheck,
  requestApproval,
  PROJECT_ID,
  approvePlan,
  readyPlan,
  reviewClean,
  setSize,
  setUpManager,
  START,
  startLead,
  userSays,
  withTeam,
  writeReadyPlan,
} from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;

/** The lead asks for approval and the plan checker passes the plan, raising the card. */
const askApproval = (lead: ThreadId) => askPlanApproval(lead);

describe("ProjectTeamService plan gates", () => {
  it.effect("tells a lead to write what the user reads in the user's language", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const promptFor = (title: string, request: string) =>
          Effect.gen(function* () {
            const { task } = yield* team.createTaskForUser({
              projectId: PROJECT_ID,
              startPlanning: false,
              title,
              context: request,
            });
            yield* team.startTask(pm, { taskId: task.id }, harness.delegate);
            return (yield* Ref.get(harness.delegated)).at(-1)?.task ?? "";
          });
        const rule = "Write everything the user reads in Korean";

        // The user's own request decides.
        assert.include(yield* promptFor("Sort", "사이드바 정렬 고쳐줘"), rule);
        // An English request and English chat need no rule.
        userSays(harness, pm, "Fix the sidebar order, please.");
        assert.notInclude(yield* promptFor("Order", "Fix the sidebar order."), "## Language");
        // A request the PM wrote in English follows the user's chat.
        userSays(harness, pm, "난 한글로 물어보는데 왜 영어로 보여줘?");
        userSays(harness, pm, "플랜은 한국어로 보여줘");
        const fromChat = yield* promptFor("Plans", "Show plans in the user's language.");
        assert.include(fromChat, `## Language\nThe user writes in Korean. ${rule}`);
        assert.include(
          fromChat,
          "Keep code, identifiers, file paths, commit messages and pull request text in English.",
        );
      }),
    ),
  );

  it.effect("refuses plan approval until the plan meets the Definition of Ready", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Hello", harness.delegate);

        const notReady = yield* askApproval(lead).pipe(Effect.flip);
        assert.include(notReady.message, "The plan in spec v1 is not ready for review");
        assert.include(notReady.message, "- goal: describe the end state the user will see");
        assert.include(notReady.message, "- files: list every file");
        const stillPlanning = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.strictEqual(stillPlanning.task.stage, "planning");
        assert.deepStrictEqual(stillPlanning.openAttention, []);

        // Links to ids the spec lacks are refused on write.
        const read = yield* team.readSpec(lead, {});
        const plan = readyPlan(read.current.spec);
        const broken = yield* team
          .writeSpec(lead, {
            baseVersion: read.current.version,
            spec: { ...plan, todos: plan.todos.map((todo) => ({ ...todo, criteria: ["c9"] })) },
            note: "Plan",
          })
          .pipe(Effect.flip);
        assert.include(broken.message, "todo t1 lists unknown criteria: c9");

        yield* writeReadyPlan(lead);
        const { item } = yield* askApproval(lead);
        assert.strictEqual(item.specVersion, 2);
        assert.deepStrictEqual(item.context, attentionContext({ action: "Approve the plan?" }));
        const awaiting = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.deepStrictEqual(awaiting.openAttention[0]?.context, item.context);
        const card = (yield* team.attentionSnapshot).projects
          .flatMap((project) => project.decisionCards)
          .find((entry) => entry.item.id === item.id);
        assert.deepStrictEqual(card?.item.context, item.context);
      }),
    ),
  );

  it.effect("sends a plan with an empty gate back to the lead without a card", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Hello", harness.delegate);
        const read = yield* team.readSpec(lead, {});
        yield* team.writeSpec(lead, {
          baseVersion: read.current.version,
          spec: { ...readyPlan(read.current.spec), why: "", risks: "" },
          note: "Plan",
        });

        // Without a size, the server cannot tell which gates the plan needs.
        const noSize = yield* askApproval(lead).pipe(Effect.flip);
        assert.include(noSize.message, "- size: set the task size with task_update(size)");

        // A small task's light plan needs why but not risks.
        yield* setSize(lead, "small");
        const light = yield* askApproval(lead).pipe(Effect.flip);
        assert.include(light.message, 'gate why "왜" (why)');
        assert.notInclude(light.message, "gate risks");

        // A medium task's full plan needs risks too.
        yield* setSize(lead, "medium");
        const full = yield* askApproval(lead).pipe(Effect.flip);
        assert.include(full.message, 'gate risks "위험" (risks)');

        const detail = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.strictEqual(detail.task.stage, "planning");
        assert.deepStrictEqual(detail.openAttention, []);
      }),
    ),
  );

  it.effect("starts only on an approved plan and goes back to work from review", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Hello", harness.delegate);

        for (const caller of [lead, pm]) {
          const refused = yield* team
            .updateTask(caller, { taskId: task.id, stage: "running" })
            .pipe(Effect.flip);
          assert.include(refused.message, "#1 has no approved plan yet");
        }
        // Feedback is not an approval.
        yield* writeReadyPlan(lead);
        const { item } = yield* askApproval(lead);
        yield* team.answerDecision({
          projectId: PROJECT_ID,
          attentionItemId: item.id,
          answer: "Request changes\n\nOverall:\nSmaller.",
        });
        const afterFeedback = yield* team.updateTask(lead, { stage: "running" }).pipe(Effect.flip);
        assert.include(afterFeedback.message, "no approved plan");

        yield* approvePlan(lead);
        const running = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.strictEqual(running.task.stage, "running");

        // In Review needs a pull request and evidence on every criterion.
        const noPr = yield* team.updateTask(lead, { stage: "in_review" }).pipe(Effect.flip);
        assert.include(noPr.message, "needs a pull request for In Review");
        const unproven = yield* team
          .updateTask(lead, { stage: "in_review", prUrl: "https://github.com/acme/app/pull/1" })
          .pipe(Effect.flip);
        assert.include(unproven.message, "success criteria without evidence: c1");

        const unknown = yield* team
          .setEvidence(lead, { criterionId: "c9", evidence: "x" })
          .pipe(Effect.flip);
        assert.include(unknown.message, "no criterion c9");
        const proven = yield* team.setEvidence(lead, {
          criterionId: "c1",
          evidence: "hello.test.sh passed",
        });
        assert.strictEqual(proven.current.spec.criteria[0]?.evidence, "hello.test.sh passed");
        yield* reviewClean(lead);
        const review = yield* team.updateTask(lead, {
          stage: "in_review",
          prUrl: "https://github.com/acme/app/pull/1",
        });
        assert.strictEqual(review.task.stage, "in_review");

        // Fixing the pull request takes it back to work without a new approval.
        const back = yield* team.updateTask(lead, { stage: "running" });
        assert.strictEqual(back.task.stage, "running");
      }),
    ),
  );

  it.effect("lets a task planned before criteria existed reach review with a pull request", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead } = yield* startLead(pm, "Legacy", harness.delegate);
        yield* reviewClean(lead);
        const review = yield* team.updateTask(lead, {
          stage: "in_review",
          prUrl: "https://github.com/acme/app/pull/2",
        });
        assert.strictEqual(review.task.stage, "in_review");
      }),
    ),
  );

  it.effect("needs a clean self-review of the current HEAD for In Review", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead } = yield* startLead(pm, "Review gate", harness.delegate);
        harness.addThread(lead).worktreePath = "/worktrees/review-gate";
        let head = "aaa1111";
        harness.worktreeHead = (worktreePath) =>
          worktreePath === "/worktrees/review-gate" ? head : null;
        yield* approvePlan(lead);
        yield* team.setEvidence(lead, { criterionId: "c1", evidence: "hello.test.sh passed" });
        const toReview = {
          stage: "in_review",
          prUrl: "https://github.com/acme/app/pull/3",
        } as const;

        const noReview = yield* team.updateTask(lead, toReview).pipe(Effect.flip);
        assert.include(noReview.message, "has no self-review yet");

        const wrongHead = yield* team
          .setReview(lead, { clean: true, findings: "", head: "bbb2222" })
          .pipe(Effect.flip);
        assert.include(wrongHead.message, "HEAD is aaa1111");
        const noFindings = yield* team
          .setReview(lead, { clean: false, findings: " ", head })
          .pipe(Effect.flip);
        assert.include(noFindings.message, "needs its findings");

        yield* team.setReview(lead, { clean: false, findings: "Unused import", head });
        const notClean = yield* team.updateTask(lead, toReview).pipe(Effect.flip);
        assert.include(notClean.message, "latest self-review is not clean");

        yield* reviewClean(lead, head);
        head = "ccc3333";
        const stale = yield* team.updateTask(lead, toReview).pipe(Effect.flip);
        assert.include(stale.message, "covers aaa1111, but HEAD is now ccc3333");

        yield* reviewClean(lead, head);
        const shipped = yield* team.updateTask(lead, toReview);
        assert.strictEqual(shipped.task.stage, "in_review");
        assert.deepStrictEqual(shipped.task.review?.head, "ccc3333");
      }),
    ),
  );

  it.effect("counts Iterate and Ship rounds", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Rounds", harness.delegate);
        const rounds = Effect.map(
          team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id }),
          ({ task }) => [task.iterateRound, task.shipRound],
        );
        assert.deepStrictEqual(yield* rounds, [0, 0]);

        yield* approvePlan(lead);
        assert.deepStrictEqual(yield* rounds, [1, 0]);
        yield* team.setEvidence(lead, { criterionId: "c1", evidence: "hello.test.sh passed" });

        // Findings start the next Iterate round.
        yield* team.setReview(lead, { clean: false, findings: "Missing test", head: "a1" });
        assert.deepStrictEqual(yield* rounds, [2, 0]);
        // Being blocked and resuming is the same round.
        yield* team.updateTask(lead, { stage: "blocked" });
        yield* team.updateTask(lead, { stage: "running" });
        assert.deepStrictEqual(yield* rounds, [2, 0]);

        yield* reviewClean(lead, "a2");
        const toReview = {
          stage: "in_review",
          prUrl: "https://github.com/acme/app/pull/4",
        } as const;
        yield* team.updateTask(lead, toReview);
        assert.deepStrictEqual(yield* rounds, [2, 1]);

        // Findings in Ship send the task back to Iterate once.
        const back = yield* team.setReview(lead, {
          clean: false,
          findings: "CI fails",
          head: "a2",
        });
        assert.strictEqual(back.task.stage, "running");
        assert.deepStrictEqual(yield* rounds, [3, 1]);

        // Coming back to In Review is the same Ship round; the watched pull request's
        // failures and comments start the next ones.
        yield* reviewClean(lead, "a3");
        const shipped = yield* team.updateTask(lead, toReview);
        assert.deepStrictEqual([shipped.task.iterateRound, shipped.task.shipRound], [3, 1]);
        const brief = yield* team.listTasks(pm, {});
        const row = brief.tasks.find((candidate) => candidate.id === task.id);
        assert.deepStrictEqual([row?.phase, row?.iterateRound, row?.shipRound], ["ship", 3, 1]);
      }),
    ),
  );

  it.effect("skips only the card whose spec no longer decodes, keeping the summary", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const sql = yield* SqlClient.SqlClient;
        const pm = yield* setUpManager;
        const healthy = yield* startLead(pm, "Healthy", harness.delegate);
        const broken = yield* startLead(pm, "Broken", harness.delegate);
        yield* writeReadyPlan(healthy.leadThreadId);
        yield* writeReadyPlan(broken.leadThreadId);
        const healthyCard = yield* askApproval(healthy.leadThreadId);
        const brokenCard = yield* askApproval(broken.leadThreadId);

        yield* sql`
          UPDATE project_task_spec_versions SET spec_json = '{not json'
          WHERE task_id = ${broken.task.id}
        `;
        const warnings: Array<unknown> = [];
        const snapshot = yield* team.attentionSnapshot.pipe(
          Effect.provide(Logger.layer([Logger.make(({ message }) => void warnings.push(message))])),
        );

        const cards = snapshot.projects[0]?.decisionCards.map((card) => card.item.id) ?? [];
        assert.include(cards, healthyCard.item.id);
        assert.notInclude(cards, brokenCard.item.id);
        assert.isTrue(
          warnings.some((message) => JSON.stringify(message).includes("decision card")),
        );
      }),
    ),
  );

  it.effect("closes an approval card once the spec moves past its version", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Hello", harness.delegate);
        const detail = () => team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        const toLead = () =>
          Effect.map(Ref.get(harness.sent), (sent) =>
            sent.filter((input) => input.threadId === lead).map((input) => input.text),
          );

        yield* writeReadyPlan(lead);
        const first = yield* askApproval(lead);
        assert.strictEqual(first.item.specVersion, 2);

        // The user edits the spec: the card closes, the task plans again, the lead hears it.
        const v2 = (yield* detail()).versions.at(-1)!;
        yield* team.updateTaskSpec({
          projectId: PROJECT_ID,
          taskId: task.id,
          baseVersion: 2,
          spec: { ...v2.spec, nonGoals: "No redesign." },
        });
        const afterEdit = yield* detail();
        assert.deepStrictEqual(afterEdit.openAttention, []);
        assert.strictEqual(afterEdit.task.stage, "planning");
        const told = (yield* toLead()).at(-1) ?? "";
        assert.include(told, "[Spec changed] The user changed the spec of #1 Hello to v3");
        assert.include(told, "your plan (spec v2) waited for approval");

        // A PM write does the same.
        const second = yield* askApproval(lead);
        const v3 = yield* team.readSpec(pm, { taskId: task.id });
        yield* team.writeSpec(pm, {
          taskId: task.id,
          baseVersion: v3.current.version,
          spec: { ...v3.current.spec, background: "Also print the date." },
          note: "Scope from the user",
        });
        assert.deepStrictEqual((yield* detail()).openAttention, []);
        assert.include((yield* toLead()).at(-1) ?? "", "[Spec changed] The PM changed the spec");
        const closed = (yield* team.attentionSnapshot).projects[0]?.decisionCards.find(
          (card) => card.item.id === second.item.id,
        );
        assert.isNotNull(closed?.item.supersededAt ?? null);

        // So does a restore.
        yield* askApproval(lead);
        yield* team.restoreTaskSpec({ projectId: PROJECT_ID, taskId: task.id, version: 2 });
        assert.deepStrictEqual((yield* detail()).openAttention, []);
        assert.strictEqual((yield* detail()).task.stage, "planning");

        // The lead's own revision closes its card quietly; checking a todo leaves it open.
        const quiet = (yield* toLead()).length;
        const card = yield* askApproval(lead);
        yield* team.setTodo(lead, { todoId: "t1", done: true });
        assert.deepStrictEqual(
          (yield* detail()).openAttention.map((item) => item.id),
          [card.item.id],
        );
        yield* writeReadyPlan(lead);
        assert.deepStrictEqual((yield* detail()).openAttention, []);
        assert.strictEqual((yield* toLead()).length, quiet);

        // Asking again on the new version works as usual.
        const again = yield* askApproval(lead);
        yield* team.answerDecision({
          projectId: PROJECT_ID,
          attentionItemId: again.item.id,
          answer: PLAN_APPROVAL_START,
        });
        assert.strictEqual((yield* detail()).task.stage, "running");
      }),
    ),
  );
});

const claude = ProviderInstanceId.make("claude");
const codex = ProviderInstanceId.make("codex");

/** The plan and review run on the same model; implement runs on another. */
const setRoleModels = Effect.flatMap(service, (team) =>
  team.updateSettings({
    projectId: PROJECT_ID,
    roleModels: {
      plan: { providerInstanceId: claude, model: "claude-opus-5-5" },
      review: { providerInstanceId: claude, model: "claude-opus-5-5" },
      implement: { providerInstanceId: codex, model: "gpt-5.5" },
    },
  }),
);

describe("ProjectTeamService plan checker", () => {
  it.effect("sends a ready plan to a checker on another model before any card", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        yield* setRoleModels;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Hello", harness.delegate);
        yield* writeReadyPlan(lead);

        const asked = yield* requestApproval(lead, {}, harness.delegate);
        assert.include(asked.message, "end your turn");
        assert.include(asked.planCheck.ask.question, "Approve the plan?");
        assert.deepStrictEqual(
          [asked.planCheck.status, asked.planCheck.round, asked.planCheck.specVersion],
          ["checking", 1, 2],
        );
        // The review model is the plan model, so the checker runs on the implement model.
        const checkerCall = (yield* Ref.get(harness.delegated)).at(-1);
        assert.deepStrictEqual(checkerCall?.target, {
          providerInstanceId: codex,
          model: "gpt-5.5",
        });
        assert.include(checkerCall?.task ?? "", "You are the plan checker");
        assert.include(checkerCall?.task ?? "", "task_plan_check_set");
        assert.include(checkerCall?.task ?? "", "spec version 2");

        const detail = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.strictEqual(detail.task.stage, "planning");
        assert.deepStrictEqual(detail.openAttention, []);
        const checker = detail.task.planCheck?.checker;
        assert.deepStrictEqual(
          [checker?.providerInstanceId, checker?.model, checker?.sameModelAsPlan],
          [codex, "gpt-5.5", false],
        );
        assert.isTrue(
          detail.sessions.some(
            (session) => session.threadId === checker?.threadId && session.role === "checker",
          ),
        );
        // The checker reads the plan it judges.
        const read = yield* team.readSpec(checker!.threadId, {});
        assert.strictEqual(read.current.version, 2);
      }),
    ),
  );

  it.effect("lets only the pending checker record verdicts", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Hello", harness.delegate);
        yield* writeReadyPlan(lead);
        const first = yield* requestApproval(lead, {}, harness.delegate);
        const verdicts = [{ gate: "problem", pass: true, reason: "충분해요." }];
        for (const caller of [lead, pm]) {
          const refused = yield* team
            .setPlanCheck(caller, { taskId: task.id, specVersion: 2, verdicts })
            .pipe(Effect.flip);
          assert.include(refused.message, "only for the plan checker session");
        }
        // Every required gate needs a verdict.
        const oldChecker = first.planCheck.checker!.threadId;
        const partial = yield* team
          .setPlanCheck(oldChecker, { specVersion: 2, verdicts })
          .pipe(Effect.flip);
        assert.include(partial.message, "missing a verdict for gate why");

        // Asking again replaces the check in flight; the old checker's verdicts are refused.
        yield* requestApproval(lead, {}, harness.delegate);
        const stale = yield* team
          .setPlanCheck(oldChecker, { specVersion: 2, verdicts })
          .pipe(Effect.flip);
        assert.include(stale.message, "no longer pending");
        const { item } = yield* passPlanCheck(lead);
        assert.strictEqual(item?.kind, "approval");
      }),
    ),
  );

  it.effect("sends failing gates back to the lead and records the verdicts", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Hello", harness.delegate);
        yield* writeReadyPlan(lead);
        yield* requestApproval(lead, {}, harness.delegate);

        const failed = yield* passPlanCheck(lead, ["why"]);
        assert.isUndefined(failed.item);
        assert.strictEqual(failed.task.stage, "planning");
        const check = failed.task.planCheck!;
        assert.deepStrictEqual([check.status, check.round, check.specVersion], ["failed", 1, 2]);
        // A small task's light plan has 8 gates.
        assert.strictEqual(check.verdicts.length, 8);
        assert.deepStrictEqual(
          check.verdicts.filter((verdict) => !verdict.pass).map((verdict) => verdict.gate),
          ["why"],
        );
        assert.isNotNull(check.checkedAt);
        // The app's implement step differs from the plan model, so it checks the plan.
        assert.deepStrictEqual(
          [check.checker?.providerInstanceId, check.checker?.model],
          [
            DEFAULT_PROJECT_TASK_STEP_MODELS.implement.providerInstanceId,
            DEFAULT_PROJECT_TASK_STEP_MODELS.implement.model,
          ],
        );
        const told = (yield* Ref.get(harness.sent)).findLast((input) => input.threadId === lead);
        assert.include(told?.text ?? "", PLAN_CHECK_FAILED_PREFIX);
        assert.include(told?.text ?? "", 'why "왜": 왜 내용이 부족해요.');
        assert.include(
          told?.text ?? "",
          'Fix them with task_spec_write, then ask_user(kind: "approval") again',
        );
        const detail = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.deepStrictEqual(detail.openAttention, []);
      }),
    ),
  );

  it.effect("raises the card the lead asked for once every gate passes", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Hello", harness.delegate);
        yield* writeReadyPlan(lead);
        const context = attentionContext({ action: "Start hello.sh?" });
        yield* requestApproval(
          lead,
          { question: "Start hello.sh?", context, senderName: "인사 스크립트" },
          harness.delegate,
        );

        const { item, task: after } = yield* passPlanCheck(lead);
        assert.strictEqual(item?.question, "Start hello.sh?");
        assert.deepStrictEqual(item?.context, context);
        assert.strictEqual(item?.senderName, "인사 스크립트");
        assert.strictEqual(item?.specVersion, 2);
        assert.strictEqual(item?.askerThreadId, lead);
        assert.strictEqual(after.stage, "awaiting_approval");
        assert.strictEqual(after.planCheck?.status, "passed");
        const events = (yield* team.readTask(pm, { taskId: task.id })).events.map(
          (event) => event.body,
        );
        assert.isTrue(events.some((body) => body.includes("every gate passed")));
      }),
    ),
  );

  it.effect("keeps AFK from approving a plan while it is checked", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Hello", harness.delegate);
        yield* writeReadyPlan(lead);
        yield* team.updateSettings({ projectId: PROJECT_ID, afk: { hours: null } });
        yield* requestApproval(lead, {}, harness.delegate);

        yield* TestClock.adjust("5 minutes");
        yield* team.afkSweep;
        const checking = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.strictEqual(checking.task.stage, "planning");
        assert.strictEqual(checking.task.planCheck?.status, "checking");
        assert.deepStrictEqual(checking.openAttention, []);

        // Once the check passes, the card waits out the grace period like any other.
        yield* passPlanCheck(lead);
        yield* TestClock.adjust("61 seconds");
        yield* team.afkSweep;
        const approved = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.strictEqual(approved.task.stage, "running");
      }),
    ),
  );

  it.effect("raises the card after a third failing round so the task does not stall", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const pm = yield* setUpManager;
        const { leadThreadId: lead } = yield* startLead(pm, "Hello", harness.delegate);
        yield* writeReadyPlan(lead);
        for (const round of [1, 2]) {
          yield* requestApproval(lead, {}, harness.delegate);
          const failed = yield* passPlanCheck(lead, ["currentState"]);
          assert.isUndefined(failed.item);
          assert.strictEqual(failed.task.planCheck?.round, round);
        }
        yield* requestApproval(lead, {}, harness.delegate);
        const third = yield* passPlanCheck(lead, ["currentState"]);
        assert.strictEqual(third.item?.kind, "approval");
        assert.strictEqual(third.task.stage, "awaiting_approval");
        assert.deepStrictEqual(
          [third.task.planCheck?.status, third.task.planCheck?.round],
          ["failed", 3],
        );
        const toLead = (yield* Ref.get(harness.sent)).filter((input) => input.threadId === lead);
        assert.strictEqual(
          toLead.filter((input) => input.text.startsWith(PLAN_CHECK_FAILED_PREFIX)).length,
          2,
        );

        // Changes requested on that card start the rounds over.
        yield* Effect.flatMap(service, (team) =>
          team.answerDecision({
            projectId: PROJECT_ID,
            attentionItemId: third.item!.id,
            answer: "Request changes\n\nOverall:\nSmaller.",
          }),
        );
        const again = yield* requestApproval(lead, {}, harness.delegate);
        assert.strictEqual(again.planCheck.round, 1);
      }),
    ),
  );

  it.effect("runs the checker on the plan's model in its own session when no other is set up", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const same = { providerInstanceId: claude, model: "claude-opus-5-5" };
        yield* team.updateSettings({
          projectId: PROJECT_ID,
          roleModels: { plan: same, review: same, implement: same, fix: same },
        });
        const { leadThreadId: lead, task } = yield* startLead(pm, "Hello", harness.delegate);
        yield* writeReadyPlan(lead);

        const asked = yield* requestApproval(lead, {}, harness.delegate);
        assert.include(asked.message, "A separate plan checker session");
        assert.include(asked.message, "the plan's own model");
        const checker = (yield* leadTask(lead)).planCheck?.checker;
        assert.deepStrictEqual(
          [checker?.providerInstanceId, checker?.model, checker?.sameModelAsPlan],
          [claude, "claude-opus-5-5", true],
        );
        const events = (yield* team.readTask(pm, { taskId: task.id })).events.map(
          (event) => event.body,
        );
        assert.isTrue(
          events.some((body) => body.includes("(same model as the plan, separate session)")),
        );
      }),
    ),
  );

  it.effect("retries a checker that failed to start on the next model, not the same one", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        yield* setRoleModels;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Hello", harness.delegate);
        yield* writeReadyPlan(lead);
        const tried: Array<string | undefined> = [];
        const codexDown: ProjectTeamService.DelegateStep = (input, onChildCreated) => {
          tried.push(input.target?.providerInstanceId);
          return input.target?.providerInstanceId === codex
            ? Effect.fail(
                new OrchestratorMcpFailure({ code: "invalid_request", message: "codex is down" }),
              )
            : checkerDelegate(input, onChildCreated);
        };

        yield* requestApproval(lead, {}, codexDown);
        // The implement model failed; the review model (the plan's) runs it instead.
        assert.deepStrictEqual(tried, [codex, claude]);
        const checker = (yield* leadTask(lead)).planCheck?.checker;
        assert.deepStrictEqual(
          [checker?.providerInstanceId, checker?.sameModelAsPlan],
          [claude, true],
        );
        const events = (yield* team.readTask(pm, { taskId: task.id })).events.map(
          (event) => event.body,
        );
        assert.isTrue(
          events.some(
            (body) =>
              body.includes(
                "Could not start the plan checker on codex · gpt-5.5 (codex is down)",
              ) && body.includes("trying claude · claude-opus-5-5"),
          ),
        );
      }),
    ),
  );

  it.effect("restarts a check in flight without counting a round", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const pm = yield* setUpManager;
        const { leadThreadId: lead } = yield* startLead(pm, "Hello", harness.delegate);
        yield* writeReadyPlan(lead);
        const first = yield* requestApproval(lead, {}, harness.delegate);
        assert.include(first.message, "If you are told the checker's task ended");
        // The checker ended without a verdict, so the lead asks again.
        const again = yield* requestApproval(lead, {}, harness.delegate);
        assert.deepStrictEqual([again.planCheck.status, again.planCheck.round], ["checking", 1]);
        assert.notStrictEqual(again.planCheck.checker?.threadId, first.planCheck.checker?.threadId);
      }),
    ),
  );

  it.effect("moves a silent checker's next check to another model", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const pm = yield* setUpManager;
        yield* setRoleModels;
        const { leadThreadId: lead } = yield* startLead(pm, "Hello", harness.delegate);
        yield* writeReadyPlan(lead);
        const first = yield* requestApproval(lead, {}, harness.delegate);
        assert.strictEqual(first.planCheck.checker?.model, "gpt-5.5");
        // The checker started but ended without verdicts (say, on a usage limit).
        const again = yield* requestApproval(lead, {}, harness.delegate);
        assert.strictEqual(again.planCheck.round, 1);
        assert.notDeepEqual(
          [again.planCheck.checker?.providerInstanceId, again.planCheck.checker?.model],
          [first.planCheck.checker?.providerInstanceId, first.planCheck.checker?.model],
        );
      }),
    ),
  );

  it.effect("judges the gates fixed when the check started", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead } = yield* startLead(pm, "Hello", harness.delegate);
        yield* writeReadyPlan(lead);
        const asked = yield* requestApproval(lead, {}, harness.delegate);
        // A small task's light plan has 8 gates.
        assert.strictEqual(asked.planCheck.requiredGates.length, 8);
        // The size grows while it is checked; the check still wants those 8 gates.
        yield* setSize(lead, "large");
        const verdicts = asked.planCheck.requiredGates.map((gate) => ({
          gate,
          pass: true,
          reason: "충분해요.",
        }));
        yield* team.setPlanCheck(asked.planCheck.checker!.threadId, { specVersion: 2, verdicts });
        const after = yield* leadTask(lead);
        assert.deepStrictEqual(
          [after.planCheck?.status, after.stage],
          ["passed", "awaiting_approval"],
        );
      }),
    ),
  );

  it.effect("marks a check the spec moved past stale, keeping its round", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead } = yield* startLead(pm, "Hello", harness.delegate);
        yield* writeReadyPlan(lead);
        yield* requestApproval(lead, {}, harness.delegate);
        yield* passPlanCheck(lead, ["why"]);
        const second = yield* requestApproval(lead, {}, harness.delegate);
        assert.strictEqual(second.planCheck.round, 2);

        // The lead edits the plan while the checker reads it, which reads v3.
        const read = yield* team.readSpec(lead, {});
        yield* team.writeSpec(lead, {
          baseVersion: read.current.version,
          spec: { ...read.current.spec, why: `${read.current.spec.why} More.` },
          note: "Edit",
        });
        const verdicts = second.planCheck.requiredGates.map((gate) => ({
          gate,
          pass: true,
          reason: "충분해요.",
        }));
        yield* team.setPlanCheck(second.planCheck.checker!.threadId, {
          specVersion: 3,
          verdicts,
        });
        const stale = yield* leadTask(lead);
        assert.deepStrictEqual(
          [stale.planCheck?.status, stale.planCheck?.round, stale.stage],
          ["stale", 2, "planning"],
        );
        assert.deepStrictEqual(stale.planCheck?.verdicts, []);
        const told = (yield* Ref.get(harness.sent)).findLast((input) => input.threadId === lead);
        assert.include(told?.text ?? "", "the check is stale");

        // A stale check counts no round and resets none.
        const third = yield* requestApproval(lead, {}, harness.delegate);
        assert.deepStrictEqual([third.planCheck.round, third.planCheck.specVersion], [2, 3]);
      }),
    ),
  );

  it.effect("records verdicts without a card once the task left planning", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Hello", harness.delegate);
        yield* writeReadyPlan(lead);
        yield* requestApproval(lead, {}, harness.delegate);
        yield* repository.updateTask({ id: task.id, stage: "inbox", now: START });

        const { item, task: after } = yield* passPlanCheck(lead);
        assert.isUndefined(item);
        assert.deepStrictEqual([after.stage, after.planCheck?.status], ["inbox", "passed"]);
        const detail = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.deepStrictEqual(detail.openAttention, []);
      }),
    ),
  );
});
