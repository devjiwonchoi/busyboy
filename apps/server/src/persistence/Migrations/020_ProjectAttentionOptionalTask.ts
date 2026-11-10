import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A card can be about the project instead of a task, e.g. a PM blocked on a
 * permission denial. SQLite cannot drop NOT NULL in place, so the table is rebuilt.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE project_attention_items_next (
      item_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT REFERENCES project_tasks(task_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL,
      answer TEXT,
      answered_at TEXT,
      asker_thread_id TEXT,
      batch_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      superseded_at TEXT,
      answered_by TEXT,
      spec_version INTEGER,
      summary TEXT,
      verification TEXT,
      context_json TEXT
    )
  `;
  yield* sql`
    INSERT INTO project_attention_items_next (
      item_id, project_id, task_id, kind, question, options_json, answer, answered_at,
      asker_thread_id, batch_id, created_at, superseded_at, answered_by, spec_version,
      summary, verification, context_json
    )
    SELECT item_id, project_id, task_id, kind, question, options_json, answer, answered_at,
      asker_thread_id, batch_id, created_at, superseded_at, answered_by, spec_version,
      summary, verification, context_json
    FROM project_attention_items
  `;
  yield* sql`DROP TABLE project_attention_items`;
  yield* sql`ALTER TABLE project_attention_items_next RENAME TO project_attention_items`;
  yield* sql`CREATE INDEX idx_project_attention_items_project ON project_attention_items(project_id, created_at)`;
  yield* sql`CREATE INDEX idx_project_attention_items_open ON project_attention_items(project_id, task_id) WHERE answered_at IS NULL`;
  yield* sql`CREATE INDEX idx_project_attention_items_asker ON project_attention_items(asker_thread_id) WHERE answered_at IS NULL`;
});
