// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ChatAttachmentId, ProjectTaskId, ThreadId } from "@t3tools/contracts";
import * as Ref from "effect/Ref";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import { PROJECT_ID, setUpManager, userMessage, withTeam } from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;

const todo = (id: string, text: string) => ({ id, text, done: false, subtaskId: null });

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
            background: "Dragging a project up jumps the list to the top.",
            goal: "Dragging keeps the scroll position.",
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
            spec: { background: "", goal: "", nonGoals: "", todos: [] },
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
          goal: "Dragging keeps the scroll position.",
          todos: [todo("t1", "Add a journey test"), todo("t2", "Keep scrollTop")],
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
        const other = yield* team.createTask(pm, { title: "Other", request: "Other." });
        const foreign = yield* team.readSpec(planner, { taskId: other.task.id }).pipe(Effect.flip);
        assert.include(foreign.message, "only use its own task's spec");

        // No approval card: the planner starts running with its plan recorded.
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
        assert.isFalse(
          (yield* harness.messagesTo(pm)).some((text) => text.includes("[Decision card]")),
        );

        // A stopped lead parks the task; starting it again opens an implementer that skips planning.
        yield* team.updateTask(planner, { stage: "inbox" });
        const resumed = yield* team.startTask(pm, { taskId: created.task.id }, harness.delegate);
        assert.notStrictEqual(resumed.leadThreadId, planner);
        const second = (yield* Ref.get(harness.delegated))[1];
        assert.strictEqual(second?.clientRequestId, `task-start:${created.task.id}:2`);
        assert.include(second?.task, "The plan above is already written");
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
  it.effect("lets the PM change the task key prefix on the user's word", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { task } = yield* team.createTask(pm, { title: "Docs", request: "Docs." });
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
        const { task } = yield* team.createTask(pm, { title: "Fix drag", request: "Fix drag." });
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

describe("Auto-approve plans", () => {
  const journal = Effect.gen(function* () {
    const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
    const events = yield* repository.listProjectEventsSince({
      projectId: PROJECT_ID,
      since: "2000-01-01T00:00:00.000Z",
    });
    return events.map((event) => event.body);
  });

  it.effect("approves a waiting plan while the user's setting is on, and not after it ends", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const first = yield* team.createTask(pm, { title: "Fix drag", request: "Fix drag." });
        const { leadThreadId: firstLead } = yield* team.startTask(
          pm,
          { taskId: first.task.id },
          harness.delegate,
        );

        // Off: the plan waits for the user.
        const waiting = yield* team.updateTask(firstLead, {
          stage: "awaiting_approval",
          planSummary: "Keep scrollTop.",
        });
        assert.strictEqual(waiting.task.stage, "awaiting_approval");

        // Turning it on approves the plan that was already waiting.
        const on = yield* team.updateSettings({
          projectId: PROJECT_ID,
          autoApprovePlans: { hours: 8 },
        });
        assert.strictEqual(on.settings.autoApprovePlans?.until, "2026-11-04T08:00:00.000Z");
        const approved = yield* team.getTaskDetail({
          projectId: PROJECT_ID,
          taskId: first.task.id,
        });
        assert.strictEqual(approved.task.stage, "running");
        const toLead = (yield* Ref.get(harness.sent))
          .filter((input) => input.threadId === firstLead)
          .map((input) => input.text);
        assert.isTrue(
          toLead.some((text) =>
            text.startsWith(
              `[Plan auto-approved by the user's "Auto-approve plans" setting] Your plan for #1 Fix drag → Approve and start.`,
            ),
          ),
        );

        // A plan that asks for approval while it's on goes straight to running.
        const second = yield* team.createTask(pm, { title: "Docs", request: "Docs." });
        const { leadThreadId: secondLead } = yield* team.startTask(
          pm,
          { taskId: second.task.id },
          harness.delegate,
        );
        const instant = yield* team.updateTask(secondLead, { stage: "awaiting_approval" });
        assert.strictEqual(instant.task.stage, "running");

        // Decision questions still go to the user.
        const question = yield* team.askUser(secondLead, {
          kind: "decision",
          question: "Which color?",
          options: ["Red", "Blue"],
        });
        assert.isNull(question.item.answeredAt);

        // After the window ends, plans wait again.
        yield* TestClock.adjust("9 hours");
        const third = yield* team.createTask(pm, { title: "Lint", request: "Lint." });
        const { leadThreadId: thirdLead } = yield* team.startTask(
          pm,
          { taskId: third.task.id },
          harness.delegate,
        );
        const later = yield* team.updateTask(thirdLead, { stage: "awaiting_approval" });
        assert.strictEqual(later.task.stage, "awaiting_approval");

        const bodies = yield* journal;
        assert.include(
          bodies,
          "Auto-approve plans turned on by you until 2026-11-04T08:00:00.000Z",
        );
        assert.include(
          bodies,
          'Plan for #1 auto-approved ("Approve and start") by the user\'s Auto-approve plans setting.',
        );
        assert.include(
          bodies,
          'Plan for #2 auto-approved ("Approve and start") by the user\'s Auto-approve plans setting.',
        );
        assert.notInclude(
          bodies,
          'Plan for #3 auto-approved ("Approve and start") by the user\'s Auto-approve plans setting.',
        );
      }),
    ),
  );

  it.effect("stays off when turned off, and the PM's settings tool cannot turn it on", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        yield* team.updateSettings({ projectId: PROJECT_ID, autoApprovePlans: { hours: null } });
        const off = yield* team.updateSettings({ projectId: PROJECT_ID, autoApprovePlans: null });
        assert.isUndefined(off.settings.autoApprovePlans);

        // Extra keys are dropped by the tool's schema; even passed through, the PM path ignores them.
        const asPm = yield* team.updateSettingsAsManager(pm, {
          sitrepNotify: true,
          autoApprovePlans: { hours: null },
        } as never);
        assert.isUndefined(asPm.settings.autoApprovePlans);

        const { task } = yield* team.createTask(pm, { title: "Fix drag", request: "Fix drag." });
        const { leadThreadId } = yield* team.startTask(pm, { taskId: task.id }, harness.delegate);
        const waiting = yield* team.updateTask(leadThreadId, { stage: "awaiting_approval" });
        assert.strictEqual(waiting.task.stage, "awaiting_approval");
        assert.include(yield* journal, "Auto-approve plans turned off by you");
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
