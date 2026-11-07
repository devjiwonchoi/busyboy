import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Time, tokens and estimated cost per model session of a task, and outcome counts per
 * task, kept so model choices can be compared later.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_task_model_runs (
      task_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      model TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      run_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      PRIMARY KEY (task_id, thread_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_task_model_runs_thread
    ON project_task_model_runs(thread_id)
  `;
  yield* sql`ALTER TABLE project_tasks ADD COLUMN step_usage_json TEXT NOT NULL DEFAULT '{}'`;
  yield* sql`ALTER TABLE project_tasks ADD COLUMN metrics_json TEXT NOT NULL DEFAULT '{}'`;
});
