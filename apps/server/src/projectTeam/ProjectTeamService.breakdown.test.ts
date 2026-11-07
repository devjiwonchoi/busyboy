import { assert, describe, it } from "@effect/vitest";
import { PLAN_APPROVAL_START, type ProjectTask, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectTeamService from "./ProjectTeamService.ts";
import {
  PROJECT_ID,
  approvePlan,
  readyPlan,
  setUpManager,
  startLead,
  withTeam,
} from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;

const GOOD_BODY =
  "### Why?\n\nLeads open PRs nobody can review.\n\n### How?\n\nThe gate reads the PR.";

/** The lead drafts subtasks, writes a ready plan that lists them, and asks once. */
const draftBreakdown = (lead: ThreadId, titles: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const team = yield* service;
    const drafts: Array<ProjectTask> = [];
    for (const title of titles) {
      const { task } = yield* team.createTask(lead, {
        title,
        request: `Goal: ${title}.\nVerification: a test.`,
        waitsOn: drafts.length === 0 ? [] : [drafts[0]!.id],
      });
      drafts.push(task);
    }
    const read = yield* team.readSpec(lead, {});
    const plan = readyPlan(read.current.spec);
    yield* team.writeSpec(lead, {
      baseVersion: read.current.version,
      spec: {
        ...plan,
        todos: [
          ...plan.todos,
          ...drafts.map((draft, index) => ({
            id: `s${index + 1}`,
            text: `Subtask: ${draft.title}`,
            done: false,
            subtaskId: draft.id,
            criteria: ["c1"],
            dependsOn: [],
            doneWhen: "its PR merges",
          })),
        ],
      },
      note: "Plan with breakdown",
    });
    return drafts;
  });

const approve = (lead: ThreadId) =>
  Effect.gen(function* () {
    const team = yield* service;
    const { item } = yield* team.askUser(lead, { kind: "approval", question: "Approve?" });
    yield* team.answerDecision({
      projectId: PROJECT_ID,
      attentionItemId: item.id,
      answer: PLAN_APPROVAL_START,
    });
    return item;
  });

describe("ProjectTeamService intake and breakdown", () => {
  it.effect("refuses task_create without intake or for an open task's title", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const noIntake = yield* team
          .createTask(pm, { title: "Fix login", request: "Fix it." })
          .pipe(Effect.flip);
        assert.include(noIntake.message, "task_create needs intake");

        yield* team.createTask(pm, { intake: "New bug.", title: "Fix login", request: "Fix it." });
        const duplicate = yield* team
          .createTask(pm, { intake: "Again.", title: "fix the  Login!", request: "Fix it." })
          .pipe(Effect.flip);
        assert.include(duplicate.message, 'DE-1 "Fix login" is already open');
        assert.include(duplicate.message, "task_nudge(taskId, note, scope: true)");
      }),
    ),
  );

  it.effect("approves a whole breakdown with one card; subtask leads start without one", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task: parent } = yield* startLead(
          pm,
          "Workflow",
          harness.delegate,
        );
        const [first, second] = yield* draftBreakdown(lead, ["Server gates", "Plan view"]);

        // Drafts wait for the parent's approval.
        const early = yield* team
          .startTask(pm, { taskId: first!.id }, harness.delegate)
          .pipe(Effect.flip);
        assert.include(early.message, "#2 is a drafted subtask");

        const card = yield* approve(lead);
        assert.strictEqual(card.taskId, parent.id);

        // The PM hears exactly what can start.
        const wakes = yield* harness.messagesTo(pm);
        assert.include(
          wakes.join("\n"),
          "[Ready to start] DE-1 Workflow's plan was approved with its breakdown. Start with task_start: #2 Server gates. Still waiting on other tasks: #3 Plan view.",
        );

        const started = yield* team.startTask(pm, { taskId: first!.id }, harness.delegate);
        const prompt = (yield* Ref.get(harness.delegated)).at(-1)?.task ?? "";
        assert.include(prompt, 'This task is a subtask of DE-1 "Workflow"');
        assert.include(prompt, 'do not call ask_user(kind: "approval")');
        assert.include(
          started.task.planSummary ?? "",
          "Approved with DE-1 Workflow's breakdown: Subtask: Server gates",
        );

        const sub = started.leadThreadId;
        const refused = yield* team
          .askUser(sub, { kind: "approval", question: "Approve my plan?" })
          .pipe(Effect.flip);
        assert.include(refused.message, "#2 needs no approval card");
        assert.include(refused.message, "Breakdown change");

        const running = yield* team.updateTask(sub, { stage: "running", planSummary: "Detail." });
        assert.strictEqual(running.task.stage, "running");

        // One card for the whole breakdown, in the project's whole history.
        const cards = (yield* team.readTask(pm, { taskId: parent.id })).events.filter((e) =>
          e.body.startsWith("Asked the user to approve the plan"),
        );
        assert.strictEqual(cards.length, 1);
        assert.deepStrictEqual((yield* team.readTask(pm, { taskId: first!.id })).openAttention, []);

        // The first subtask in review clears the second.
        harness.pullRequests.set("https://github.com/o/r/pull/1", {
          title: "Add server gates",
          body: GOOD_BODY,
          isDraft: false,
        });
        yield* team.setEvidence(sub, { criterionId: "c1", evidence: "test" }).pipe(Effect.ignore);
        yield* team.updateTask(sub, {
          stage: "in_review",
          prUrl: "https://github.com/o/r/pull/1",
        });
        assert.include(
          (yield* harness.messagesTo(pm)).join("\n"),
          "[Ready to start] DE-2 Server gates is in review. Start with task_start: #3 Plan view.",
        );
        assert.strictEqual(second!.parentTaskId, parent.id);
      }),
    ),
  );

  it.effect("shows the breakdown on the open card and needs re-approval for a late subtask", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead } = yield* startLead(pm, "Workflow", harness.delegate);
        const [draft] = yield* draftBreakdown(lead, ["Server gates"]);
        const { item } = yield* team.askUser(lead, { kind: "approval", question: "Approve?" });
        const open = (yield* team.attentionSnapshot).projects[0]!.decisionCards;
        assert.strictEqual(open.length, 1);
        assert.deepStrictEqual(open[0]?.plan?.subtasks, [
          {
            taskId: draft!.id,
            number: 2,
            title: "Server gates",
            request: "Goal: Server gates.\nVerification: a test.",
            waitsOn: [],
          },
        ]);
        yield* team.answerDecision({
          projectId: PROJECT_ID,
          attentionItemId: item.id,
          answer: PLAN_APPROVAL_START,
        });

        // A subtask the lead drafts after the approval waits for the next one.
        yield* TestClock.adjust("1 minute");
        const { task: late } = yield* team.createTask(lead, {
          title: "Late part",
          request: "Goal: late.\nVerification: a test.",
        });
        const refused = yield* team
          .startTask(pm, { taskId: late.id }, harness.delegate)
          .pipe(Effect.flip);
        assert.include(refused.message, "drafted subtask");
      }),
    ),
  );

  it.effect("marks the parent done when all its subtasks are", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task: parent } = yield* startLead(
          pm,
          "Workflow",
          harness.delegate,
        );
        const [a, b] = yield* draftBreakdown(lead, ["Part A", "Part B"]);
        yield* approve(lead);
        yield* team.updateTask(pm, { taskId: a!.id, stage: "done" });
        assert.strictEqual((yield* team.readTask(pm, { taskId: parent.id })).task.stage, "running");
        yield* team.updateTask(pm, { taskId: b!.id, stage: "cancelled" });
        yield* team.updateTask(pm, { taskId: a!.id, stage: "running" });
        yield* team.updateTask(pm, { taskId: a!.id, stage: "done" });
        const done = (yield* team.readTask(pm, { taskId: parent.id })).task;
        assert.strictEqual(done.stage, "done");
        assert.strictEqual(done.resultSummary, "All 1 of its subtasks are done.");
        assert.include(
          (yield* harness.messagesTo(pm)).join("\n"),
          "#1 done: Workflow · All 1 of its subtasks are done.",
        );
      }),
    ),
  );

  it.effect("adds scope without counting it as a stall and closes the open card", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Hello", harness.delegate);
        yield* team.writeSpec(lead, {
          baseVersion: (yield* team.readSpec(lead, {})).current.version,
          spec: readyPlan((yield* team.readSpec(lead, {})).current.spec),
          note: "Plan",
        });
        yield* team.askUser(lead, { kind: "approval", question: "Approve?" });

        for (let n = 0; n < 3; n++) {
          const sent = yield* team.nudgeTask(pm, {
            taskId: task.id,
            note: `Also handle case ${n}.`,
            scope: true,
          });
          assert.strictEqual(sent.status, "sent");
          assert.strictEqual(sent.task.nudgeCount, 0);
        }
        const detail = yield* team.readTask(pm, { taskId: task.id });
        assert.strictEqual(detail.task.stage, "planning");
        assert.deepStrictEqual(detail.openAttention, []);
        const messages = (yield* Ref.get(harness.sent)).map((m) => m.text);
        assert.include(messages[0], "[PM scope note] The user added scope: Also handle case 0.");
        assert.include(messages[0], "Your approval card closed");
      }),
    ),
  );

  it.effect("does not escalate a lead that progressed since the last nudge", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead, task } = yield* startLead(pm, "Hello", harness.delegate);
        yield* team.nudgeTask(pm, { taskId: task.id });
        yield* team.nudgeTask(pm, { taskId: task.id });
        yield* TestClock.adjust("1 minute");
        yield* team.updateTask(lead, { note: "Reading the code." });
        const third = yield* team.nudgeTask(pm, { taskId: task.id });
        assert.strictEqual(third.status, "sent");
        assert.strictEqual(third.task.nudgeCount, 1);
      }),
    ),
  );

  it.effect("refuses In Review for a pull request that breaks the PR rules", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { leadThreadId: lead } = yield* startLead(pm, "Hello", harness.delegate);
        yield* approvePlan(lead);
        yield* team.setEvidence(lead, { criterionId: "c1", evidence: "unit test passed" });
        const url = "https://github.com/o/r/pull/7";
        const tryReview = () =>
          team.updateTask(lead, { stage: "in_review", prUrl: url }).pipe(Effect.flip);

        harness.pullRequests.set(url, {
          title:
            "Show task dependencies Linear-style: blocked flags, subtask progress, Structure section (BU-57)",
          body: GOOD_BODY,
          isDraft: false,
        });
        const longTitle = yield* tryReview();
        assert.include(longTitle.message, "does not follow the PR rules");
        assert.include(longTitle.message, "60");

        harness.pullRequests.set(url, {
          title: "Add PR gate",
          body: "## What changes\n\nA gate.",
          isDraft: false,
        });
        const noSections = yield* tryReview();
        assert.include(noSections.message, "### Why?");
        assert.include(noSections.message, "### How?");

        harness.pullRequests.set(url, {
          title: "Add PR gate",
          body: `${GOOD_BODY}\n\n## Test plan\n\n- [x] pnpm test`,
          isDraft: false,
        });
        const extra = yield* tryReview();
        assert.include(extra.message, "## Test plan");
        assert.include(extra.message.toLowerCase(), "validation");

        harness.pullRequests.set(url, { title: "Add PR gate", body: GOOD_BODY, isDraft: false });
        const ok = yield* team.updateTask(lead, { stage: "in_review", prUrl: url });
        assert.strictEqual(ok.task.stage, "in_review");
      }),
    ),
  );
});
