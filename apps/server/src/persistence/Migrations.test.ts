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

import { migrationManifest, runMigrations } from "./Migrations.ts";
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
});
