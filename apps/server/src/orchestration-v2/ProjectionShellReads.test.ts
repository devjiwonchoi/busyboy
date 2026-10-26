import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerSql = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
const old = DateTime.subtract(now, { days: 10 });
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "test-model" };
const encodeNumbers = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Number)));

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:shell-reads:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:shell-reads"),
    title: name,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: old,
    updatedAt: old,
    archivedAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* store.apply({
    id: EventId.make(`event:${threadId}`),
    type: "thread.created",
    threadId,
    occurredAt: old,
    payload: thread,
  });
  return threadId;
});

const createRun = Effect.fn(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"] = "completed",
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const runId = RunId.make(`run:${threadId}:1`);
  yield* store.apply({
    id: EventId.make(`event:${runId}`),
    type: "run.created",
    threadId,
    occurredAt: old,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: old,
      startedAt: status === "queued" ? null : old,
      completedAt: ["completed", "rolled_back", "failed"].includes(status) ? old : null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  return runId;
});

const createItem = Effect.fn(function* (threadId: ThreadId, runId: RunId) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make(`event:item:${runId}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: old,
    payload: {
      id: TurnItemId.make(`item:${runId}`),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "dynamic_tool",
      status: "completed",
      title: null,
      startedAt: old,
      completedAt: old,
      updatedAt: old,
      toolName: "background",
      input: null,
      output: null,
    },
  });
});

it.effect.each([
  ["sql", layerSql],
  ["memory", ProjectionStore.layerMemory],
] as const)("%s: the user-authored message time ignores agent notifications", ([, testLayer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* createThread("agent-woken");
    yield* createRun(threadId);
    const message = (
      id: string,
      createdBy: "user" | "agent",
      creationSource: "web" | "provider",
      at: DateTime.Utc,
    ) =>
      store.apply({
        id: EventId.make(`event:shell-reads:${id}`),
        type: "message.updated",
        threadId,
        occurredAt: at,
        payload: {
          createdBy,
          creationSource,
          id: MessageId.make(`message:shell-reads:${id}`),
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text: id,
          attachments: [],
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      });
    const written = DateTime.subtract(now, { hours: 2 });
    yield* message("written", "user", "web", written);
    yield* message("notification", "agent", "provider", now);

    const shellThread = (yield* store.getShellSnapshot()).threads.find(
      (thread) => thread.id === threadId,
    );
    assert.equal(DateTime.formatIso(shellThread!.latestUserMessageAt!), DateTime.formatIso(now));
    assert.equal(
      DateTime.formatIso(shellThread!.latestUserAuthoredMessageAt!),
      DateTime.formatIso(written),
    );
  }).pipe(Effect.provide(testLayer)),
);

const pullRequestLink = (number: number) => ({
  host: "github.com",
  repository: "owner/repository",
  number,
  url: `https://github.com/owner/repository/pull/${number}`,
  source: "manual" as const,
  linkedAt: DateTime.formatIso(old),
  snapshot: null,
  stack: null,
});

it.effect.each([
  ["sql", layerSql],
  ["memory", ProjectionStore.layerMemory],
] as const)(
  "%s: lists only active threads with pull request links, oldest first",
  ([, testLayer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* createThread("no-links");
      yield* createThread("empty-links", { pullRequests: [] });
      yield* createThread("archived-link", {
        archivedAt: old,
        pullRequests: [pullRequestLink(1)],
      });
      const older = yield* createThread("older-link", {
        updatedAt: DateTime.subtract(now, { days: 12 }),
        pullRequests: [pullRequestLink(2)],
      });
      const open = yield* createThread("open-link", {
        pullRequests: [pullRequestLink(3), pullRequestLink(4)],
      });

      const threads = yield* store.getThreadsWithPullRequests();
      assert.deepEqual(
        threads.map((thread) => [thread.id, thread.pullRequests?.length]),
        [
          [older, 1],
          [open, 2],
        ],
      );
      assert.deepEqual(
        (yield* store.getThreadsWithPullRequests(open)).map((thread) => thread.id),
        [open],
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "reads shell work through its index and thread metadata without loading historical or archived payloads",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const source = yield* createThread("historical-source", { archivedAt: old });
      const sourceRun = yield* createRun(source);
      const threadId = yield* createThread("fork", {
        forkedFrom: { type: "run", threadId: source, runId: sourceRun },
      });
      const runId = yield* createRun(threadId);
      yield* createItem(threadId, runId);
      const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      const record: Statement.Transformer = (statement) =>
        Effect.sync(() => {
          queries.push(statement.compile());
          return statement;
        });
      const shell = yield* store
        .getShellSnapshot({ location: "active" })
        .pipe(Effect.provideService(Statement.CurrentTransformer, record));
      assert.deepEqual(
        shell.threads.map((thread) => thread.id),
        [threadId],
      );
      const pendingQuery = queries.find(([query]) =>
        query.includes("AS owning_provider_instance_id"),
      );
      assert.isDefined(pendingQuery);
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = '{broken' WHERE thread_id = ${threadId}`;
      yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = '{broken' WHERE thread_id = ${source}`;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
      SELECT 'history:' || value, i.thread_id, i.run_id, i.node_id, i.provider_thread_id, i.provider_turn_id,
        i.parent_item_id, i.ordinal + value, i.type, i.status, i.updated_at, i.payload_json
      FROM orchestration_v2_projection_turn_items i, json_each(${encodeNumbers(Array.from({ length: 2000 }, (_, i) => i + 1))})
      WHERE i.thread_id = ${threadId}`;
      const metadata = yield* store.getThread(threadId);
      assert.equal(metadata.id, threadId);
      assert.equal((yield* store.getThreadProjection(threadId).pipe(Effect.exit))._tag, "Failure");
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${pendingQuery![0]}`,
        pendingQuery![1],
      );
      assert.isTrue(plan.some((row) => row.detail.includes("turn_items_shell_pending_idx")));
      const countsPlan = yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
      SELECT thread_id, run_id, COUNT(*) FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId} AND run_id IS NOT NULL GROUP BY thread_id, run_id`;
      assert.isTrue(
        countsPlan.some((row) =>
          row.detail.includes(
            "COVERING INDEX orchestration_v2_projection_turn_items_thread_run_idx",
          ),
        ),
      );
      assert.isFalse(countsPlan.some((row) => row.detail.includes("TEMP B-TREE")));
      const messagePlan = yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
      SELECT updated_at FROM orchestration_v2_projection_messages
      WHERE thread_id = ${threadId} AND role = 'user' ORDER BY updated_at DESC, message_id DESC LIMIT 1`;
      assert.isTrue(messagePlan.some((row) => row.detail.includes("messages_latest_user_idx")));
      assert.isFalse(messagePlan.some((row) => row.detail.includes("TEMP B-TREE")));
    }).pipe(Effect.provide(layerSql)),
);

it.effect("shell failure lookups stay on the thread's own turn items", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const failed = yield* createThread("failed-latest");
    yield* createRun(failed, "failed");
    const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
    const record: Statement.Transformer = (statement) =>
      Effect.sync(() => {
        queries.push(statement.compile());
        return statement;
      });
    const shell = yield* store
      .getShellSnapshot()
      .pipe(Effect.provideService(Statement.CurrentTransformer, record));
    assert.deepEqual(
      shell.threads.map((thread) => thread.id),
      [failed],
    );
    const shellQuery = queries.find(([query]) =>
      query.includes("AS blocking_failure_payload_json"),
    );
    assert.isDefined(shellQuery);
    const plan = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${shellQuery![0]}`,
      shellQuery![1],
    );
    const itemLookups = plan.filter((row) => row.detail.startsWith("SEARCH item "));
    assert.lengthOf(itemLookups, 2);
    assert.isTrue(itemLookups.every((row) => row.detail.includes("turn_items_failed_error_idx")));
    const secretLookups = plan.filter((row) => row.detail.startsWith("SEARCH secret "));
    assert.lengthOf(secretLookups, 1);
    assert.include(secretLookups[0]!.detail, "turn_items_thread_run_idx");
  }).pipe(Effect.provide(layerSql)),
);
