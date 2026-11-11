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
import Migration0012 from "./Migrations/012_ProjectManagerKind.ts";
import Migration0013 from "./Migrations/013_ProjectTaskRounds.ts";
import Migration0014 from "./Migrations/014_ProjectTaskReady.ts";
import Migration0015 from "./Migrations/015_ProjectTaskRoleModels.ts";
import Migration0016 from "./Migrations/016_ProjectTaskModelRuns.ts";
import Migration0017 from "./Migrations/017_WorkspaceGoals.ts";

import Migration0018 from "./Migrations/018_ProjectAttentionContext.ts";
import Migration0019 from "./Migrations/019_RemoveTaskProposals.ts";
import Migration0020 from "./Migrations/020_ProjectAttentionOptionalTask.ts";
import Migration0021 from "./Migrations/021_ProjectTaskLocation.ts";
import Migration0022 from "./Migrations/022_ProjectTaskMoveTarget.ts";
import Migration0023 from "./Migrations/023_ProjectAttentionDetails.ts";
import Migration0024 from "./Migrations/024_ProjectAttentionSender.ts";
import Migration0025 from "./Migrations/025_ProjectTaskMemoryHold.ts";
import Migration0026 from "./Migrations/026_ProjectTaskMemoryStallSince.ts";
import Migration0027 from "./Migrations/027_ProjectTaskStalls.ts";

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
  [12, "ProjectManagerKind", Migration0012],
  [13, "ProjectTaskRounds", Migration0013],
  [14, "ProjectTaskReady", Migration0014],
  [15, "ProjectTaskRoleModels", Migration0015],
  [16, "ProjectTaskModelRuns", Migration0016],
  [17, "WorkspaceGoals", Migration0017],
  [18, "ProjectAttentionContext", Migration0018],
  [19, "RemoveTaskProposals", Migration0019],
  [20, "ProjectAttentionOptionalTask", Migration0020],
  [21, "ProjectTaskLocation", Migration0021],
  [22, "ProjectTaskMoveTarget", Migration0022],
  [23, "ProjectAttentionDetails", Migration0023],
  [24, "ProjectAttentionSender", Migration0024],
  [25, "ProjectTaskMemoryHold", Migration0025],
  [26, "ProjectTaskMemoryStallSince", Migration0026],
  [27, "ProjectTaskStalls", Migration0027],
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
