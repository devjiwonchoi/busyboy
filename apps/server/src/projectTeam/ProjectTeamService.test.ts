import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { PROJECT_ID, setUpManager, withTeam } from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;

function provider(
  id: string,
  overrides: Partial<Pick<ServerProvider, "installed" | "status">> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(id),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-04T00:00:00.000Z",
    models: [{ slug: `${id}-model`, name: `${id} model` }],
    slashCommands: [],
    skills: [],
    ...overrides,
  } as unknown as ServerProvider;
}

describe("ProjectTeamService", () => {
  it.effect("creates one PM thread per project and recreates it after deletion", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const first = yield* team.ensureManager(PROJECT_ID);
        const again = yield* team.ensureManager(PROJECT_ID);
        assert.strictEqual(again.threadId, first.threadId);
        assert.strictEqual(harness.threads.get(first.threadId)?.title, "Demo PM");
        assert.deepStrictEqual(yield* team.roleOf(first.threadId), {
          type: "pm",
          projectId: PROJECT_ID,
        });

        harness.threads.get(first.threadId)!.deletedAt = "2026-11-04T00:01:00.000Z";
        const replaced = yield* team.ensureManager(PROJECT_ID);
        assert.notStrictEqual(replaced.threadId, first.threadId);
        const creates = (yield* Ref.get(harness.dispatched)).filter(
          (command) => command.type === "thread.create",
        );
        assert.strictEqual(creates.length, 2);
      }),
    ),
  );

  it.effect("gives a new PM the first ready provider instead of a missing one", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        harness.providers.push(provider("codex", { installed: false }), provider("claudeAgent"));
        const team = yield* service;
        yield* team.ensureManager(PROJECT_ID);
        const create = (yield* Ref.get(harness.dispatched)).find(
          (command) => command.type === "thread.create",
        );
        assert.deepStrictEqual(create?.type === "thread.create" && create.modelSelection, {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claudeAgent-model",
        });
      }),
    ),
  );

  it.effect("queues tasks while the PM is busy and starts a task lead in a worktree", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        harness.threads.get(pm)!.activeRunId = "run-busy";
        yield* team.writeMemory(pm, {
          topic: "testing",
          content: "Run vp test for changed files.",
        });
        const { task } = yield* team.createTask(pm, {
          title: "Add hello.sh",
          request: "Add hello.sh with a test.",
        });
        assert.strictEqual(task.stage, "inbox");

        const started = yield* team.startTask(pm, { taskId: task.id }, harness.delegate);
        assert.strictEqual(started.task.stage, "planning");
        assert.strictEqual(started.leadThreadId, "lead-1");
        const [input] = yield* Ref.get(harness.delegated);
        assert.strictEqual(input?.isolation, "worktree");
        assert.strictEqual(input?.mode, "async");
        assert.strictEqual(input?.role, "implementation");
        assert.strictEqual(input?.clientRequestId, `task-start:${task.id}`);
        assert.strictEqual(input?.title, "#1 Add hello.sh");
        assert.isUndefined(input?.target);
        assert.include(input?.task, "Run vp test for changed files.");
        assert.include(input?.task, "ask_user");
        assert.deepStrictEqual(yield* team.roleOf(ThreadId.make("lead-1")), {
          type: "lead",
          projectId: PROJECT_ID,
          taskId: task.id,
        });
      }),
    ),
  );

  it.effect("keeps a third task in the inbox when the limit is two", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        yield* team.updateSettingsAsManager(pm, { maxConcurrentTasks: 2 });
        const tasks = yield* Effect.forEach([1, 2, 3], (n) =>
          team.createTask(pm, { title: `Task ${n}`, request: `Do task ${n}.` }),
        );
        yield* team.startTask(pm, { taskId: tasks[0]!.task.id }, harness.delegate);
        yield* team.startTask(pm, { taskId: tasks[1]!.task.id }, harness.delegate);
        const refused = yield* team
          .startTask(pm, { taskId: tasks[2]!.task.id }, harness.delegate)
          .pipe(Effect.flip);
        assert.include(refused.message, "stays in the inbox");
        const third = yield* team.readTask(pm, { taskId: tasks[2]!.task.id });
        assert.strictEqual(third.task.stage, "inbox");
        assert.strictEqual((yield* Ref.get(harness.delegated)).length, 2);
      }),
    ),
  );

  it.effect("waits on dependencies until they reach review", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const first = yield* team.createTask(pm, { title: "Schema", request: "Add the schema." });
        const second = yield* team.createTask(pm, {
          title: "Use schema",
          request: "Use it.",
          waitsOn: [first.task.id],
        });
        const refused = yield* team
          .startTask(pm, { taskId: second.task.id }, harness.delegate)
          .pipe(Effect.flip);
        assert.include(refused.message, "waits on #1");

        const lead = yield* team.startTask(pm, { taskId: first.task.id }, harness.delegate);
        yield* team.updateTask(lead.leadThreadId, {
          stage: "in_review",
          prUrl: "https://example.test/pr/1",
        });
        const started = yield* team.startTask(pm, { taskId: second.task.id }, harness.delegate);
        assert.strictEqual(started.task.stage, "planning");
      }),
    ),
  );

  it.effect("only lets the PM create tasks and a lead update its own task", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const stranger = ThreadId.make("thread-other");
        const denied = yield* team
          .createTask(stranger, { title: "x", request: "y" })
          .pipe(Effect.flip);
        assert.include(denied.message, "only for a project's PM or task leads");

        const a = yield* team.createTask(pm, { title: "A", request: "a" });
        const b = yield* team.createTask(pm, { title: "B", request: "b" });
        const leadA = yield* team.startTask(pm, { taskId: a.task.id }, harness.delegate);
        const notOwn = yield* team
          .updateTask(leadA.leadThreadId, { taskId: b.task.id, note: "hi" })
          .pipe(Effect.flip);
        assert.include(notOwn.message, "only update its own task");
        const leadCreates = yield* team
          .createTask(leadA.leadThreadId, { title: "x", request: "y" })
          .pipe(Effect.flip);
        assert.include(leadCreates.message, "not available to a task lead");
      }),
    ),
  );

  it.effect("nudges a lead twice, then refuses and raises a blocker", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { task } = yield* team.createTask(pm, { title: "Hello", request: "Add hello.sh." });
        const { leadThreadId } = yield* team.startTask(pm, { taskId: task.id }, harness.delegate);

        const first = yield* team.nudgeTask(pm, { taskId: task.id, note: "Write the plan." });
        assert.strictEqual(first.status, "sent");
        const [message] = yield* Ref.get(harness.sent);
        assert.strictEqual(message?.threadId, leadThreadId);
        assert.strictEqual(
          message?.text,
          "[PM nudge] Continue. Current stage: planning. Next step: Finish the plan and ask for approval with ask_user(kind: approval). Write the plan.",
        );
        const second = yield* team.nudgeTask(pm, { taskId: task.id });
        assert.strictEqual(second.task.nudgeCount, 2);

        const third = yield* team.nudgeTask(pm, { taskId: task.id });
        assert.strictEqual(third.status, "escalated");
        assert.strictEqual(third.attentionItem?.kind, "blocker");
        assert.strictEqual(third.attentionItem?.askerThreadId, leadThreadId);
        assert.include(third.attentionItem?.question, "made no progress after 2 nudges");
        assert.strictEqual((yield* Ref.get(harness.sent)).length, 2);

        const fourth = yield* team.nudgeTask(pm, { taskId: task.id });
        assert.strictEqual(fourth.attentionItem?.id, third.attentionItem?.id);

        yield* team.updateTask(leadThreadId, { stage: "running", planSummary: "Plan." });
        const afterProgress = yield* team.readTask(pm, { taskId: task.id });
        assert.strictEqual(afterProgress.task.nudgeCount, 0);
      }),
    ),
  );

  it.effect("reports what changed since the user's last message", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const pm = yield* setUpManager;
        const old = yield* team.createTask(pm, { title: "Old", request: "Done before." });
        const oldLead = yield* team.startTask(pm, { taskId: old.task.id }, harness.delegate);
        yield* team.updateTask(oldLead.leadThreadId, { stage: "done", resultSummary: "Shipped." });

        yield* TestClock.adjust("1 minute");
        yield* repository.recordUserMessage({
          projectId: PROJECT_ID,
          at: "2026-11-04T00:01:00.000Z",
        });
        yield* TestClock.adjust("1 minute");

        const done = yield* team.createTask(pm, { title: "Done", request: "Finish it." });
        const doneLead = yield* team.startTask(pm, { taskId: done.task.id }, harness.delegate);
        yield* team.updateTask(doneLead.leadThreadId, { stage: "done", resultSummary: "Did it." });
        const asking = yield* team.createTask(pm, { title: "Ask", request: "Ask the user." });
        const askingLead = yield* team.startTask(pm, { taskId: asking.task.id }, harness.delegate);
        yield* team.askUser(askingLead.leadThreadId, {
          kind: "approval",
          question: "Approve the plan?",
        });
        const blocked = yield* team.createTask(pm, { title: "Stuck", request: "Get stuck." });
        const blockedLead = yield* team.startTask(
          pm,
          { taskId: blocked.task.id },
          harness.delegate,
        );
        yield* team.updateTask(blockedLead.leadThreadId, { stage: "blocked" });

        const status = yield* team.teamStatus(pm, {});
        assert.strictEqual(status.changes.since, "2026-11-04T00:01:00.000Z");
        assert.deepStrictEqual(
          status.changes.done.map((task) => task.title),
          ["Done"],
        );
        assert.deepStrictEqual(
          status.tasks.done.map((task) => task.title),
          ["Old", "Done"],
        );
        assert.deepStrictEqual(
          status.openAttention.map((item) => item.question),
          ["Approve the plan?"],
        );
        assert.strictEqual(status.changes.newAttention.length, 1);
        assert.deepStrictEqual(
          status.changes.blocked.map((task) => task.title),
          ["Stuck"],
        );
      }),
    ),
  );

  it.effect("finds an approved plan summary with task search", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { task } = yield* team.createTask(pm, { title: "Cache", request: "Speed it up." });
        const { leadThreadId } = yield* team.startTask(pm, { taskId: task.id }, harness.delegate);
        yield* team.updateTask(leadThreadId, {
          stage: "running",
          planSummary: "Add an LRU cache in front of the resolver.",
        });
        const found = yield* team.searchTasks(pm, { query: "LRU cache" });
        assert.deepStrictEqual(
          found.tasks.map((entry) => entry.id),
          [task.id],
        );
      }),
    ),
  );

  it.effect("pins settings the user picks for 24 hours", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* service;
        yield* setUpManager;
        const result = yield* team.updateSettings({
          projectId: PROJECT_ID,
          sitrepIntervalMinutes: 45,
          sitrepNotify: false,
        });
        assert.strictEqual(result.settings.sitrepIntervalMinutes, 45);
        assert.strictEqual(result.settings.sitrepNotify, false);
        assert.strictEqual(result.settings.pinnedUntil, "2026-11-05T00:00:00.000Z");
        const missing = yield* team
          .updateSettings({ projectId: ProjectId.make("nope"), sitrepNotify: true })
          .pipe(Effect.flip);
        assert.include(missing.message, "has no PM");
      }),
    ),
  );

  it.effect("pins only a hand-set interval and rejects an empty settings update", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* service;
        yield* setUpManager;
        const toggled = yield* team.updateSettings({ projectId: PROJECT_ID, sitrepNotify: false });
        assert.strictEqual(toggled.settings.sitrepNotify, false);
        assert.strictEqual(toggled.settings.pinnedUntil, undefined);

        const pinned = yield* team.updateSettings({
          projectId: PROJECT_ID,
          sitrepIntervalMinutes: 45,
        });
        assert.strictEqual(pinned.settings.pinnedUntil, "2026-11-05T00:00:00.000Z");
        yield* TestClock.adjust("1 hour");
        const kept = yield* team.updateSettings({ projectId: PROJECT_ID, sitrepNotify: true });
        assert.strictEqual(kept.settings.pinnedUntil, "2026-11-05T00:00:00.000Z");

        const empty = yield* team.updateSettings({ projectId: PROJECT_ID }).pipe(Effect.flip);
        assert.include(empty.message, "no fields");
      }),
    ),
  );
});
