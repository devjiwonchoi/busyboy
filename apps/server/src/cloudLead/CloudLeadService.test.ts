import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { sqlCloudSessionStore } from "./CloudLeadService.ts";
import type { CloudSessionRecord } from "./CloudSessionStore.ts";

const memorySecrets = () => {
  const values = new Map<string, Uint8Array>();
  return {
    values,
    get: (name: string) => Effect.succeed(Option.fromNullishOr(values.get(name))),
    set: (name: string, value: Uint8Array) => Effect.sync(() => void values.set(name, value)),
    remove: (name: string) => Effect.sync(() => void values.delete(name)),
  } as unknown as ServerSecretStore["Service"] & { readonly values: Map<string, Uint8Array> };
};

const record: CloudSessionRecord = {
  worktreeKey: "/mac/worktrees/task",
  threadId: "lead",
  sandboxName: "sbx-1",
  sandboxSessionId: "sess-1",
  relayTokenRef: "cloud-lead-relay-abc",
  remoteHome: "/home/vercel-sandbox",
  remoteCwd: "/home/vercel-sandbox/busyboy",
  mcpEndpoint: "http://127.0.0.1:3773/mcp",
  processes: [{ id: "sid:p1", threadId: "lead", claudeSessionId: "claude-1" }],
  createdAt: 1_762_000_000_000,
};

describe("sqlCloudSessionStore", () => {
  it.effect(
    "keeps cloud sessions across a server restart, with the relay bearer outside the table",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const secrets = memorySecrets();
        const store = sqlCloudSessionStore(sql, secrets);
        yield* Effect.promise(async () => {
          await store.save(record);
          await store.saveToken(record.relayTokenRef, "relay-bearer");
          await store.save({ ...record, sandboxSessionId: "sess-2", processes: [] });
        });

        // A new store over the same database: what a restarted server reads.
        const again = sqlCloudSessionStore(sql, secrets);
        const listed = yield* Effect.promise(() => again.list());
        assert.deepStrictEqual(listed, [{ ...record, sandboxSessionId: "sess-2", processes: [] }]);
        assert.strictEqual(
          yield* Effect.promise(() => again.readToken(record.relayTokenRef)),
          "relay-bearer",
        );
        const rows = yield* sql`SELECT * FROM cloud_lead_sessions`;
        assert.notInclude(JSON.stringify(rows), "relay-bearer");

        yield* Effect.promise(async () => {
          await again.remove(record.worktreeKey);
          await again.removeToken(record.relayTokenRef);
        });
        assert.deepStrictEqual(yield* Effect.promise(() => again.list()), []);
        assert.strictEqual(
          yield* Effect.promise(() => again.readToken(record.relayTokenRef)),
          null,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
