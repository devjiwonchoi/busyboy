import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";

import Migration0001 from "./Migrations/001_Baseline.ts";
import Migration0002 from "./Migrations/002_RewriteThreadSettlementEvents.ts";
import Migration0003 from "./Migrations/003_RewriteThreadSnoozeEvents.ts";

export const migrationEntries = [
  [1, "Baseline", Migration0001],
  [2, "RewriteThreadSettlementEvents", Migration0002],
  [3, "RewriteThreadSnoozeEvents", Migration0003],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const loader = Migrator.fromRecord(
  Object.fromEntries(migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration])),
);

const run = Migrator.make({});

export const runMigrations = Effect.fn("runMigrations")(function* () {
  const executedMigrations = yield* run({ loader });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});
