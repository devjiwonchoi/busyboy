// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  emptyProjectTaskSpec,
  newProjectTaskTodo,
  ChatAttachmentId,
  ProjectId,
  PLAN_APPROVAL_START,
  ProjectTaskId,
  ThreadId,
  formatPlanReviewFeedback,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import {
  PROJECT_ID,
  readyPlan,
  writeReadyPlan,
  setUpManager,
  startLead,
  userMessage,
  withTeam,
} from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;

const todo = newProjectTaskTodo;

describe("ProjectTeamService tasks as specs", () => {
  it.effect("keeps files the user attached to a new task and lists them in its spec", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* service;
        yield* setUpManager;
        const { attachmentsDir } = yield* ServerConfig.ServerConfig;
        const pendingId = createPendingAttachmentId("png")!;
        const bytes = new Uint8Array([1, 2, 3]);
        NodeFS.mkdirSync(attachmentsDir, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${pendingId}.png`), bytes);

        const created = yield* team.createTaskForUser({
          projectId: PROJECT_ID,
          title: "Fix the broken header",
          context: "The header overlaps the sidebar.",
          startPlanning: false,
          attachments: [
            {
              type: "image",
              id: ChatAttachmentId.make(pendingId),
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: bytes.byteLength,
            },
          ],
        });

        const background = created.versions[0]?.spec.background ?? "";
        const [context, list] = background.split("\n\n");
        assert.strictEqual(context, "The header overlaps the sidebar.");
        const match =
          /^Attachments \(read these files\):\n- screenshot\.png \(image\/png\): (\/.+)$/.exec(
            list ?? "",
          );
        assert.isNotNull(match);
        const path = match![1]!;
        assert.notInclude(path, "pending");
        assert.isTrue(NodeFS.existsSync(path));
        assert.deepStrictEqual([...NodeFS.readFileSync(path)], [1, 2, 3]);
        assert.strictEqual(created.task.request, "The header overlaps the sidebar.");
      }),
    ),
  );

  it.effect("lets the user dump a task, shape its spec, restore a version and split a todo", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;

        // Quick dump: no planner, the context becomes spec v1.
        const created = yield* team.createTaskForUser({
          projectId: PROJECT_ID,
          title: "Sidebar scroll jumps while dragging",
          context: "Dragging a project up jumps the list to the top.",
          startPlanning: false,
        });
        assert.strictEqual(created.key, "DE-1");
        assert.strictEqual(created.task.stage, "inbox");
        assert.strictEqual(created.versions.length, 1);
        assert.strictEqual(created.versions[0]?.author, "user");
        assert.strictEqual(
          created.versions[0]?.spec.background,
          "Dragging a project up jumps the list to the top.",
        );
        assert.deepStrictEqual(yield* harness.messagesTo(pm), []);

        // The user writes a goal and todos: v2.
        const edited = yield* team.updateTaskSpec({
          projectId: PROJECT_ID,
          taskId: created.task.id,
          baseVersion: 1,
          spec: {
            ...emptyProjectTaskSpec(),
            background: "Dragging a project up jumps the list to the top.",
            goal: "Dragging keeps the scroll position.",
            successCriteria: "",
            nonGoals: "",
            todos: [todo("t1", "Add a journey test"), todo("t2", "Keep scrollTop on drag start")],
          },
        });
        assert.deepStrictEqual(
          edited.versions.map((version) => version.version),
          [1, 2],
        );

        // An edit based on an old version is refused instead of overwriting v2.
        const stale = yield* team
          .updateTaskSpec({
            projectId: PROJECT_ID,
            taskId: created.task.id,
            baseVersion: 1,
            spec: emptyProjectTaskSpec(),
          })
          .pipe(Effect.flip);
        assert.include(stale.message, "changed to v2");

        // Restoring v1 adds v3 with v1's content; nothing is deleted.
        const restored = yield* team.restoreTaskSpec({
          projectId: PROJECT_ID,
          taskId: created.task.id,
          version: 1,
        });
        assert.strictEqual(restored.versions.length, 3);
        assert.strictEqual(restored.versions[2]?.note, "Restored v1");
        assert.strictEqual(restored.versions[2]?.spec.goal, "");

        // Back to the todos, then split one into its own task.
        yield* team.restoreTaskSpec({ projectId: PROJECT_ID, taskId: created.task.id, version: 2 });
        const split = yield* team.splitTaskTodo({
          projectId: PROJECT_ID,
          taskId: created.task.id,
          todoId: "t1",
        });
        assert.strictEqual(split.subtask.title, "Add a journey test");
        assert.strictEqual(split.subtask.parentTaskId, created.task.id);
        assert.deepStrictEqual(
          split.parent.children.map((child) => child.id),
          [split.subtask.id],
        );
        const current = split.parent.versions.at(-1)!;
        assert.strictEqual(current.version, 5);
        assert.strictEqual(current.spec.todos[0]?.subtaskId, split.subtask.id);
        const again = yield* team
          .splitTaskTodo({ projectId: PROJECT_ID, taskId: created.task.id, todoId: "t1" })
          .pipe(Effect.flip);
        assert.include(again.message, "already its own task");
      }),
    ),
  );

  it.effect("asks the PM to start a planner and links the lead as a task session", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        yield* team.updateSettings({ projectId: PROJECT_ID, taskKeyPrefix: "BB" });

        const created = yield* team.createTaskForUser({
          projectId: PROJECT_ID,
          title: "Direct task creation",
          context: "",
          startPlanning: true,
        });
        assert.strictEqual(created.key, "BB-1");
        // An empty dump still gives the lead something to read.
        assert.strictEqual(created.task.request, "Direct task creation");
        const [wake] = yield* harness.messagesTo(pm);
        assert.include(wake, "[Task added by the user] BB-1 Direct task creation");
        assert.include(wake, `task_start (taskId: ${created.task.id})`);

        yield* team.startTask(pm, { taskId: created.task.id }, harness.delegate);
        const detail = yield* team.getTaskDetail({
          projectId: PROJECT_ID,
          taskId: created.task.id,
        });
        assert.deepStrictEqual(
          detail.sessions.map(({ threadId, role }) => ({ threadId, role })),
          [{ threadId: ThreadId.make("lead-1"), role: "lead" }],
        );

        const snapshot = yield* team.attentionSnapshot;
        assert.strictEqual(snapshot.projects[0]?.taskKeyPrefix, "BB");
      }),
    ),
  );

  it.effect("keeps PM-created tasks on the same spec history", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { task } = yield* team.createTask(pm, {
          intake: "New work.",
          title: "Add hello.sh",
          request: "Add hello.sh with a test.",
        });
        const detail = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.strictEqual(detail.versions[0]?.author, "pm");
        assert.strictEqual(detail.versions[0]?.authorThreadId, pm);
        assert.strictEqual(detail.versions[0]?.spec.background, "Add hello.sh with a test.");

        const missing = yield* team
          .getTaskDetail({ projectId: PROJECT_ID, taskId: ProjectTaskId.make("task:nope") })
          .pipe(Effect.flip);
        assert.include(missing.message, "was not found");
      }),
    ),
  );
  it.effect("has the lead write the plan into the spec, park it, and resume it approved", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const created = yield* team.createTaskForUser({
          projectId: PROJECT_ID,
          title: "Fix drag scroll",
          context: "The list jumps to the top.",
          startPlanning: true,
        });
        const { leadThreadId: planner } = yield* team.startTask(
          pm,
          { taskId: created.task.id },
          harness.delegate,
        );
        const [first] = yield* Ref.get(harness.delegated);
        assert.strictEqual(first?.title, "DE-1 Fix drag scroll");
        assert.include(first?.task, "### Background\nThe list jumps to the top.");

        // The planner reads the spec and writes the plan as v2.
        const read = yield* team.readSpec(planner, {});
        assert.strictEqual(read.key, "DE-1");
        const plan = {
          ...read.current.spec,
          summary: "Dragging a project jumps the list to the top. After this it stays put.",
          goal: "Dragging keeps the scroll position.",
          criteria: [
            {
              id: "c1",
              text: "Dragging keeps the scroll position",
              provenBy: "a journey test",
              evidence: null,
            },
          ],
          todos: [
            { ...todo("t1", "Add a journey test"), criteria: ["c1"], doneWhen: "it fails today" },
            { ...todo("t2", "Keep scrollTop"), criteria: ["c1"], doneWhen: "the test passes" },
          ],
          files: [
            {
              path: "apps/web/src/components/Sidebar.tsx",
              change: "changed" as const,
              why: "Keep scrollTop on drag start",
              todos: ["t2"],
            },
          ],
          prototypeWaiver: "Nothing changes visually.",
        };
        const written = yield* team.writeSpec(planner, {
          baseVersion: read.current.version,
          spec: plan,
          note: "Plan",
        });
        assert.strictEqual(written.current.version, 2);
        assert.strictEqual(written.current.author, "agent");

        // The user edits the spec meanwhile, so the planner's stale write is refused.
        yield* team.updateTaskSpec({
          projectId: PROJECT_ID,
          taskId: created.task.id,
          baseVersion: 2,
          spec: { ...plan, nonGoals: "No redesign." },
        });
        const stale = yield* team
          .writeSpec(planner, { baseVersion: 2, spec: plan, note: "Again" })
          .pipe(Effect.flip);
        assert.include(stale.message, "Read it again with task_spec_read");

        // Another task's spec is off limits to this lead.
        const other = yield* team.createTask(pm, {
          intake: "New work.",
          title: "Other",
          request: "Other.",
        });
        const foreign = yield* team.readSpec(planner, { taskId: other.task.id }).pipe(Effect.flip);
        assert.include(foreign.message, "only use its own task's spec");

        // The planner cannot start before the user approves the plan.
        const early = yield* team
          .updateTask(planner, { stage: "running", planSummary: "Keep scrollTop." })
          .pipe(Effect.flip);
        assert.include(early.message, "no approved plan");
        const { item: card } = yield* team.askUser(planner, {
          kind: "approval",
          question: "Approve the plan?",
        });
        yield* team.answerDecision({
          projectId: PROJECT_ID,
          attentionItemId: card.id,
          answer: PLAN_APPROVAL_START,
        });
        const running = yield* team.updateTask(planner, {
          stage: "running",
          planSummary: "Keep scrollTop.",
        });
        assert.strictEqual(running.task.stage, "running");
        const afterPlan = yield* team.getTaskDetail({
          projectId: PROJECT_ID,
          taskId: created.task.id,
        });
        assert.deepStrictEqual(afterPlan.openAttention, []);

        // A stopped lead parks the task; starting it again opens an implementer that skips planning.
        yield* team.updateTask(planner, { stage: "inbox" });
        const resumed = yield* team.startTask(pm, { taskId: created.task.id }, harness.delegate);
        assert.notStrictEqual(resumed.leadThreadId, planner);
        const second = (yield* Ref.get(harness.delegated))[1];
        assert.strictEqual(second?.clientRequestId, `task-start:${created.task.id}:2`);
        assert.include(second?.task, "The plan above is already approved");
        assert.notInclude(second?.task, "1. planning:");
        assert.include(second?.task, "- [ ] t1: Add a journey test");

        // The implementer checks todos off as it works; a repeat check adds no version.
        const checked = yield* team.setTodo(resumed.leadThreadId, { todoId: "t1", done: true });
        assert.strictEqual(checked.current.version, 4);
        const again = yield* team.setTodo(resumed.leadThreadId, { todoId: "t1", done: true });
        assert.strictEqual(again.current.version, 4);

        const detail = yield* team.getTaskDetail({
          projectId: PROJECT_ID,
          taskId: created.task.id,
        });
        assert.deepStrictEqual(
          detail.sessions.map((session) => session.role),
          ["lead", "implementer"],
        );
        assert.deepStrictEqual(
          detail.versions.map((version) => `${version.author}: ${version.note}`),
          [
            "user: Created",
            "agent: Plan",
            "user: Edited by the user",
            'agent: Checked "Add a journey test"',
          ],
        );
      }),
    ),
  );
  it.effect("waits for plan approval, sends review feedback back, and starts on approval", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { task } = yield* team.createTask(pm, {
          intake: "New work.",
          title: "Fix drag",
          request: "Fix drag.",
        });
        const { leadThreadId: lead } = yield* team.startTask(
          pm,
          { taskId: task.id },
          harness.delegate,
        );
        assert.include((yield* Ref.get(harness.delegated))[0]?.task, 'ask_user(kind: "approval")');

        const read = yield* team.readSpec(lead, {});
        yield* team.writeSpec(lead, {
          baseVersion: read.current.version,
          spec: readyPlan({
            ...read.current.spec,
            goal: "Dragging keeps the scroll position.",
            successCriteria: "- The list never jumps.",
          }),
          note: "Plan",
        });

        // Asking for approval pins spec v2 and shows the task as Waiting for approval.
        const first = yield* team.askUser(lead, {
          kind: "approval",
          question: "Plan: keep it.",
          // Leads can't bring back "Approve only": approving always starts the work.
          options: ["Approve and start", "Approve only"],
        });
        assert.strictEqual(first.item.kind, "approval");
        // The card shows the plan's summary and its todos, each with how to tell it is done.
        assert.strictEqual(first.item.summary, "hello.sh prints hello when you run it.");
        assert.strictEqual(first.item.specVersion, 2);
        const card = (yield* team.attentionSnapshot).projects[0]?.decisionCards.find(
          (candidate) => candidate.item.id === first.item.id,
        );
        assert.deepStrictEqual(card?.plan, {
          summary: "hello.sh prints hello when you run it.",
          todos: [
            {
              id: "t1",
              text: "Write hello.sh",
              done: false,
              doneWhen: "the test passes",
              dependsOn: [],
            },
          ],
          subtasks: [],
        });
        assert.deepStrictEqual(first.item.options, ["Approve and start"]);
        const waiting = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.strictEqual(waiting.task.stage, "awaiting_approval");

        // Feedback from the review goes to the lead and moves the task back to planning.
        const feedback = formatPlanReviewFeedback({
          specVersion: 2,
          comments: [
            { section: "End result", quote: "scroll position", comment: "Say which list." },
          ],
          overall: "Looks close.",
        });
        yield* team.answerDecision({
          projectId: PROJECT_ID,
          attentionItemId: first.item.id,
          answer: feedback,
        });
        const replanning = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.strictEqual(replanning.task.stage, "planning");
        const relayed =
          (yield* Ref.get(harness.sent)).findLast((input) => input.threadId === lead)?.text ?? "";
        assert.include(relayed, "[User answer via BusyBoy]");
        assert.include(relayed, '[End result] "scroll position" → Say which list.');
        assert.include(relayed, "Looks close.");

        // The next version asks again; an older open card is replaced, not left waiting.
        const second = yield* team.askUser(lead, {
          kind: "approval",
          question: "Plan v3.",
        });
        const third = yield* team.askUser(lead, {
          kind: "approval",
          question: "Plan v3 again.",
        });
        const replaced = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.deepStrictEqual(
          replaced.openAttention.map((item) => item.id),
          [third.item.id],
        );
        assert.notStrictEqual(second.item.id, third.item.id);

        // The PM cannot approve on its own words.
        const pmApproval = yield* team
          .answerAttention(pm, { attentionItemId: third.item.id, answer: PLAN_APPROVAL_START })
          .pipe(Effect.flip);
        assert.include(pmApproval.message, "user");

        yield* team.answerDecision({
          projectId: PROJECT_ID,
          attentionItemId: third.item.id,
          answer: PLAN_APPROVAL_START,
        });
        const started = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.strictEqual(started.task.stage, "running");
        assert.deepStrictEqual(started.openAttention, []);
      }),
    ),
  );

  it.effect("approves plan cards for the user a minute after they ask while AFK is on", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const first = yield* team.createTask(pm, {
          intake: "New work.",
          title: "Fix drag",
          request: "Fix drag.",
        });
        const second = yield* team.createTask(pm, {
          intake: "New work.",
          title: "Fix drop",
          request: "Fix drop.",
        });
        const { leadThreadId: leadA } = yield* team.startTask(
          pm,
          { taskId: first.task.id },
          harness.delegate,
        );
        const { leadThreadId: leadB } = yield* team.startTask(
          pm,
          { taskId: second.task.id },
          harness.delegate,
        );

        // A card that already waited past the grace period is answered when AFK comes on.
        yield* writeReadyPlan(leadA);
        yield* writeReadyPlan(leadB);
        const waiting = yield* team.askUser(leadA, {
          kind: "approval",
          question: "Plan A.",
        });
        yield* TestClock.adjust("2 minutes");
        yield* team.updateSettings({ projectId: PROJECT_ID, afk: { hours: null } });
        const a = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: first.task.id });
        assert.strictEqual(a.task.stage, "running");
        assert.deepStrictEqual(a.openAttention, []);
        const cards = (yield* team.attentionSnapshot).projects[0]?.decisionCards ?? [];
        const answeredA = cards.find((card) => card.item.id === waiting.item.id)?.item;
        assert.strictEqual(answeredA?.answer ?? null, PLAN_APPROVAL_START);
        assert.strictEqual(answeredA?.answeredBy ?? null, "afk");

        // A new card waits through the grace period, then the sweep approves it.
        const asked = yield* team.askUser(leadB, {
          kind: "approval",
          question: "Plan B.",
        });
        assert.isNull(asked.item.answer);
        yield* team.afkSweep;
        const early = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: second.task.id });
        assert.strictEqual(early.task.stage, "awaiting_approval");
        yield* TestClock.adjust("61 seconds");
        yield* team.afkSweep;
        const b = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: second.task.id });
        assert.strictEqual(b.task.stage, "running");
        assert.deepStrictEqual(b.openAttention, []);
        const toLeadB = (yield* Ref.get(harness.sent)).filter((input) => input.threadId === leadB);
        assert.include(toLeadB.map((input) => input.text).join("\n"), "auto-approved (AFK)");
      }),
    ),
  );

  it.effect("lets the PM change the task key prefix on the user's word", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { task } = yield* team.createTask(pm, {
          intake: "New work.",
          title: "Docs",
          request: "Docs.",
        });
        yield* team.updateSettingsAsManager(pm, { taskKeyPrefix: "BB" });
        const detail = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.strictEqual(detail.key, "BB-1");
        assert.strictEqual((yield* team.teamStatus(pm, {})).taskKeyPrefix, "BB");
      }),
    ),
  );

  it.effect("plans again when a parked task has no plan yet", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { task } = yield* team.createTask(pm, {
          intake: "New work.",
          title: "Fix drag",
          request: "Fix drag.",
        });
        const { leadThreadId } = yield* team.startTask(pm, { taskId: task.id }, harness.delegate);
        yield* team.updateTask(leadThreadId, { stage: "inbox" });
        yield* team.startTask(pm, { taskId: task.id }, harness.delegate);
        const restarted = (yield* Ref.get(harness.delegated))[1]?.task ?? "";
        assert.include(restarted, "1. planning:");
        const detail = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.deepStrictEqual(
          detail.sessions.map((session) => session.role),
          ["lead", "lead"],
        );
      }),
    ),
  );
});

describe("AFK", () => {
  const journal = Effect.gen(function* () {
    const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
    const events = yield* repository.listProjectEventsSince({
      projectId: PROJECT_ID,
      since: "2000-01-01T00:00:00.000Z",
    });
    return events.map((event) => event.body);
  });

  it.effect("answers a decision card with the recommended option after the grace period", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { task } = yield* team.createTask(pm, {
          intake: "New work.",
          title: "Fix drag",
          request: "Fix drag.",
        });
        const { leadThreadId } = yield* team.startTask(pm, { taskId: task.id }, harness.delegate);

        const on = yield* team.updateSettings({ projectId: PROJECT_ID, afk: { hours: 8 } });
        assert.strictEqual(on.settings.afk?.until, "2026-11-04T08:00:00.000Z");
        // The PM and the running lead hear that the user is away.
        assert.isTrue((yield* harness.messagesTo(pm)).some((text) => text.startsWith("[AFK]")));
        assert.isTrue(
          (yield* harness.messagesTo(leadThreadId)).some((text) => text.startsWith("[AFK]")),
        );

        yield* team.askUser(leadThreadId, {
          kind: "decision",
          question: "Which list?",
          options: ["Flat", "Grouped (Recommended)"],
        });
        const blocker = yield* team.askUser(leadThreadId, {
          kind: "blocker",
          question: "Merge PR #9?",
        });
        yield* team.askUser(leadThreadId, {
          kind: "decision",
          question: "Any naming preference?",
        });

        // The user gets a minute to answer first.
        yield* TestClock.adjust("30 seconds");
        yield* team.afkSweep;
        let open = (yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id }))
          .openAttention;
        assert.strictEqual(open.length, 3);

        yield* TestClock.adjust("31 seconds");
        yield* team.afkSweep;
        open = (yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id }))
          .openAttention;
        // Blockers wait for the user even while AFK.
        assert.deepStrictEqual(
          open.map((item) => item.id),
          [blocker.item.id],
        );
        const toLead = (yield* Ref.get(harness.sent))
          .filter((input) => input.threadId === leadThreadId)
          .map((input) => input.text);
        assert.include(
          toLead,
          "[Auto-answered (AFK): the user is away] Which list? → Grouped (Recommended)",
        );
        assert.include(
          toLead,
          "[Auto-answered (AFK): the user is away] Any naming preference? → User is AFK: proceed with your recommended option and record the assumption.",
        );

        // The banner's list shows both answers.
        const summary = (yield* team.attentionSnapshot).projects[0];
        assert.deepStrictEqual(
          summary?.afkAnswers.map((answer) => answer.text),
          [
            "Which list? → Grouped (Recommended)",
            "Any naming preference? → User is AFK: proceed with your recommended option and record the assumption.",
          ],
        );
        assert.strictEqual(summary?.afkAnswers[0]?.threadId, leadThreadId);
      }),
    ),
  );

  it.effect("lets the user's own answer win inside the grace period", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { task } = yield* team.createTask(pm, {
          intake: "New work.",
          title: "Fix drag",
          request: "Fix drag.",
        });
        const { leadThreadId } = yield* team.startTask(pm, { taskId: task.id }, harness.delegate);
        yield* team.updateSettings({ projectId: PROJECT_ID, afk: { hours: null } });
        const asked = yield* team.askUser(leadThreadId, {
          kind: "decision",
          question: "Which list?",
          options: ["Flat", "Grouped (Recommended)"],
        });
        yield* TestClock.adjust("20 seconds");
        yield* team.answerDecision({
          projectId: PROJECT_ID,
          attentionItemId: asked.item.id,
          answer: "Flat",
        });
        yield* TestClock.adjust("2 minutes");
        yield* team.afkSweep;
        const card = (yield* team.attentionSnapshot).projects[0]?.decisionCards.find(
          (entry) => entry.item.id === asked.item.id,
        );
        assert.strictEqual(card?.item.answer, "Flat");
        assert.strictEqual(card?.item.answeredBy, "user");
        assert.deepStrictEqual((yield* team.attentionSnapshot).projects[0]?.afkAnswers, []);
      }),
    ),
  );

  it.effect("stops answering when its window ends or the user turns it off", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        yield* team.updateSettings({ projectId: PROJECT_ID, afk: { hours: 1 } });
        const { task } = yield* team.createTask(pm, {
          intake: "New work.",
          title: "Fix drag",
          request: "Fix drag.",
        });
        const { leadThreadId } = yield* team.startTask(pm, { taskId: task.id }, harness.delegate);
        yield* TestClock.adjust("2 hours");
        yield* team.updateTask(leadThreadId, { stage: "awaiting_approval" });
        yield* TestClock.adjust("2 minutes");
        yield* team.afkSweep;
        const detail = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.strictEqual(detail.task.stage, "awaiting_approval");

        yield* team.updateSettings({ projectId: PROJECT_ID, afk: { hours: null } });
        const off = yield* team.updateSettings({ projectId: PROJECT_ID, afk: null });
        assert.isUndefined(off.settings.afk);
        const bodies = yield* journal;
        assert.include(bodies, "AFK turned on by you until 2026-11-04T01:00:00.000Z");
        assert.include(bodies, "AFK turned off by you");
      }),
    ),
  );

  it.effect("carries Auto-approve plans over as AFK, and the PM's tool cannot turn it on", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        // Extra keys are dropped by the tool's schema; even passed through, the PM path ignores them.
        const asPm = yield* team.updateSettingsAsManager(pm, {
          sitrepNotify: true,
          afk: { hours: null },
          autoApprovePlans: { hours: null },
        } as never);
        assert.isUndefined(asPm.settings.afk);

        // A setting saved before AFK still counts as AFK.
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const manager = yield* repository.getManager(PROJECT_ID);
        assert.isTrue(manager._tag === "Some");
        if (manager._tag !== "Some") return;
        yield* repository.updateManagerSettings({
          projectId: PROJECT_ID,
          settings: {
            ...manager.value.settings,
            autoApprovePlans: { since: "2026-11-04T00:00:00.000Z", until: null },
          },
          now: "2026-11-04T00:00:00.000Z",
        });
        const { task } = yield* team.createTask(pm, {
          intake: "New work.",
          title: "Fix drag",
          request: "Fix drag.",
        });
        const { leadThreadId } = yield* team.startTask(pm, { taskId: task.id }, harness.delegate);
        yield* team.updateTask(leadThreadId, { stage: "awaiting_approval" });
        yield* TestClock.adjust("61 seconds");
        yield* team.afkSweep;
        const detail = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
        assert.strictEqual(detail.task.stage, "running");
      }),
    ),
  );
});

describe("isUserChatAnswer", () => {
  const thread = "thread:pm" as Parameters<typeof userMessage>[0]["threadId"];
  const said = (text: string) => [userMessage({ threadId: thread, text })];

  it("matches the user's words as whole words, ignoring case and spacing", () => {
    assert.isTrue(ProjectTeamService.isUserChatAnswer("전부 승인", said("네,  전부 승인"), 0));
    assert.isTrue(ProjectTeamService.isUserChatAnswer("option b", said("Go with Option B."), 0));
  });

  it("doesn't let a short answer match part of a longer word", () => {
    assert.isFalse(ProjectTeamService.isUserChatAnswer("B", said("maybe later"), 0));
    assert.isFalse(ProjectTeamService.isUserChatAnswer("approve", said("I don't approved it"), 0));
  });
});

describe("task dependencies", () => {
  const OTHER_PROJECT_ID = ProjectId.make("project-2");

  const eventBodies = (taskId: ProjectTaskId) =>
    Effect.gen(function* () {
      const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
      const events = yield* repository.listProjectEventsSince({
        projectId: PROJECT_ID,
        since: "2000-01-01T00:00:00.000Z",
      });
      return events.filter((event) => event.taskId === taskId).map((event) => event.body);
    });

  it.effect("lets the PM wait on and nest under tasks in other projects, and rename tasks", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        harness.addProject(OTHER_PROJECT_ID, "Website");
        const pm = yield* setUpManager;
        const otherPm = (yield* team.ensureManager(OTHER_PROJECT_ID)).threadId;
        const { task: api } = yield* team.createTask(otherPm, {
          intake: "New work.",
          title: "API",
          request: "API.",
        });

        const { task: ui } = yield* team.createTask(pm, {
          intake: "New work.",
          title: "BU-53 A: UI",
          request: "UI.",
          waitsOn: [api.id, api.id],
          parentTaskId: api.id,
        });
        assert.deepStrictEqual(ui.waitsOn, [api.id]);
        assert.strictEqual(ui.parentTaskId, api.id);
        // The app gets the links too, so it can mark the task blocked.
        const shown = (yield* team.attentionSnapshot).projects
          .flatMap((project) => project.tasks)
          .find((task) => task.id === ui.id);
        assert.deepStrictEqual(shown?.waitsOn, [api.id]);
        assert.strictEqual(shown?.parentTaskId, api.id);

        // The cross-project dependency still gates the start.
        const refused = yield* team
          .startTask(pm, { taskId: ui.id }, harness.delegate)
          .pipe(Effect.flip);
        assert.include(refused.message, "waits on #1, which is inbox");

        const { task: renamed } = yield* team.updateTask(pm, {
          taskId: ui.id,
          title: "UI",
          waitsOn: [],
          parentTaskId: null,
        });
        assert.strictEqual(renamed.title, "UI");
        assert.deepStrictEqual(renamed.waitsOn, []);
        assert.isNull(renamed.parentTaskId);
        assert.includeMembers(yield* eventBodies(ui.id), [
          'Renamed from "BU-53 A: UI"',
          "Waits on nothing",
          "No parent",
        ]);

        const { task: nested } = yield* team.updateTask(pm, {
          taskId: ui.id,
          parentTaskId: api.id,
        });
        assert.strictEqual(nested.parentTaskId, api.id);
        assert.strictEqual(nested.title, "UI");
        assert.include(yield* eventBodies(ui.id), "Part of #1 API");

        const unknown = yield* team
          .updateTask(pm, { taskId: ui.id, waitsOn: [ProjectTaskId.make("task:missing")] })
          .pipe(Effect.flip);
        assert.include(unknown.message, "task:missing was not found");
      }),
    ),
  );

  it.effect("refuses waitsOn and parent cycles, also across projects", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        harness.addProject(OTHER_PROJECT_ID, "Website");
        const pm = yield* setUpManager;
        const otherPm = (yield* team.ensureManager(OTHER_PROJECT_ID)).threadId;
        const { task: a } = yield* team.createTask(pm, {
          intake: "New work.",
          title: "A",
          request: "A.",
        });
        const { task: b } = yield* team.createTask(pm, {
          intake: "New work.",
          title: "B",
          request: "B.",
          waitsOn: [a.id],
        });
        const { task: c } = yield* team.createTask(otherPm, {
          intake: "New work.",
          title: "C",
          request: "C.",
          waitsOn: [b.id],
          parentTaskId: a.id,
        });

        const self = yield* team
          .updateTask(pm, { taskId: a.id, waitsOn: [a.id] })
          .pipe(Effect.flip);
        assert.include(self.message, "can't wait on itself");
        const loop = yield* team
          .updateTask(pm, { taskId: a.id, waitsOn: [c.id] })
          .pipe(Effect.flip);
        assert.include(loop.message, "Waiting on #1 C would make a cycle");
        const ownParent = yield* team
          .updateTask(pm, { taskId: a.id, parentTaskId: a.id })
          .pipe(Effect.flip);
        assert.include(ownParent.message, "can't be its own parent");
        const parentLoop = yield* team
          .updateTask(pm, { taskId: a.id, parentTaskId: c.id })
          .pipe(Effect.flip);
        assert.include(parentLoop.message, "already part of this task");

        // Nothing changed.
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const stored = (yield* repository.getTask(a.id)).pipe(Option.getOrThrow);
        assert.deepStrictEqual(stored.waitsOn, []);
        assert.isNull(stored.parentTaskId);
      }),
    ),
  );

  it.effect("keeps a task's title, waitsOn and parent for the PM", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const started = yield* startLead(pm, "Lead task", harness.delegate);
        for (const change of [{ title: "Mine now" }, { waitsOn: [] }, { parentTaskId: null }]) {
          const refused = yield* team.updateTask(started.leadThreadId, change).pipe(Effect.flip);
          assert.include(refused.message, "Only the PM can change");
        }
      }),
    ),
  );

  it.effect("wakes another project's PM once when its inbox task's last dependency clears", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        harness.addProject(OTHER_PROJECT_ID, "Website");
        const pm = yield* setUpManager;
        const otherPm = (yield* team.ensureManager(OTHER_PROJECT_ID)).threadId;
        const { task: schema } = yield* team.createTask(otherPm, {
          intake: "New work.",
          title: "Schema",
          request: "Schema.",
        });
        const api = yield* startLead(otherPm, "API", harness.delegate);
        const { task: ui } = yield* team.createTask(pm, {
          intake: "New work.",
          title: "UI",
          request: "UI.",
          waitsOn: [schema.id, api.task.id],
        });
        // Waiting on something that's already running elsewhere doesn't wake anyone.
        yield* team.createTask(pm, {
          intake: "New work.",
          title: "Docs",
          request: "Docs.",
          waitsOn: [api.task.id],
        });
        yield* team.updateTask(pm, { taskId: ui.id, note: "Planned." });
        const before = (yield* harness.messagesTo(pm)).length;

        // One of two dependencies clears: still blocked.
        yield* team.updateTask(api.leadThreadId, {
          stage: "in_review",
          prUrl: "https://github.com/acme/web/pull/1",
        });
        const afterFirst = (yield* harness.messagesTo(pm)).slice(before);
        assert.deepStrictEqual(afterFirst, [
          "[Dependency cleared] WE-2 API in Website is in review. Ready to start: #2 Docs.",
        ]);

        // The last one clears: the PM hears that UI is ready.
        yield* team.updateTask(otherPm, { taskId: schema.id, stage: "done" });
        // Moving on from in review to done is not a new unblock.
        yield* team.updateTask(api.leadThreadId, { stage: "done" });
        assert.deepStrictEqual((yield* harness.messagesTo(pm)).slice(before), [
          "[Dependency cleared] WE-2 API in Website is in review. Ready to start: #2 Docs.",
          "[Dependency cleared] WE-1 Schema in Website is done. Ready to start: #1 UI.",
        ]);
        assert.notInclude((yield* harness.messagesTo(otherPm)).join("\n"), "[Dependency cleared]");

        const started = yield* team.startTask(pm, { taskId: ui.id }, harness.delegate);
        assert.strictEqual(started.task.stage, "planning");
      }),
    ),
  );
});
