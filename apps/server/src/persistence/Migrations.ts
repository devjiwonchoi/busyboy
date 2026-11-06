import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";

import Migration0001 from "./Migrations/001_Baseline.ts";
import Migration0002 from "./Migrations/002_RewriteThreadSettlementEvents.ts";
import Migration0003 from "./Migrations/003_RewriteThreadSnoozeEvents.ts";
import Migration0004 from "./Migrations/004_ProjectTeam.ts";
import Migration0005 from "./Migrations/005_ProjectAttentionSuperseded.ts";
import Migration0006 from "./Migrations/006_ProjectTaskSpecs.ts";
import Migration0007 from "./Migrations/007_CloseFinishedTaskAttention.ts";
import Migration0008 from "./Migrations/008_ProjectAttentionAnsweredBy.ts";
import Migration0009 from "./Migrations/009_ProjectAttentionSpecVersion.ts";
import Migration0010 from "./Migrations/010_ProjectAttentionSummary.ts";
import Migration0011 from "./Migrations/011_ProjectAttentionVerification.ts";

export const migrationEntries = [
  [1, "Baseline", Migration0001],
  [2, "RewriteThreadSettlementEvents", Migration0002],
  [3, "RewriteThreadSnoozeEvents", Migration0003],
  [4, "ProjectTeam", Migration0004],
  [5, "ProjectAttentionSuperseded", Migration0005],
  [6, "ProjectTaskSpecs", Migration0006],
  [7, "CloseFinishedTaskAttention", Migration0007],
  [8, "ProjectAttentionAnsweredBy", Migration0008],
  [9, "ProjectAttentionSpecVersion", Migration0009],
  [10, "ProjectAttentionSummary", Migration0010],
  [11, "ProjectAttentionVerification", Migration0011],
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
