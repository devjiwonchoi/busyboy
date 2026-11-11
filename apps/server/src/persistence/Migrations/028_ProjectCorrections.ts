import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Moments the user corrected agent work (plan feedback, a change of direction,
 * PR change requests, reverts). `source_key` dedupes rows recorded twice.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_corrections (
      correction_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      stage TEXT NOT NULL,
      work_kind TEXT NOT NULL,
      user_text TEXT NOT NULL,
      what_differed TEXT NOT NULL,
      source_key TEXT NOT NULL UNIQUE,
      backfilled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `;
  // When live recording started: the startup backfill fills only older moments, so a
  // moment the PM also records live is never counted twice.
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_correction_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO project_correction_state (key, value)
    VALUES ('recording_started_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_corrections_project_created
    ON project_corrections(project_id, created_at)
  `;
});
