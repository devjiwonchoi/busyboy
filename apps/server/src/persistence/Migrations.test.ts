import { assert, describe, it } from "@effect/vitest";
import {
  OrchestrationV2AppThreadJson,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";
import Migration0001 from "./Migrations/001_Baseline.ts";
import Migration0002 from "./Migrations/002_RewriteThreadSettlementEvents.ts";
import * as OrchestrationEventStore from "./OrchestrationEventStore.ts";

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

describe("runMigrations", () => {
  it.effect("creates the schema on a fresh database and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* runMigrations(), migrationManifest);
      assert.deepStrictEqual(yield* history, migrationManifest);
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
      `;
      assert.isAbove(tables.length, 0);
      const metadata = yield* sql<{ readonly projection_name: string }>`
        SELECT projection_name FROM orchestration_v2_projection_metadata
      `;
      assert.deepStrictEqual(
        metadata.map((row) => row.projection_name),
        ["thread-projections"],
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("preserves legacy attention text and leaves its decision scope unknown", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migrator.make({})({
        loader: Migrator.fromRecord(
          Object.fromEntries(
            migrationEntries
              .filter(([id]) => id < 18)
              .map(([id, name, migration]) => [`${id}_${name}`, migration]),
          ),
        ),
      });
      const at = "2026-11-01T00:00:00.000Z";
      const question =
        "5 runs: 2 succeeded, 3 failed. Estimated $6, limit $15. Uncertainty remains.";
      const options = JSON.stringify(["Use current results", "Rerun for $6-10"]);
      yield* sql`
        INSERT INTO project_tasks (
          task_id, project_id, number, title, request, stage, waits_on_json,
          stage_changed_at, created_at, updated_at
        ) VALUES ('task:legacy', 'project-1', 1, 'Calibration', 'Request', 'running', '[]',
          ${at}, ${at}, ${at})
      `;
      yield* sql`
        INSERT INTO project_attention_items (
          item_id, project_id, task_id, kind, question, options_json, batch_id, created_at
        ) VALUES ('attention:legacy', 'project-1', 'task:legacy', 'decision',
          ${question}, ${options}, 'batch:legacy', ${at})
      `;
      assert.deepStrictEqual(yield* runMigrations(), [
        [18, "ProjectAttentionContext"],
        [19, "RemoveTaskProposals"],
        [20, "ProjectAttentionOptionalTask"],
        [21, "ProjectTaskLocation"],
        [22, "ProjectTaskMoveTarget"],
        [23, "ProjectTaskMemoryHold"],
        [24, "ProjectTaskMemoryStallSince"],
      ]);
      const rows = yield* sql`
        SELECT question, options_json, context_json FROM project_attention_items
        WHERE item_id = 'attention:legacy'
      `;
      assert.deepStrictEqual(rows, [{ question, options_json: options, context_json: null }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("turns open task proposals into Todo tasks and drops proposal cards", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migrator.make({})({
        loader: Migrator.fromRecord(
          Object.fromEntries(
            migrationEntries
              .filter(([id]) => id < 19)
              .map(([id, name, migration]) => [`${id}_${name}`, migration]),
          ),
        ),
      });
      const at = "2026-11-01T00:00:00.000Z";
      yield* sql`
        INSERT INTO project_tasks (
          task_id, project_id, number, title, request, stage, waits_on_json,
          stage_changed_at, created_at, updated_at
        ) VALUES
          ('task:open', 'project-1', 1, 'Open', 'Request', 'proposed', '[]', ${at}, ${at}, ${at}),
          ('task:dropped', 'project-1', 2, 'Dropped', 'Request', 'proposed', '[]',
            ${at}, ${at}, ${at}),
          ('task:running', 'project-1', 3, 'Running', 'Request', 'running', '[]',
            ${at}, ${at}, ${at})
      `;
      yield* sql`
        INSERT INTO project_attention_items (
          item_id, project_id, task_id, kind, question, options_json, batch_id, created_at,
          answer, answered_at
        ) VALUES
          ('attention:open', 'project-1', 'task:open', 'proposal', 'Open', '[]', 'batch:1',
            ${at}, NULL, NULL),
          ('attention:dropped', 'project-1', 'task:dropped', 'proposal', 'Dropped', '[]',
            'batch:2', ${at}, '빼기', ${at}),
          ('attention:decision', 'project-1', 'task:running', 'decision', 'Which?', '[]',
            'batch:3', ${at}, NULL, NULL)
      `;
      assert.deepStrictEqual(yield* runMigrations(), [
        [19, "RemoveTaskProposals"],
        [20, "ProjectAttentionOptionalTask"],
        [21, "ProjectTaskLocation"],
        [22, "ProjectTaskMoveTarget"],
        [23, "ProjectTaskMemoryHold"],
        [24, "ProjectTaskMemoryStallSince"],
      ]);
      const tasks = yield* sql`SELECT task_id, stage FROM project_tasks ORDER BY number`;
      assert.deepStrictEqual(tasks, [
        { task_id: "task:open", stage: "inbox" },
        { task_id: "task:dropped", stage: "cancelled" },
        { task_id: "task:running", stage: "running" },
      ]);
      const items = yield* sql`SELECT item_id FROM project_attention_items`;
      assert.deepStrictEqual(items, [{ item_id: "attention:decision" }]);
      const created = yield* sql`
        SELECT task_id, body FROM project_task_events WHERE kind = 'created'
      `;
      assert.deepStrictEqual(created, [{ task_id: "task:open", body: "Open" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps task cards and accepts cards without a task", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migrator.make({})({
        loader: Migrator.fromRecord(
          Object.fromEntries(
            migrationEntries
              .filter(([id]) => id < 20)
              .map(([id, name, migration]) => [`${id}_${name}`, migration]),
          ),
        ),
      });
      const at = "2026-11-10T00:00:00.000Z";
      yield* sql`
        INSERT INTO project_tasks (
          task_id, project_id, number, title, request, stage, waits_on_json,
          stage_changed_at, created_at, updated_at
        ) VALUES ('task:a', 'project-1', 1, 'A', 'Request', 'running', '[]', ${at}, ${at}, ${at})
      `;
      yield* sql`
        INSERT INTO project_attention_items (
          item_id, project_id, task_id, kind, question, options_json, batch_id, created_at,
          context_json
        ) VALUES ('attention:task', 'project-1', 'task:a', 'blocker', 'Q', '[]', 'batch:1',
          ${at}, '{"action":"a"}')
      `;
      assert.deepStrictEqual(yield* runMigrations(), [
        [20, "ProjectAttentionOptionalTask"],
        [21, "ProjectTaskLocation"],
        [22, "ProjectTaskMoveTarget"],
        [23, "ProjectTaskMemoryHold"],
        [24, "ProjectTaskMemoryStallSince"],
      ]);
      yield* sql`
        INSERT INTO project_attention_items (
          item_id, project_id, task_id, kind, question, options_json, batch_id, created_at
        ) VALUES ('attention:pm', 'project-1', NULL, 'blocker', 'PM', '[]', 'batch:2', ${at})
      `;
      const rows = yield* sql`
        SELECT item_id, task_id, context_json FROM project_attention_items ORDER BY item_id
      `;
      assert.deepStrictEqual(rows, [
        { item_id: "attention:pm", task_id: null, context_json: null },
        { item_id: "attention:task", task_id: "task:a", context_json: '{"action":"a"}' },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rewrites stored thread settlement events as metadata updates", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({ "1_Baseline": Migration0001 }),
      });

      // Settlement events stored the whole thread, including its settlement fields.
      const threadId = ThreadId.make("thread:settled");
      const now = DateTime.makeUnsafe("2026-06-01T00:00:00.000Z");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const thread = yield* Schema.encodeEffect(OrchestrationV2AppThreadJson)({
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:settled"),
        title: "Settled thread",
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      });
      const payloadJson = JSON.stringify({
        ...thread,
        settledOverride: "settled",
        settledAt: thread.createdAt,
        unsettledAt: null,
        autoSettleDisabledAt: null,
        lastSnoozeWakeAt: null,
      });
      const eventTypes = [
        "thread.created",
        "thread.settled",
        "thread.unsettled",
        "thread.auto-settle-set",
        "thread.archived",
      ];
      for (const [streamVersion, eventType] of eventTypes.entries()) {
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            actor_kind, payload_json, metadata_json, application_event_version
          )
          VALUES (
            ${`event:settled:${streamVersion}`}, 'thread', ${threadId}, ${streamVersion},
            ${eventType}, ${thread.createdAt}, 'server', ${payloadJson}, '{}', 2
          )
        `;
      }

      assert.deepStrictEqual(yield* runMigrations(), migrationManifest.slice(1));
      const rows = yield* sql<{ readonly event_type: string; readonly stream_version: number }>`
        SELECT event_type, stream_version FROM orchestration_events ORDER BY sequence
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.stream_version, row.event_type]),
        [
          [0, "thread.created"],
          [1, "thread.metadata-updated"],
          [2, "thread.metadata-updated"],
          [3, "thread.metadata-updated"],
          [4, "thread.archived"],
        ],
      );
      const store = yield* OrchestrationEventStore.OrchestrationEventStore.pipe(
        Effect.provide(OrchestrationEventStore.layer),
      );
      const events = yield* Stream.runCollect(store.readAgentEvents({ threadId }));
      assert.deepStrictEqual(
        events.map((stored) => stored.event.type),
        [
          "thread.created",
          "thread.metadata-updated",
          "thread.metadata-updated",
          "thread.metadata-updated",
          "thread.archived",
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rewrites stored thread snooze events as metadata updates", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({
          "1_Baseline": Migration0001,
          "2_RewriteThreadSettlementEvents": Migration0002,
        }),
      });

      // Snooze events stored the whole thread, including its snooze fields.
      const threadId = ThreadId.make("thread:snoozed");
      const now = DateTime.makeUnsafe("2026-06-01T00:00:00.000Z");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const thread = yield* Schema.encodeEffect(OrchestrationV2AppThreadJson)({
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:snoozed"),
        title: "Snoozed thread",
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        limitRecovery: {
          runId: RunId.make("run:snoozed"),
          resetAt: "2026-06-01T05:00:00.000Z",
          autoResume: false,
        },
        lastVisitedAt: null,
        deletedAt: null,
      });
      const payloadJson = JSON.stringify({
        ...thread,
        snoozedUntil: "2026-06-01T05:00:00.000Z",
        snoozedAt: thread.createdAt,
        limitRecovery: { ...thread.limitRecovery, snooze: true },
      });
      const eventTypes = [
        "thread.created",
        "thread.snoozed",
        "thread.unsnoozed",
        "thread.archived",
      ];
      for (const [streamVersion, eventType] of eventTypes.entries()) {
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            actor_kind, payload_json, metadata_json, application_event_version
          )
          VALUES (
            ${`event:snoozed:${streamVersion}`}, 'thread', ${threadId}, ${streamVersion},
            ${eventType}, ${thread.createdAt}, 'server', ${payloadJson}, '{}', 2
          )
        `;
      }

      assert.deepStrictEqual(yield* runMigrations(), migrationManifest.slice(2));
      const rows = yield* sql<{ readonly event_type: string; readonly stream_version: number }>`
        SELECT event_type, stream_version FROM orchestration_events ORDER BY sequence
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.stream_version, row.event_type]),
        [
          [0, "thread.created"],
          [1, "thread.metadata-updated"],
          [2, "thread.metadata-updated"],
          [3, "thread.archived"],
        ],
      );
      const store = yield* OrchestrationEventStore.OrchestrationEventStore.pipe(
        Effect.provide(OrchestrationEventStore.layer),
      );
      const events = yield* Stream.runCollect(store.readAgentEvents({ threadId }));
      assert.deepStrictEqual(
        events.map((stored) => stored.event.type),
        ["thread.created", "thread.metadata-updated", "thread.metadata-updated", "thread.archived"],
      );
      const rewritten = events[1]!.event;
      assert.strictEqual(rewritten.type, "thread.metadata-updated");
      if (rewritten.type !== "thread.metadata-updated") return;
      assert.notProperty(rewritten.payload, "snoozedUntil");
      assert.notProperty(rewritten.payload, "snoozedAt");
      assert.deepStrictEqual(rewritten.payload.limitRecovery, {
        runId: RunId.make("run:snoozed"),
        resetAt: "2026-06-01T05:00:00.000Z",
        autoResume: false,
      });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect("turns each existing task's request into spec v1 and its lead into a session", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migrator.make({})({
        loader: Migrator.fromRecord(
          Object.fromEntries(
            migrationEntries
              .filter(([id]) => id <= 5)
              .map(([id, name, migration]) => [`${id}_${name}`, migration]),
          ),
        ),
      });
      const at = "2026-11-01T00:00:00.000Z";
      yield* sql`
        INSERT INTO project_tasks (
          task_id, project_id, number, title, request, stage, waits_on_json, lead_thread_id,
          stage_changed_at, created_at, updated_at
        ) VALUES
          ('task:a', 'project-1', 1, 'Started', 'Fix the sidebar.', 'running', '[]', 'lead-a',
            ${at}, ${at}, ${at}),
          ('task:b', 'project-1', 2, 'Inbox', 'Later.', 'inbox', '[]', NULL, ${at}, ${at}, ${at})
      `;

      yield* runMigrations();

      const versions = yield* sql<{
        readonly task_id: string;
        readonly version: number;
        readonly spec_json: string;
        readonly author: string;
      }>`SELECT task_id, version, spec_json, author FROM project_task_spec_versions ORDER BY task_id`;
      assert.deepStrictEqual(
        versions.map((row) => ({ ...row, spec_json: JSON.parse(row.spec_json) })),
        [
          {
            task_id: "task:a",
            version: 1,
            author: "pm",
            spec_json: { background: "Fix the sidebar.", goal: "", nonGoals: "", todos: [] },
          },
          {
            task_id: "task:b",
            version: 1,
            author: "pm",
            spec_json: { background: "Later.", goal: "", nonGoals: "", todos: [] },
          },
        ],
      );
      const sessions = yield* sql<{ readonly task_id: string; readonly thread_id: string }>`
        SELECT task_id, thread_id FROM project_task_sessions
      `;
      assert.deepStrictEqual(sessions, [{ task_id: "task:a", thread_id: "lead-a" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
