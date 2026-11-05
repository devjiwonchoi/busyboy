import { assert, describe, it } from "@effect/vitest";
import {
  PLAN_APPROVAL_ONLY,
  PLAN_APPROVAL_START,
  type ProjectTeamError,
  ProjectTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Ref from "effect/Ref";
import * as Effect from "effect/Effect";

import * as ProjectTeamService from "./ProjectTeamService.ts";
import { PROJECT_ID, setUpManager, userMessage, userSays, withTeam } from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;

const todo = (id: string, text: string) => ({ id, text, done: false, subtaskId: null });

describe("ProjectTeamService tasks as specs", () => {
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

        // A plan approval offers both answers by default.
        const { item } = yield* team.askUser(planner, {
          kind: "approval",
          question: "Fix drag scroll: approve the plan in the spec?",
        });
        assert.deepStrictEqual(item.options, [PLAN_APPROVAL_START, PLAN_APPROVAL_ONLY]);
        yield* team.answerDecision({
          projectId: PROJECT_ID,
          attentionItemId: item.id,
          answer: PLAN_APPROVAL_ONLY,
        });

        // "Approve only": the lead parks the task with the plan recorded.
        yield* team.updateTask(planner, { stage: "inbox", planSummary: "Keep scrollTop." });

        // Starting it again opens an implementer that skips planning.
        const resumed = yield* team.startTask(pm, { taskId: created.task.id }, harness.delegate);
        assert.notStrictEqual(resumed.leadThreadId, planner);
        const second = (yield* Ref.get(harness.delegated))[1];
        assert.strictEqual(second?.clientRequestId, `task-start:${created.task.id}:2`);
        assert.include(second?.task, "The plan above is already approved");
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

  describe("resuming a parked task", () => {
    /** Starts a planner, lets `approve` answer its approval card, parks it with a plan, restarts it. */
    const parkAndRestart = (
      approve: (input: {
        readonly pm: ThreadId;
        readonly planner: ThreadId;
        readonly harness: Parameters<Parameters<typeof withTeam>[0]>[0];
      }) => Effect.Effect<void, ProjectTeamError, ProjectTeamService.ProjectTeamService>,
    ) =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const pm = yield* setUpManager;
          const { task } = yield* team.createTask(pm, { title: "Fix drag", request: "Fix drag." });
          const { leadThreadId: planner } = yield* team.startTask(
            pm,
            { taskId: task.id },
            harness.delegate,
          );
          yield* approve({ pm, planner, harness });
          // Any agent can write a planSummary; it is not approval on its own.
          yield* team.updateTask(planner, { stage: "inbox", planSummary: "Keep scrollTop." });
          yield* team.startTask(pm, { taskId: task.id }, harness.delegate);
          const resumed = (yield* Ref.get(harness.delegated))[1]?.task ?? "";
          const detail = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: task.id });
          return {
            approved: resumed.includes("The plan above is already approved"),
            roles: detail.sessions.map((session) => session.role),
          };
        }),
      );

    it.effect("plans again when the plan summary has no answered approval card", () =>
      Effect.gen(function* () {
        const unasked = yield* parkAndRestart(() => Effect.void);
        assert.deepStrictEqual(unasked, { approved: false, roles: ["lead", "lead"] });

        const unanswered = yield* parkAndRestart(({ planner }) =>
          Effect.gen(function* () {
            const team = yield* service;
            yield* team.askUser(planner, { kind: "approval", question: "Approve the plan?" });
          }),
        );
        assert.deepStrictEqual(unanswered, { approved: false, roles: ["lead", "lead"] });
      }),
    );

    it.effect("plans again when the user clicked something other than an approval", () =>
      Effect.gen(function* () {
        const result = yield* parkAndRestart(({ planner }) =>
          Effect.gen(function* () {
            const team = yield* service;
            const { item } = yield* team.askUser(planner, {
              kind: "approval",
              question: "Approve the plan?",
            });
            yield* team.answerDecision({
              projectId: PROJECT_ID,
              attentionItemId: item.id,
              answer: "Request changes\nNote: smaller",
            });
          }),
        );
        assert.deepStrictEqual(result, { approved: false, roles: ["lead", "lead"] });
      }),
    );

    it.effect("resumes approved after the user clicks approve", () =>
      Effect.gen(function* () {
        const result = yield* parkAndRestart(({ planner }) =>
          Effect.gen(function* () {
            const team = yield* service;
            const { item } = yield* team.askUser(planner, {
              kind: "approval",
              question: "Approve the plan?",
            });
            yield* team.answerDecision({
              projectId: PROJECT_ID,
              attentionItemId: item.id,
              answer: `${PLAN_APPROVAL_ONLY}\nNote: ship it`,
            });
          }),
        );
        assert.deepStrictEqual(result, { approved: true, roles: ["lead", "implementer"] });
      }),
    );

    it.effect("resumes approved after the PM relays the user's own chat words", () =>
      Effect.gen(function* () {
        const result = yield* parkAndRestart(({ pm, planner, harness }) =>
          Effect.gen(function* () {
            const team = yield* service;
            const { item } = yield* team.askUser(planner, {
              kind: "approval",
              question: "Approve the plan?",
            });
            userSays(harness, pm, "전부 승인");
            yield* team.answerAttention(pm, { attentionItemId: item.id, answer: "전부 승인" });
          }),
        );
        assert.deepStrictEqual(result, { approved: true, roles: ["lead", "implementer"] });
      }),
    );

    it("counts a card answered before the answerer was recorded only with a plan", () => {
      const legacy = {
        kind: "approval",
        answer: "yes",
        answeredBy: null,
      } as unknown as Parameters<typeof ProjectTeamService.isPlanApproved>[1];
      assert.isTrue(ProjectTeamService.isPlanApproved("Plan.", legacy));
      assert.isFalse(ProjectTeamService.isPlanApproved(null, legacy));
      assert.isFalse(ProjectTeamService.isPlanApproved("Plan.", undefined));
    });
  });
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
