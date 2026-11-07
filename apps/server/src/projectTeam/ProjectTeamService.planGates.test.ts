import { assert, describe, it } from "@effect/vitest";
import { PLAN_APPROVAL_START, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as ProjectTeamService from "./ProjectTeamService.ts";
import {
  PROJECT_ID,
  approvePlan,
  readyPlan,
  setUpManager,
  startLead,
  userSays,
  withTeam,
  writeReadyPlan,
} from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;

const askApproval = (lead: ThreadId) =>
  Effect.flatMap(service, (team) =>
    team.askUser(lead, {
      kind: "approval",
      question: "Approve the plan?",
    }),
  );

describe("ProjectTeamService plan gates", () => {
  it.effect("tells a lead to write what the user reads in the user's language", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const promptFor = (title: string, request: string) =>
          Effect.gen(function* () {
            const { task } = yield* team.createTask(pm, { intake: "New work.", title, request });
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
        const review = yield* team.updateTask(lead, {
          stage: "in_review",
          prUrl: "https://github.com/acme/app/pull/2",
        });
        assert.strictEqual(review.task.stage, "in_review");
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
