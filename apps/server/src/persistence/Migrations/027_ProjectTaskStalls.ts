import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Avoidable stalls: a task's open and finished stall intervals by cause, plus
 * when the server woke the lead and told the user about each, so each stall
 * gets one wake and one message even across a restart. Also a task's hold (a
 * deliberate stop with its resume condition) and whether its current memory
 * stall began while the location setting was local only.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_task_stalls (
      stall_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      cause TEXT NOT NULL,
      started_at TEXT NOT NULL,
      woke_at TEXT,
      notified_at TEXT,
      ended_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_task_stalls_task
    ON project_task_stalls(task_id, ended_at)
  `;
  yield* sql`ALTER TABLE project_tasks ADD COLUMN hold_json TEXT`;
  yield* sql`ALTER TABLE project_tasks ADD COLUMN memory_stall_local_only INTEGER NOT NULL DEFAULT 0`;
});
