import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { defaultPersona, defaultPersonaName } from "./persona.ts";
import { PROJECT_ID, setUpManager, startLead, withTeam } from "./testkit.ts";

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
        assert.strictEqual(fromUser.settings.pinnedUntil, undefined);
        assert.strictEqual(harness.threads.get(pm)?.title, "Remy");

        const fromPm = yield* team.updateSettingsAsManager(pm, {
          name: "Otto",
          avatarEmoji: "🐙",
          voice: "custom",
          voiceCustom: "Pirate talk.",
        });
        assert.deepStrictEqual(fromPm.settings.persona, {
          name: "Otto",
          avatar: { kind: "emoji", emoji: "🐙" },
          voice: "custom",
          voiceCustom: "Pirate talk.",
        });
        assert.isFalse(fromPm.settings.enabled);
        assert.strictEqual(fromPm.settings.pinnedUntil, undefined);
        assert.strictEqual(harness.threads.get(pm)?.title, "Otto");

        const snapshot = yield* team.attentionSnapshot;
        assert.strictEqual(snapshot.projects[0]?.persona.name, "Otto");
        assert.isFalse(snapshot.projects[0]?.enabled);
        assert.isNull(snapshot.projects[0]?.presence.nextSitrepAt);
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
        yield* startLead(pm, "Third", harness.delegate);
        yield* team.createTask(pm, { title: "Later", request: "Later." });
        yield* team.recordOutcome({ task: second.task, outcome: "stalled" });
        yield* team.askUser(first.leadThreadId, { kind: "decision", question: "Which way?" });
        yield* TestClock.adjust("1 minute");
        yield* team.nudgeTask(pm, { taskId: second.task.id });

        const presence = (yield* team.attentionSnapshot).projects[0]!.presence;
        assert.strictEqual(presence.running, 2);
        assert.strictEqual(presence.stalled, 1);
        assert.strictEqual(presence.inbox, 1);
        assert.strictEqual(presence.waitingOnUser, 1);
        assert.deepStrictEqual(presence.lastAction, {
          text: `nudged #${second.task.number}`,
          at: "2026-11-04T00:01:00.000Z",
        });

        yield* TestClock.adjust("1 minute");
        yield* team.updateTask(pm, { taskId: first.task.id, stage: "cancelled" });
        const after = (yield* team.attentionSnapshot).projects[0]!.presence;
        assert.strictEqual(after.lastAction?.text, `cancelled #${first.task.number}`);
        assert.strictEqual(after.running, 1);
      }),
    ),
  );

  it.effect("streams a fresh snapshot when the PM creates a task", () =>
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
        yield* team.createTask(pm, { title: "Later", request: "Later." });
        const snapshots = Array.from(yield* Fiber.join(fiber));
        assert.strictEqual(snapshots[0]?.projects[0]?.presence.inbox, 0);
        assert.strictEqual(snapshots[1]?.projects[0]?.presence.inbox, 1);
        assert.strictEqual(snapshots[1]?.projects[0]?.presence.lastAction?.text, "created #1");
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
    assert.strictEqual(describe({ kind: "created", body: "x" }, 8), "created #8");
    assert.strictEqual(
      describe({ kind: "stage_changed", body: "inbox → planning" }, 7),
      "started #7",
    );
    assert.strictEqual(
      describe({ kind: "stage_changed", body: "running → cancelled" }, 3),
      "cancelled #3",
    );
    assert.strictEqual(describe({ kind: "nudge", body: "Continue." }, 5), "nudged #5");
    assert.strictEqual(describe({ kind: "note", body: "hi" }, null), "noted on a task");
  });
});
