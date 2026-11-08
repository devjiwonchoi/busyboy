import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  TURN_FAILED_OPTIONS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { defaultPersona, defaultPersonaName } from "./persona.ts";
import * as SitrepScheduler from "./SitrepScheduler.ts";
import { nextStepHint } from "./taskLeadPrompt.ts";
import {
  createAcceptedTask,
  approvePlan,
  PROJECT_ID,
  reviewClean,
  setUpManager,
  startLead,
  withTeam,
} from "./testkit.ts";

// Keep the real Ref operations while allowing interception inside sendToThread.
vi.mock("effect/Ref", { spy: true });

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
        assert.strictEqual(
          harness.threads.get(first.threadId)?.title,
          defaultPersonaName(PROJECT_ID),
        );
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
        const { task } = yield* team.createTaskForUser({
          projectId: PROJECT_ID,
          startPlanning: false,
          title: "Add hello.sh",
          context: "Add hello.sh with a test.",
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
        assert.strictEqual(input?.title, "DE-1 Add hello.sh");
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
          team.createTaskForUser({
            projectId: PROJECT_ID,
            startPlanning: false,
            title: `Task ${n}`,
            context: `Do task ${n}.`,
          }),
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
        const first = yield* team.createTaskForUser({
          projectId: PROJECT_ID,
          startPlanning: false,
          title: "Schema",
          context: "Add the schema.",
        });
        const second = yield* createAcceptedTask(pm, {
          intake: "New work.",
          title: "Use schema",
          request: "Use it.",
          waitsOn: [first.task.id],
        });
        const refused = yield* team
          .startTask(pm, { taskId: second.task.id }, harness.delegate)
          .pipe(Effect.flip);
        assert.include(refused.message, "waits on #1");

        const lead = yield* team.startTask(pm, { taskId: first.task.id }, harness.delegate);
        yield* reviewClean(lead.leadThreadId);
        yield* team.updateTask(lead.leadThreadId, {
          stage: "in_review",
          prUrl: "https://example.test/pr/1",
        });
        const started = yield* team.startTask(pm, { taskId: second.task.id }, harness.delegate);
        assert.strictEqual(started.task.stage, "planning");
      }),
    ),
  );

  it.effect(
    "lets the PM create tasks, a lead draft only its own subtasks and update its own task",
    () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const pm = yield* setUpManager;
          const stranger = ThreadId.make("thread-other");
          const denied = yield* team
            .createTask(stranger, { title: "x", request: "y" })
            .pipe(Effect.flip);
          assert.include(denied.message, "only for a project's PM or task leads");

          const a = yield* team.createTaskForUser({
            projectId: PROJECT_ID,
            startPlanning: false,
            title: "A",
            context: "a",
          });
          const b = yield* team.createTaskForUser({
            projectId: PROJECT_ID,
            startPlanning: false,
            title: "B",
            context: "b",
          });
          const leadA = yield* team.startTask(pm, { taskId: a.task.id }, harness.delegate);
          const notOwn = yield* team
            .updateTask(leadA.leadThreadId, { taskId: b.task.id, note: "hi" })
            .pipe(Effect.flip);
          assert.include(notOwn.message, "only update its own task");
          // A lead's task_create only drafts subtasks of its own task.
          const elsewhere = yield* team
            .createTask(leadA.leadThreadId, { title: "x", request: "y", parentTaskId: b.task.id })
            .pipe(Effect.flip);
          assert.include(elsewhere.message, "drafts subtasks of its own task only");
        }),
      ),
  );

  it.effect("nudges a lead twice, then refuses and raises a blocker", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { task } = yield* team.createTaskForUser({
          projectId: PROJECT_ID,
          startPlanning: false,
          title: "Hello",
          context: "Add hello.sh.",
        });
        const { leadThreadId } = yield* team.startTask(pm, { taskId: task.id }, harness.delegate);

        const first = yield* team.nudgeTask(pm, { taskId: task.id, note: "Write the plan." });
        assert.strictEqual(first.status, "sent");
        const [message] = yield* Ref.get(harness.sent);
        assert.strictEqual(message?.threadId, leadThreadId);
        assert.strictEqual(
          message?.text,
          `[PM nudge] Continue. Current stage: planning. Next step: ${nextStepHint("planning")} Write the plan.`,
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

        yield* approvePlan(leadThreadId);
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
        const old = yield* team.createTaskForUser({
          projectId: PROJECT_ID,
          startPlanning: false,
          title: "Old",
          context: "Done before.",
        });
        const oldLead = yield* team.startTask(pm, { taskId: old.task.id }, harness.delegate);
        yield* team.updateTask(oldLead.leadThreadId, { stage: "done", resultSummary: "Shipped." });

        yield* TestClock.adjust("1 minute");
        yield* repository.recordUserMessage({
          projectId: PROJECT_ID,
          at: "2026-11-04T00:01:00.000Z",
        });
        yield* TestClock.adjust("1 minute");

        const done = yield* team.createTaskForUser({
          projectId: PROJECT_ID,
          startPlanning: false,
          title: "Done",
          context: "Finish it.",
        });
        const doneLead = yield* team.startTask(pm, { taskId: done.task.id }, harness.delegate);
        yield* team.updateTask(doneLead.leadThreadId, { stage: "done", resultSummary: "Did it." });
        const asking = yield* team.createTaskForUser({
          projectId: PROJECT_ID,
          startPlanning: false,
          title: "Ask",
          context: "Ask the user.",
        });
        const askingLead = yield* team.startTask(pm, { taskId: asking.task.id }, harness.delegate);
        yield* team.askUser(askingLead.leadThreadId, {
          kind: "decision",
          question: "Which login provider?",
        });
        const blocked = yield* team.createTaskForUser({
          projectId: PROJECT_ID,
          startPlanning: false,
          title: "Stuck",
          context: "Get stuck.",
        });
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
          ["Which login provider?"],
        );
        assert.strictEqual(status.changes.newAttention.length, 1);
        assert.deepStrictEqual(
          status.changes.blocked.map((task) => task.title),
          ["Stuck"],
        );
      }),
    ),
  );

  it.effect("gives every task the status the user sees in team_status and task_list", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const start = (title: string) =>
          Effect.gen(function* () {
            const { task } = yield* team.createTaskForUser({
              projectId: PROJECT_ID,
              startPlanning: false,
              title,
              context: `${title}.`,
            });
            return yield* team.startTask(pm, { taskId: task.id }, harness.delegate);
          });
        yield* team.createTaskForUser({
          projectId: PROJECT_ID,
          startPlanning: false,
          title: "Queued",
          context: "Later.",
        });
        yield* start("Planning");
        const approval = yield* start("Approval");
        yield* team.updateTask(approval.leadThreadId, { stage: "awaiting_approval" });
        const building = yield* start("Building");
        yield* approvePlan(building.leadThreadId);
        yield* team.updateTask(building.leadThreadId, { stage: "running", planSummary: "Plan." });
        const shipped = yield* start("Shipped");
        yield* reviewClean(shipped.leadThreadId);
        yield* team.updateTask(shipped.leadThreadId, {
          stage: "in_review",
          prUrl: "https://github.com/acme/app/pull/9",
        });
        const asking = yield* start("Asking");
        yield* team.askUser(asking.leadThreadId, { kind: "decision", question: "Which one?" });
        const stuck = yield* start("Stuck");
        yield* team.updateTask(stuck.leadThreadId, { stage: "blocked" });
        const finished = yield* start("Finished");
        yield* team.updateTask(finished.leadThreadId, { stage: "done", resultSummary: "Done." });

        const status = yield* team.teamStatus(pm, {});
        const byTitle = new Map(
          Object.values(status.tasks)
            .flat()
            .map((task) => [task.title, task.status]),
        );
        assert.deepStrictEqual(Object.fromEntries(byTitle), {
          Queued: "todo",
          Planning: "planning",
          Approval: "waiting_for_approval",
          Building: "in_progress",
          Shipped: "in_review",
          Asking: "ask_question",
          Stuck: "fatal",
          Finished: "done",
        });
        assert.deepStrictEqual(status.statusCounts, {
          todo: 1,
          planning: 1,
          waiting_for_approval: 1,
          in_progress: 1,
          in_review: 1,
          ready: 0,
          ask_question: 1,
          fatal: 1,
          done: 1,
        });

        const listed = yield* team.listTasks(pm, {});
        assert.strictEqual(
          listed.tasks.find((task) => task.title === "Asking")?.status,
          "ask_question",
        );
      }),
    ),
  );

  it.effect("finds an approved plan summary with task search", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { task } = yield* team.createTaskForUser({
          projectId: PROJECT_ID,
          startPlanning: false,
          title: "Cache",
          context: "Speed it up.",
        });
        const { leadThreadId } = yield* team.startTask(pm, { taskId: task.id }, harness.delegate);
        yield* approvePlan(leadThreadId);
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

  it.effect("pins an interval the user picks", () =>
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
        assert.strictEqual(result.settings.intervalPinnedAt, "2026-11-04T00:00:00.000Z");
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
        assert.strictEqual(toggled.settings.intervalPinnedAt, undefined);

        const pinned = yield* team.updateSettings({
          projectId: PROJECT_ID,
          sitrepIntervalMinutes: 45,
        });
        assert.strictEqual(pinned.settings.intervalPinnedAt, "2026-11-04T00:00:00.000Z");
        yield* TestClock.adjust("1 hour");
        const kept = yield* team.updateSettings({ projectId: PROJECT_ID, sitrepNotify: true });
        assert.strictEqual(kept.settings.intervalPinnedAt, "2026-11-04T00:00:00.000Z");

        const empty = yield* team.updateSettings({ projectId: PROJECT_ID }).pipe(Effect.flip);
        assert.include(empty.message, "no fields");
      }),
    ),
  );

  it.effect("stores the default persona and names the PM thread after it", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const manager = yield* team.ensureManager(PROJECT_ID);
        assert.deepStrictEqual(manager.settings.persona, defaultPersona(PROJECT_ID));
        const stored = yield* repository.getManager(PROJECT_ID);
        assert.deepStrictEqual(
          stored._tag === "Some" ? stored.value.settings.persona : undefined,
          defaultPersona(PROJECT_ID),
        );
        assert.strictEqual(
          harness.threads.get(manager.threadId)?.title,
          defaultPersona(PROJECT_ID).name,
        );
        const snapshot = yield* team.attentionSnapshot;
        assert.deepStrictEqual(snapshot.projects[0]?.persona, defaultPersona(PROJECT_ID));
        assert.isTrue(snapshot.projects[0]?.enabled);
      }),
    ),
  );

  it.effect("renames an old-style PM thread and brings back an archived one", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const thread = harness.threads.get(pm)!;
        thread.title = "Demo PM";
        thread.archivedAt = "2026-11-04T00:01:00.000Z";

        const again = yield* team.ensureManager(PROJECT_ID);
        assert.strictEqual(again.threadId, pm);
        assert.strictEqual(thread.title, defaultPersonaName(PROJECT_ID));
        assert.isNull(thread.archivedAt);
        const commands = (yield* Ref.get(harness.dispatched)).map((command) => command.type);
        assert.include(commands, "thread.unarchive");
        assert.include(commands, "thread.metadata.update");

        // A title the user picked is left alone.
        thread.title = "Our PM";
        yield* team.ensureManager(PROJECT_ID);
        assert.strictEqual(thread.title, "Our PM");
      }),
    ),
  );

  it.effect("renames the PM thread on a name change without pinning settings", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const fromUser = yield* team.updateSettings({
          projectId: PROJECT_ID,
          persona: { name: "Remy", voice: "dry" },
          enabled: false,
        });
        assert.strictEqual(fromUser.settings.persona?.name, "Remy");
        assert.strictEqual(fromUser.settings.persona?.voice, "dry");
        assert.deepStrictEqual(
          fromUser.settings.persona?.avatar,
          defaultPersona(PROJECT_ID).avatar,
        );
        assert.isFalse(fromUser.settings.enabled);
        assert.strictEqual(fromUser.settings.intervalPinnedAt, undefined);
        assert.strictEqual(harness.threads.get(pm)?.title, "Remy");

        const fromPm = yield* team.updateSettingsAsManager(pm, {
          name: "Otto",
          avatarEmoji: "🐙",
          voice: "chatty",
        });
        assert.deepStrictEqual(fromPm.settings.persona, {
          name: "Otto",
          avatar: { kind: "emoji", emoji: "🐙" },
          voice: "chatty",
        });
        assert.isFalse(fromPm.settings.enabled);
        assert.strictEqual(fromPm.settings.intervalPinnedAt, undefined);
        assert.strictEqual(harness.threads.get(pm)?.title, "Otto");

        const snapshot = yield* team.attentionSnapshot;
        assert.strictEqual(snapshot.projects[0]?.persona.name, "Otto");
        assert.isFalse(snapshot.projects[0]?.enabled);
        assert.isNull(snapshot.projects[0]?.presence.nextSitrepAt);
      }),
    ),
  );

  it.effect(
    "tells a live PM once when the user changes its persona, not when it changes itself",
    () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const pm = yield* setUpManager;
          const personaMessages = Effect.map(harness.messagesTo(pm), (texts) =>
            texts.filter((text) => text.startsWith("[Persona]")),
          );

          yield* team.updateSettingsAsManager(pm, { name: "Moss", voice: "chatty" });
          assert.deepStrictEqual(yield* personaMessages, []);

          yield* team.updateSettings({ projectId: PROJECT_ID, persona: { name: "Ada" } });
          assert.deepStrictEqual(yield* personaMessages, [
            "[Persona] Your name is now Ada. Use this from now on.",
          ]);
          const [command] = (yield* Ref.get(harness.dispatched)).filter(
            (entry) => entry.type === "message.dispatch",
          );
          assert.isTrue(command?.commandId.startsWith("project-team:persona:"));
          if (command?.type === "message.dispatch") {
            assert.deepStrictEqual(command.dispatchMode, { type: "queue_after_active" });
            assert.strictEqual(command.createdBy, "system");
            assert.strictEqual(command.creationSource, "server");
          }

          yield* TestClock.adjust("1 minute");
          yield* team.updateSettings({
            projectId: PROJECT_ID,
            persona: { voice: "custom", voiceCustom: "Like a\nship's captain." },
          });
          assert.strictEqual(
            (yield* personaMessages)[1],
            `[Persona] Voice (the user's words): "Like a ship's captain.". Use this from now on.`,
          );

          // Other settings, an unchanged persona, and a turned-off PM send nothing.
          yield* TestClock.adjust("1 minute");
          yield* team.updateSettings({ projectId: PROJECT_ID, sitrepNotify: false });
          yield* team.updateSettings({ projectId: PROJECT_ID, persona: { name: "Ada" } });
          yield* team.updateSettings({ projectId: PROJECT_ID, enabled: false });
          yield* team.updateSettings({ projectId: PROJECT_ID, persona: { name: "Bo" } });
          assert.strictEqual((yield* personaMessages).length, 2);
        }),
      ),
  );

  it.effect("waits for another settings write before reading the settings", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* service;
        const sitreps = yield* SitrepScheduler.SitrepScheduler;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        yield* setUpManager;
        const holding = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        // Another writer, e.g. the adaptive sitrep interval, holds the lock mid-write.
        const other = yield* sitreps
          .withSettingsLock(
            PROJECT_ID,
            Effect.gen(function* () {
              const manager = Option.getOrThrow(yield* repository.getManager(PROJECT_ID));
              yield* Deferred.succeed(holding, undefined);
              yield* Deferred.await(release);
              yield* repository.updateManagerSettings({
                projectId: PROJECT_ID,
                settings: { ...manager.settings, sitrepNotify: false },
                now: "2026-11-04T00:00:00.000Z",
              });
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(holding);
        const write = yield* team
          .updateSettings({ projectId: PROJECT_ID, sitrepIntervalMinutes: 30 })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.isUndefined(write.pollUnsafe());

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(other);
        const { settings } = yield* Fiber.join(write);
        assert.isFalse(settings.sitrepNotify);
        assert.strictEqual(settings.sitrepIntervalMinutes, 30);
      }),
    ),
  );

  it.effect("counts tasks for presence and reports the PM's last action", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const empty = (yield* team.attentionSnapshot).projects[0]!.presence;
        assert.deepStrictEqual(empty, {
          running: 0,
          waitingOnUser: 0,
          stalled: 0,
          inbox: 0,
          nextSitrepAt: "2026-11-04T01:00:00.000Z",
          lastAction: null,
        });

        const first = yield* startLead(pm, "First", harness.delegate);
        const second = yield* startLead(pm, "Second", harness.delegate);
        const third = yield* startLead(pm, "Third", harness.delegate);
        const reviewed = yield* startLead(pm, "Reviewed", harness.delegate);
        yield* reviewClean(reviewed.leadThreadId);
        yield* team.updateTask(reviewed.leadThreadId, {
          stage: "in_review",
          prUrl: "https://github.com/acme/repo/pull/1",
        });
        yield* team.createTaskForUser({
          projectId: PROJECT_ID,
          startPlanning: false,
          title: "Later",
          context: "Later.",
        });
        yield* team.recordOutcome({ task: second.task, outcome: "stalled" });
        yield* team.askUser(first.leadThreadId, { kind: "decision", question: "Which way?" });
        yield* team.askUser(first.leadThreadId, { kind: "decision", question: "Which color?" });
        yield* TestClock.adjust("1 minute");
        yield* team.nudgeTask(pm, { taskId: second.task.id });

        const presence = (yield* team.attentionSnapshot).projects[0]!.presence;
        // Only #3 is running: #1 waits on the user, #2 stalled, #4 is in review.
        assert.strictEqual(presence.running, 1);
        assert.strictEqual(presence.stalled, 1);
        assert.strictEqual(presence.inbox, 1);
        // Counts open questions, like openCount.
        assert.strictEqual(presence.waitingOnUser, 2);
        assert.strictEqual(
          presence.waitingOnUser,
          (yield* team.attentionSnapshot).projects[0]!.openCount,
        );
        assert.deepStrictEqual(presence.lastAction, {
          text: `nudged #${second.task.number} Second`,
          at: "2026-11-04T00:01:00.000Z",
        });

        yield* TestClock.adjust("1 minute");
        yield* team.updateTask(pm, { taskId: third.task.id, stage: "cancelled" });
        const after = (yield* team.attentionSnapshot).projects[0]!.presence;
        assert.strictEqual(after.lastAction?.text, `cancelled #${third.task.number} Third`);
        assert.strictEqual(after.running, 0);
      }),
    ),
  );

  it.effect("sends each task's last-update time in the snapshot", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const created = yield* team.createTaskForUser({
          projectId: PROJECT_ID,
          startPlanning: false,
          title: "Later",
          context: "Later.",
        });
        const before = (yield* team.attentionSnapshot).projects[0]!.tasks[0]!;
        assert.strictEqual(before.updatedAt, created.task.updatedAt);

        yield* TestClock.adjust("5 minutes");
        yield* team.updateTask(pm, { taskId: created.task.id, stage: "cancelled" });
        const after = (yield* team.attentionSnapshot).projects[0]!.tasks[0]!;
        assert.strictEqual(after.updatedAt, "2026-11-04T00:05:00.000Z");
      }),
    ),
  );

  it.effect("streams a fresh snapshot when the PM proposes a task", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const fiber = yield* team.streamAttention.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        for (let index = 0; index < 50; index++) yield* Effect.yieldNow;
        yield* team.createTask(pm, {
          intake: "New work.",
          title: "Later",
          request: "Later.",
          goal: "Deliver it later.",
          verification: "Check the result.",
        });
        const snapshots = Array.from(yield* Fiber.join(fiber));
        assert.strictEqual(snapshots[0]?.projects[0]?.presence.inbox, 0);
        assert.strictEqual(snapshots[1]?.projects[0]?.presence.inbox, 0);
        assert.strictEqual(snapshots[1]?.projects[0]?.decisionCards[0]?.item.kind, "proposal");
        assert.strictEqual(snapshots[1]?.projects[0]?.decisionCards[0]?.taskTitle, "Later");
        assert.strictEqual(
          snapshots[1]?.projects[0]?.presence.lastAction?.text,
          "noted on #1 Later",
        );
      }),
    ),
  );

  it.effect(
    "keeps an already blocked task blocked when retrying without failure stage history",
    () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
          const pm = yield* setUpManager;
          const lead = yield* startLead(pm, "Already blocked", harness.delegate);
          const blocked = Option.getOrThrow(
            yield* repository.updateTask({
              id: lead.task.id,
              stage: "blocked",
              now: lead.task.updatedAt,
            }),
          );
          yield* team.recordOutcome({ task: blocked, outcome: "failed" });
          const open = yield* repository.listOpenAttentionItems({ projectId: PROJECT_ID });
          assert.strictEqual(open.length, 1);
          yield* team.answerDecision({
            projectId: PROJECT_ID,
            attentionItemId: open[0]!.id,
            answer: "다시 시도",
          });
          assert.strictEqual(
            Option.getOrThrow(yield* repository.getTask(lead.task.id)).stage,
            "blocked",
          );
        }),
      ),
  );

  // Exercise both user clicks and PM relays through the real task lifecycle.
  for (const via of ["user", "pm"] as const) {
    for (const answer of [
      "다시 시도\nNote: 테스트부터",
      "태스크 취소",
      "태스크 취소\nNote: 무시할 메모",
    ]) {
      it.effect(`${via} answers a failed-turn blocker with ${answer}`, () =>
        withTeam((harness) =>
          Effect.gen(function* () {
            const team = yield* service;
            const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
            const pm = yield* setUpManager;
            const lead = yield* startLead(pm, "Fragile", harness.delegate);
            harness.addThread(lead.leadThreadId);
            yield* approvePlan(lead.leadThreadId);
            const running = Option.getOrThrow(yield* repository.getTask(lead.task.id));
            assert.strictEqual(running.stage, "running");
            yield* team.recordOutcome({
              task: running,
              outcome: "failed",
              detail: "unexpected status 401 Unauthorized: token_expired",
            });
            const blocker = (yield* repository.listOpenAttentionItems({
              projectId: PROJECT_ID,
            }))[0]!;
            assert.strictEqual(
              blocker.question.split("\n")[0],
              `#${lead.task.number} Fragile: 리드 작업이 실패했어요 (로그인 만료 401)`,
            );
            assert.deepStrictEqual(blocker.options, TURN_FAILED_OPTIONS);
            // Repeated failures while the card is open must not duplicate it.
            yield* team.recordOutcome({
              task: Option.getOrThrow(yield* repository.getTask(lead.task.id)),
              outcome: "failed",
            });
            assert.deepStrictEqual(
              (yield* repository.listOpenAttentionItems({ projectId: PROJECT_ID })).map(
                (item) => item.id,
              ),
              [blocker.id],
            );
            const before = yield* Effect.map(Ref.get(harness.sent), (messages) =>
              messages
                .filter((message) => message.threadId === lead.leadThreadId)
                .map((message) => message.text),
            );
            if (via === "user") {
              yield* team.answerDecision({
                projectId: PROJECT_ID,
                attentionItemId: blocker.id,
                answer,
              });
            } else {
              yield* team.answerAttention(pm, { attentionItemId: blocker.id, answer });
            }
            const messages = yield* Effect.map(Ref.get(harness.sent), (messages) =>
              messages
                .filter((message) => message.threadId === lead.leadThreadId)
                .map((message) => message.text),
            );
            const task = yield* repository.getTask(lead.task.id);
            assert.isTrue(Option.isSome(task));
            if (answer.startsWith("태스크 취소")) {
              assert.deepStrictEqual(messages, before);
              assert.strictEqual(Option.getOrThrow(task).stage, "cancelled");
              assert.isNotNull(harness.threads.get(lead.leadThreadId)!.archivedAt);
              const answered = Option.getOrThrow(yield* repository.getAttentionItem(blocker.id));
              assert.isNotNull(answered.answeredAt);
              assert.strictEqual(answered.answer, answer);
              assert.isNull(answered.supersededAt);
            } else {
              assert.strictEqual(Option.getOrThrow(task).stage, "running");
              const events = yield* repository.listTaskEvents({ taskId: lead.task.id, limit: 100 });
              assert.strictEqual(
                events.findLast((event) => event.kind === "stage_changed")?.body,
                "blocked → running",
              );
              const prefix =
                via === "user"
                  ? "[User answer via BusyBoy]"
                  : "[User's chat answer, relayed by BusyBoy PM]";
              assert.deepStrictEqual(messages.slice(before.length), [
                `${prefix} ${blocker.question} → ${answer}`,
              ]);
              // An immediate second failure after retry gets a fresh actionable card.
              const failed = yield* team.recordOutcome({
                task: Option.getOrThrow(task),
                outcome: "failed",
              });
              const reopened = yield* repository.listOpenAttentionItems({ projectId: PROJECT_ID });
              assert.strictEqual(reopened.length, 1);
              assert.notStrictEqual(reopened[0]!.id, blocker.id);
              assert.strictEqual(failed.task.stage, "blocked");
              yield* team.recordOutcome({ task: failed.task, outcome: "failed" });
              assert.deepStrictEqual(
                (yield* repository.listOpenAttentionItems({ projectId: PROJECT_ID })).map(
                  (item) => item.id,
                ),
                [reopened[0]!.id],
              );
            }
          }),
        ),
      );
    }
  }

  // The retry must remain actionable even when delivery fails or the next turn fails immediately.
  for (const via of ["user", "pm"] as const) {
    for (const duringRelay of ["failed turn", "failed relay", "failed turn and relay"] as const) {
      it.effect(`${via} preserves a blocker after a ${duringRelay} during retry`, () =>
        withTeam((harness) =>
          Effect.gen(function* () {
            const team = yield* service;
            const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
            const pm = yield* setUpManager;
            const lead = yield* startLead(pm, "Retry", harness.delegate);
            harness.addThread(lead.leadThreadId);
            yield* approvePlan(lead.leadThreadId);
            const running = Option.getOrThrow(yield* repository.getTask(lead.task.id));
            yield* team.recordOutcome({ task: running, outcome: "failed" });
            const blocker = (yield* repository.listOpenAttentionItems({
              projectId: PROJECT_ID,
            }))[0]!;
            yield* TestClock.adjust("1 second");

            // sendToThread writes this ref before returning to the router's answer save.
            const { update } = yield* Effect.promise(() =>
              vi.importActual<typeof Ref>("effect/Ref"),
            );
            const relay = vi.spyOn(Ref, "update").mockImplementation(((
              ref: Ref.Ref<unknown>,
              change: (value: unknown) => unknown,
            ) => {
              const sent = update(ref, change);
              if (ref !== harness.sent) {
                return sent;
              }
              relay.mockRestore();
              return sent.pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    if (duringRelay !== "failed relay") {
                      yield* team.recordOutcome({
                        task: Option.getOrThrow(yield* repository.getTask(lead.task.id)),
                        outcome: "failed",
                      });
                      if (duringRelay === "failed turn and relay") {
                        return yield* Effect.fail(
                          new PersistenceSqlError({
                            operation: "relay",
                            detail: "Relay failed after the turn failed",
                          }),
                        );
                      }
                    }
                  }),
                ),
              );
            }) as typeof Ref.update);
            if (duringRelay === "failed relay") {
              harness.sendFailures.remaining = 1;
            }
            const result = yield* (
              via === "user"
                ? team.answerDecision({
                    projectId: PROJECT_ID,
                    attentionItemId: blocker.id,
                    answer: "다시 시도",
                  })
                : team.answerAttention(pm, { attentionItemId: blocker.id, answer: "다시 시도" })
            ).pipe(Effect.exit, Effect.ensuring(Effect.sync(() => relay.mockRestore())));
            assert.strictEqual(result._tag, duringRelay === "failed turn" ? "Success" : "Failure");
            const open = yield* repository.listOpenAttentionItems({ projectId: PROJECT_ID });
            assert.strictEqual(open.length, 1);
            assert.deepStrictEqual(open[0]!.options, TURN_FAILED_OPTIONS);
            assert.strictEqual(
              Option.getOrThrow(yield* repository.getTask(lead.task.id)).stage,
              "blocked",
            );
            const original = Option.getOrThrow(yield* repository.getAttentionItem(blocker.id));
            assert.isNull(original.answer);
            assert.isNull(original.answeredAt);
            if (duringRelay !== "failed relay") {
              assert.isNotNull(original.supersededAt);
              assert.isFalse(open[0]!.id === blocker.id);
              // The replacement survives another failure in the same clock tick.
              yield* team.recordOutcome({
                task: Option.getOrThrow(yield* repository.getTask(lead.task.id)),
                outcome: "failed",
              });
              assert.deepStrictEqual(
                (yield* repository.listOpenAttentionItems({ projectId: PROJECT_ID })).map(
                  (item) => item.id,
                ),
                [open[0]!.id],
              );
            } else {
              assert.isNull(original.supersededAt);
              assert.strictEqual(open[0]!.id, blocker.id);
            }

            // A failed turn supplies its own block; rollback must not duplicate it.
            const events = yield* repository.listTaskEvents({ taskId: lead.task.id, limit: 100 });
            assert.strictEqual(
              events.filter(
                (event) => event.kind === "stage_changed" && event.body === "running → blocked",
              ).length,
              2,
            );

            // The next answer must restore the stage and reach the lead on the actionable card.
            const before = (yield* Ref.get(harness.sent)).length;
            if (via === "user") {
              yield* team.answerDecision({
                projectId: PROJECT_ID,
                attentionItemId: open[0]!.id,
                answer: "다시 시도",
              });
            } else {
              yield* team.answerAttention(pm, {
                attentionItemId: open[0]!.id,
                answer: "다시 시도",
              });
            }
            assert.strictEqual(
              Option.getOrThrow(yield* repository.getTask(lead.task.id)).stage,
              running.stage,
            );
            const messages = (yield* Ref.get(harness.sent)).slice(before);
            assert.isTrue(
              messages.some(
                (message) =>
                  message.threadId === lead.leadThreadId &&
                  message.text.includes(`${open[0]!.question} → 다시 시도`),
              ),
            );
            const answered = Option.getOrThrow(yield* repository.getAttentionItem(open[0]!.id));
            assert.strictEqual(answered.answer, "다시 시도");
            assert.isNotNull(answered.answeredAt);
          }),
        ),
      );
    }

    it.effect(`${via} leaves a failed cancellation unanswered`, () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
          const pm = yield* setUpManager;
          const lead = yield* startLead(pm, "Cancel", harness.delegate);
          yield* team.recordOutcome({ task: lead.task, outcome: "failed" });
          const blocker = (yield* repository.listOpenAttentionItems({ projectId: PROJECT_ID }))[0]!;
          const write = vi
            .spyOn(repository, "updateTask")
            .mockReturnValueOnce(
              Effect.fail(
                new PersistenceSqlError({ operation: "updateTask", detail: "cancel failed" }),
              ),
            );
          const result = yield* (
            via === "user"
              ? team.answerDecision({
                  projectId: PROJECT_ID,
                  attentionItemId: blocker.id,
                  answer: "태스크 취소",
                })
              : team.answerAttention(pm, { attentionItemId: blocker.id, answer: "태스크 취소" })
          ).pipe(Effect.exit, Effect.ensuring(Effect.sync(() => write.mockRestore())));
          assert.strictEqual(result._tag, "Failure");
          const item = Option.getOrThrow(yield* repository.getAttentionItem(blocker.id));
          assert.isNull(item.answer);
          assert.isNull(item.answeredAt);
          assert.isNull(item.supersededAt);
          assert.strictEqual(
            Option.getOrThrow(yield* repository.getTask(lead.task.id)).stage,
            "blocked",
          );
        }),
      ),
    );
  }

  it.effect("does not restore a lead's deliberate block on retry", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Deliberate block", harness.delegate);
        harness.addThread(lead.leadThreadId);
        yield* approvePlan(lead.leadThreadId);
        yield* team.updateTask(lead.leadThreadId, { stage: "blocked" });
        yield* team.recordOutcome({
          task: Option.getOrThrow(yield* repository.getTask(lead.task.id)),
          outcome: "failed",
        });
        const blocker = (yield* repository.listOpenAttentionItems({ projectId: PROJECT_ID }))[0]!;
        yield* team.answerDecision({
          projectId: PROJECT_ID,
          attentionItemId: blocker.id,
          answer: "다시 시도",
        });
        assert.strictEqual(
          Option.getOrThrow(yield* repository.getTask(lead.task.id)).stage,
          "blocked",
        );
        assert.isTrue(
          (yield* Ref.get(harness.sent)).some(
            (message) =>
              message.threadId === lead.leadThreadId && message.text.endsWith("→ 다시 시도"),
          ),
        );
      }),
    ),
  );

  it.effect("replaces a nudge-limit blocker on failure and preserves the lead's own blocker", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Nudged", harness.delegate);
        harness.addThread(lead.leadThreadId);
        yield* team.nudgeTask(pm, { taskId: lead.task.id });
        yield* team.nudgeTask(pm, { taskId: lead.task.id });
        const escalation = yield* team.nudgeTask(pm, { taskId: lead.task.id });
        assert.strictEqual(escalation.status, "escalated");
        const own = yield* team.askUser(lead.leadThreadId, {
          kind: "blocker",
          question: "Need credentials",
        });
        yield* team.recordOutcome({
          task: Option.getOrThrow(yield* repository.getTask(lead.task.id)),
          outcome: "failed",
        });
        const open = yield* repository.listOpenAttentionItems({ projectId: PROJECT_ID });
        assert.strictEqual(open.length, 2);
        assert.isTrue(open.some((item) => item.id === own.item.id));
        assert.strictEqual(open.filter((item) => item.options.length === 2).length, 1);
        const replaced = Option.getOrThrow(
          yield* repository.getAttentionItem(escalation.attentionItem!.id),
        );
        assert.isNotNull(replaced.supersededAt);
        assert.isNull(replaced.answeredAt);
      }),
    ),
  );

  it.effect("keeps unknown failure detail out of the headline", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Fragile", harness.delegate);
        harness.addThread(lead.leadThreadId);
        yield* team.recordOutcome({
          task: lead.task,
          outcome: "failed",
          detail: "mysterious failure",
        });
        const blocker = (yield* repository.listOpenAttentionItems({ projectId: PROJECT_ID }))[0]!;
        assert.strictEqual(
          blocker.question.split("\n")[0],
          `#${lead.task.number} Fragile: 리드 작업이 실패했어요`,
        );
        assert.include(blocker.question, "오류: mysterious failure");
      }),
    ),
  );

  it.effect("journals finished, failed, decided, and reported work in team_status", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const pm = yield* setUpManager;
        const shipped = yield* startLead(pm, "Ship it", harness.delegate);
        const fragile = yield* startLead(pm, "Fragile", harness.delegate);
        yield* team.writeMemory(pm, { topic: "decisions", content: "Use pnpm." });

        // Once the plan is approved it runs, and the plan shows in the journal.
        yield* approvePlan(shipped.leadThreadId);
        yield* team.updateTask(shipped.leadThreadId, {
          stage: "running",
          planSummary: "Add the button, then a journey test.",
        });
        yield* TestClock.adjust("1 minute");
        yield* team.updateTask(shipped.leadThreadId, { stage: "done" });
        yield* TestClock.adjust("1 minute");
        yield* team.recordOutcome({ task: fragile.task, outcome: "failed", detail: "failed" });
        yield* TestClock.adjust("1 minute");
        const blocker = (yield* repository.listOpenAttentionItems({ projectId: PROJECT_ID }))[0]!;
        yield* team.answerAttention(pm, { attentionItemId: blocker.id, answer: "Retry once." });
        yield* TestClock.adjust("1 minute");
        const sitrep = yield* repository.createSitrep({
          id: "sitrep-1" as never,
          projectId: PROJECT_ID,
          since: null,
          reason: "interval",
          createdAt: "2026-11-04T00:04:00.000Z" as never,
        });
        yield* repository.setSitrepBody({
          id: sitrep.id,
          body: "\n1 done, 1 blocked.\n#2 needs a call.",
        });
        // A sitrep still being written stays out.
        yield* repository.createSitrep({
          id: "sitrep-2" as never,
          projectId: PROJECT_ID,
          since: null,
          reason: "interval",
          createdAt: "2026-11-04T00:05:00.000Z" as never,
        });

        const status = yield* team.teamStatus(pm, {});
        assert.deepStrictEqual(
          status.journal.map((entry) => [entry.kind, entry.text]),
          [
            ["sitrep", "1 done, 1 blocked."],
            ["decision", `Decided on #2: ${blocker.question} → Retry once.`],
            ["failed", "#2 failed: Fragile"],
            ["done", "#1 Ship it done"],
            ["decision", "Plan for #1 Ship it: Add the button, then a journey test."],
            ["decision", "Decided on #1: Approve the plan? → Approve and start"],
          ],
        );
        assert.deepStrictEqual(
          ProjectTeamService.buildJournal({
            tasks: [],
            endings: [],
            answered: [{ ...blocker, answer: "x".repeat(300), answeredAt: blocker.createdAt }],
            sitreps: [],
          })[0]?.text.length,
          200,
        );
        assert.deepStrictEqual(status.memoryTopics, ["decisions"]);
      }),
    ),
  );

  it("describes the PM's logged actions in a few words", () => {
    const describe = ProjectTeamService.describeManagerAction;
    const task = (number: number, title: string) => ({ number, title });
    assert.strictEqual(
      describe({ kind: "created", body: "x" }, task(8, "Fix login")),
      "created #8 Fix login",
    );
    assert.strictEqual(
      describe({ kind: "stage_changed", body: "inbox → planning" }, task(7, "Sidebar cleanup")),
      "started #7 Sidebar cleanup",
    );
    assert.strictEqual(
      describe({ kind: "stage_changed", body: "running → cancelled" }, task(3, "Old idea")),
      "cancelled #3 Old idea",
    );
    assert.strictEqual(
      describe({ kind: "nudge", body: "Continue." }, task(5, "Docs")),
      "nudged #5 Docs",
    );
    assert.strictEqual(describe({ kind: "note", body: "hi" }, null), "noted on a task");
  });
});
