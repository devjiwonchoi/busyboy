// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";

it.effect("includes committed WAL data and does not publish a failed snapshot", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-snapshot-"));
  const sourcePath = NodePath.join(directory, "state.sqlite");
  const destinationPath = NodePath.join(directory, "statev2.sqlite");
  return Effect.gen(function* () {
    NodeFS.writeFileSync(sourcePath, "invalid SQLite");
    assert.isTrue((yield* Effect.result(initializeV2Database(destinationPath)))._tag === "Failure");
    assert.isFalse(NodeFS.existsSync(destinationPath));
    NodeFS.unlinkSync(sourcePath);
    const source = new NodeSqlite.DatabaseSync(sourcePath);
    try {
      source.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES ('committed'); BEGIN; INSERT INTO messages VALUES ('uncommitted');",
      );
      yield* initializeV2Database(destinationPath);
      const copy = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
      try {
        assert.deepEqual(
          copy
            .prepare("SELECT text FROM messages")
            .all()
            .map((row) => row.text),
          ["committed"],
        );
      } finally {
        copy.close();
      }
      source.exec("ROLLBACK");
    } finally {
      source.close();
    }
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("uses statev2.sqlite for default and explicit development paths", () =>
  Effect.gen(function* () {
    for (const devUrl of [undefined, new URL("http://localhost:5173")]) {
      for (const baseDirIsExplicit of [false, true]) {
        const paths = yield* ServerConfig.deriveServerPaths("/tmp/t3", devUrl, {
          baseDirIsExplicit,
        });
        assert.equal(NodePath.basename(paths.dbPath), "statev2.sqlite");
        assert.equal(paths.settingsPath, NodePath.join(paths.stateDir, "settings.json"));
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("starts fresh without V1 and never imports over existing V2 state", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-fresh-"));
  const destinationPath = NodePath.join(directory, "userdata", "statev2.sqlite");
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const layerDatabase = SqlitePersistence.layerConfig.pipe(
      Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE v2_work (text TEXT)`;
      yield* sql`INSERT INTO v2_work VALUES ('fresh V2 work')`;
    }).pipe(Effect.provide(layerDatabase));
    const sourcePath = NodePath.join(NodePath.dirname(destinationPath), "state.sqlite");
    assert.isFalse(NodeFS.existsSync(sourcePath));
    NodeFS.writeFileSync(sourcePath, "This source must never be opened once V2 exists");
    yield* initializeV2Database(destinationPath);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "fresh V2 work");
    }).pipe(Effect.provide(layerDatabase));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});
