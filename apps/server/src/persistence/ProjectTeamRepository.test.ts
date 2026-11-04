import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_TEAM_SETTINGS,
  ProjectAttentionBatchId,
  ProjectAttentionItemId,
  ProjectId,
  ProjectMemoryEntryId,
  ProjectSitrepId,
  ProjectTaskEventId,
  ProjectTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectTeamRepository from "./ProjectTeamRepository.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const testLayer = ProjectTeamRepository.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const pmThreadId = ThreadId.make("thread-pm");
const leadThreadId = ThreadId.make("thread-lead");
const t0 = "2026-11-04T00:00:00.000Z";
const t1 = "2026-11-04T00:01:00.000Z";
const t2 = "2026-11-04T00:02:00.000Z";

const repo = ProjectTeamRepository.ProjectTeamRepository;

describe("ProjectTeamRepository", () => {
  it.effect("keeps one manager per project and its settings across thread changes", () =>
    Effect.gen(function* () {
      const team = yield* repo;
      const created = yield* team.upsertManager({
        projectId,
        threadId: pmThreadId,
        settings: DEFAULT_PROJECT_TEAM_SETTINGS,
        now: t0,
      });
      assert.deepStrictEqual(created.settings, DEFAULT_PROJECT_TEAM_SETTINGS);
      assert.strictEqual(created.unreadSitrepStreak, 0);

      const pinned = {
        ...DEFAULT_PROJECT_TEAM_SETTINGS,
        sitrepIntervalMinutes: 30,
        pinnedUntil: t2,
      };
      yield* team.updateManagerSettings({ projectId, settings: pinned, now: t1 });

      const replaced = yield* team.upsertManager({
        projectId,
        threadId: ThreadId.make("thread-pm-2"),
        settings: DEFAULT_PROJECT_TEAM_SETTINGS,
        now: t2,
      });
      assert.strictEqual(replaced.threadId, "thread-pm-2");
      assert.deepStrictEqual(replaced.settings, pinned);
      assert.strictEqual((yield* team.listManagers()).length, 1);
      assert.isTrue(Option.isNone(yield* team.getManagerByThreadId(pmThreadId)));
      assert.isTrue(Option.isSome(yield* team.getManagerByThreadId(ThreadId.make("thread-pm-2"))));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("tracks the unread sitrep streak and user messages", () =>
    Effect.gen(function* () {
      const team = yield* repo;
      yield* team.upsertManager({
        projectId,
        threadId: pmThreadId,
        settings: DEFAULT_PROJECT_TEAM_SETTINGS,
        now: t0,
      });
      yield* team.recordSitrepPosted({ projectId, at: t0 });
      const afterTwo = yield* team.recordSitrepPosted({ projectId, at: t1 });
      assert.strictEqual(Option.getOrThrow(afterTwo).unreadSitrepStreak, 2);
      assert.strictEqual(Option.getOrThrow(afterTwo).lastSitrepAt, t1);

      const afterMessage = Option.getOrThrow(yield* team.recordUserMessage({ projectId, at: t2 }));
      assert.strictEqual(afterMessage.unreadSitrepStreak, 0);
      assert.strictEqual(afterMessage.lastUserMessageAt, t2);

      yield* team.setUnreadSitrepStreak({ projectId, streak: 3, now: t2 });
      assert.strictEqual(
        Option.getOrThrow(yield* team.getManager(projectId)).unreadSitrepStreak,
        3,
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("numbers tasks per project and resets nudges on stage change", () =>
    Effect.gen(function* () {
      const team = yield* repo;
      const first = yield* team.createTask({
        id: ProjectTaskId.make("task-1"),
        projectId,
        title: "Add hello.sh",
        request: "Add hello.sh with a test",
        waitsOn: [],
        now: t0,
      });
      const second = yield* team.createTask({
        id: ProjectTaskId.make("task-2"),
        projectId,
        title: "Add goodbye.sh",
        request: "Add goodbye.sh with a test",
        waitsOn: [first.id],
        now: t0,
      });
      const elsewhere = yield* team.createTask({
        id: ProjectTaskId.make("task-3"),
        projectId: otherProjectId,
        title: "Other",
        request: "Other project",
        waitsOn: [],
        now: t0,
      });
      assert.deepStrictEqual([first.number, second.number, elsewhere.number], [1, 2, 1]);
      assert.strictEqual(first.stage, "inbox");
      assert.deepStrictEqual(second.waitsOn, [first.id]);

      const started = Option.getOrThrow(
        yield* team.updateTask({
          id: first.id,
          now: t1,
          stage: "planning",
          leadThreadId,
        }),
      );
      assert.strictEqual(started.stage, "planning");
      assert.strictEqual(started.stageChangedAt, t1);

      const nudged = Option.getOrThrow(
        yield* team.updateTask({ id: first.id, now: t2, nudgeCount: 2, lastOutcome: "stalled" }),
      );
      assert.strictEqual(nudged.nudgeCount, 2);
      assert.strictEqual(nudged.stageChangedAt, t1);
      assert.strictEqual(nudged.lastOutcome, "stalled");

      const sameStage = Option.getOrThrow(
        yield* team.updateTask({ id: first.id, now: t2, stage: "planning" }),
      );
      assert.strictEqual(sameStage.nudgeCount, 2);

      const running = Option.getOrThrow(
        yield* team.updateTask({ id: first.id, now: t2, stage: "running", planSummary: "Plan A" }),
      );
      assert.strictEqual(running.nudgeCount, 0);
      assert.strictEqual(running.stageChangedAt, t2);
      assert.strictEqual(running.leadThreadId, leadThreadId);

      const byLead = yield* team.findTaskByLeadThreadId(leadThreadId);
      assert.strictEqual(Option.getOrThrow(byLead).id, first.id);

      const active = yield* team.listTasks({ projectId, stages: ["planning", "running"] });
      assert.deepStrictEqual(
        active.map((task) => task.id),
        ["task-1"],
      );
      assert.strictEqual((yield* team.listTasks({ projectId })).length, 2);
      assert.strictEqual((yield* team.listTasks({ projectId, stages: [] })).length, 0);
      assert.isTrue(
        Option.isNone(yield* team.updateTask({ id: ProjectTaskId.make("missing"), now: t2 })),
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("searches titles, requests and summaries with literal wildcards", () =>
    Effect.gen(function* () {
      const team = yield* repo;
      const task = yield* team.createTask({
        id: ProjectTaskId.make("task-1"),
        projectId,
        title: "Auth refactor",
        request: "Move sessions to SQLite",
        waitsOn: [],
        now: t0,
      });
      yield* team.createTask({
        id: ProjectTaskId.make("task-2"),
        projectId,
        title: "Docs",
        request: "Write 100% coverage notes",
        waitsOn: [],
        now: t0,
      });
      yield* team.updateTask({ id: task.id, now: t1, planSummary: "Use a token bucket" });

      const byPlan = yield* team.searchTasks({ projectId, query: "TOKEN bucket", limit: 10 });
      assert.deepStrictEqual(
        byPlan.map((row) => row.id),
        ["task-1"],
      );
      const percent = yield* team.searchTasks({ projectId, query: "100%", limit: 10 });
      assert.deepStrictEqual(
        percent.map((row) => row.id),
        ["task-2"],
      );
      assert.strictEqual((yield* team.searchTasks({ projectId, query: "%", limit: 10 })).length, 1);
      assert.strictEqual(
        (yield* team.searchTasks({ projectId: otherProjectId, query: "Auth", limit: 10 })).length,
        0,
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("appends task and project events and lists the latest ones in order", () =>
    Effect.gen(function* () {
      const team = yield* repo;
      const task = yield* team.createTask({
        id: ProjectTaskId.make("task-1"),
        projectId,
        title: "Task",
        request: "Request",
        waitsOn: [],
        now: t0,
      });
      const append = (id: string, kind: "created" | "nudge" | "outcome", at: string) =>
        team.appendTaskEvent({
          id: ProjectTaskEventId.make(id),
          projectId,
          taskId: task.id,
          kind,
          body: id,
          actorThreadId: pmThreadId,
          createdAt: at,
        });
      yield* append("e1", "created", t0);
      yield* append("e2", "nudge", t1);
      yield* append("e3", "outcome", t1);
      yield* team.appendTaskEvent({
        id: ProjectTaskEventId.make("e4"),
        projectId,
        taskId: null,
        kind: "preference_changed",
        body: "interval 60 -> 30",
        actorThreadId: null,
        createdAt: t2,
      });

      const latest = yield* team.listTaskEvents({ taskId: task.id, limit: 2 });
      assert.deepStrictEqual(
        latest.map((event) => event.id),
        ["e2", "e3"],
      );
      const since = yield* team.listProjectEventsSince({ projectId, since: t0 });
      assert.deepStrictEqual(
        since.map((event) => event.id),
        ["e2", "e3", "e4"],
      );
      assert.strictEqual(since[2]?.taskId, null);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("creates, batches and answers attention items once", () =>
    Effect.gen(function* () {
      const team = yield* repo;
      const task = yield* team.createTask({
        id: ProjectTaskId.make("task-1"),
        projectId,
        title: "Task",
        request: "Request",
        waitsOn: [],
        now: t0,
      });
      const batchId = ProjectAttentionBatchId.make("batch-1");
      const approval = yield* team.createAttentionItem({
        id: ProjectAttentionItemId.make("item-1"),
        projectId,
        taskId: task.id,
        kind: "approval",
        question: "Approve the plan?",
        options: ["yes", "no"],
        askerThreadId: leadThreadId,
        batchId,
        createdAt: t0,
      });
      assert.deepStrictEqual(approval.options, ["yes", "no"]);
      yield* team.createAttentionItem({
        id: ProjectAttentionItemId.make("item-2"),
        projectId,
        taskId: task.id,
        kind: "blocker",
        question: "Need a token",
        options: [],
        askerThreadId: null,
        batchId,
        createdAt: t1,
      });

      const latest = Option.getOrThrow(yield* team.getLatestAttentionItem(projectId));
      assert.strictEqual(latest.id, "item-2");
      assert.strictEqual(latest.batchId, batchId);

      const answered = yield* team.answerAttentionItem({
        id: approval.id,
        answer: "yes",
        answeredAt: t2,
      });
      assert.strictEqual(Option.getOrThrow(answered).answer, "yes");
      assert.isTrue(
        Option.isNone(
          yield* team.answerAttentionItem({ id: approval.id, answer: "no", answeredAt: t2 }),
        ),
      );
      assert.strictEqual(
        Option.getOrThrow(yield* team.getAttentionItem(approval.id)).answeredAt,
        t2,
      );

      const open = yield* team.listOpenAttentionItems({ projectId });
      assert.deepStrictEqual(
        open.map((item) => item.id),
        ["item-2"],
      );
      assert.strictEqual(
        (yield* team.listOpenAttentionItems({ projectId, taskId: ProjectTaskId.make("other") }))
          .length,
        0,
      );
      const since = yield* team.listAttentionItemsSince({ projectId, since: t0 });
      assert.deepStrictEqual(
        since.map((item) => item.id),
        ["item-2"],
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("upserts memory by topic and deletes it", () =>
    Effect.gen(function* () {
      const team = yield* repo;
      const first = yield* team.upsertMemory({
        id: ProjectMemoryEntryId.make("mem-1"),
        projectId,
        topic: "testing",
        content: "Use vitest",
        updatedAt: t0,
      });
      const replaced = yield* team.upsertMemory({
        id: ProjectMemoryEntryId.make("mem-2"),
        projectId,
        topic: "testing",
        content: "Run only changed tests",
        updatedAt: t1,
      });
      assert.strictEqual(replaced.id, first.id);
      assert.strictEqual(replaced.content, "Run only changed tests");
      yield* team.upsertMemory({
        id: ProjectMemoryEntryId.make("mem-3"),
        projectId,
        topic: "commits",
        content: "Imperative mood",
        updatedAt: t1,
      });
      assert.deepStrictEqual(
        (yield* team.listMemory(projectId)).map((entry) => entry.topic),
        ["commits", "testing"],
      );
      assert.isTrue(yield* team.deleteMemory({ projectId, topic: "testing" }));
      assert.isFalse(yield* team.deleteMemory({ projectId, topic: "testing" }));
      assert.strictEqual((yield* team.listMemory(projectId)).length, 1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("creates sitreps, posts bodies and marks them read", () =>
    Effect.gen(function* () {
      const team = yield* repo;
      const first = yield* team.createSitrep({
        id: ProjectSitrepId.make("sitrep-1"),
        projectId,
        since: null,
        reason: "milestone",
        createdAt: t0,
      });
      assert.strictEqual(first.body, null);
      assert.strictEqual(yield* team.countUnreadSitreps(projectId), 0);

      yield* team.setSitrepBody({ id: first.id, body: "#1 done" });
      yield* team.createSitrep({
        id: ProjectSitrepId.make("sitrep-2"),
        projectId,
        since: t0,
        reason: "requested",
        createdAt: t1,
      });
      assert.strictEqual(yield* team.countUnreadSitreps(projectId), 1);
      const latest = Option.getOrThrow(yield* team.getLatestSitrep(projectId));
      assert.strictEqual(latest.id, "sitrep-2");
      assert.strictEqual(latest.since, t0);

      assert.strictEqual(yield* team.markSitrepsRead({ projectId, readAt: t2 }), 1);
      assert.strictEqual(yield* team.countUnreadSitreps(projectId), 0);
      assert.isTrue(Option.isNone(yield* team.getLatestSitrep(otherProjectId)));
    }).pipe(Effect.provide(testLayer)),
  );
});
