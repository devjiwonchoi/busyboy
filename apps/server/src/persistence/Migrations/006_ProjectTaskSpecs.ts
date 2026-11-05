import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Tasks as versioned specs: a parent task, every spec version, and the agent
 * threads working on each task. Existing tasks get their request as spec v1
 * and their lead thread as a session.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE project_tasks ADD COLUMN parent_task_id TEXT`;
  yield* sql`CREATE INDEX idx_project_tasks_parent ON project_tasks(parent_task_id) WHERE parent_task_id IS NOT NULL`;

  yield* sql`
    CREATE TABLE project_task_spec_versions (
      task_id TEXT NOT NULL REFERENCES project_tasks(task_id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      spec_json TEXT NOT NULL,
      author TEXT NOT NULL,
      author_thread_id TEXT,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, version)
    )
  `;

  yield* sql`
    CREATE TABLE project_task_sessions (
      task_id TEXT NOT NULL REFERENCES project_tasks(task_id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, thread_id)
    )
  `;
  yield* sql`CREATE INDEX idx_project_task_sessions_thread ON project_task_sessions(thread_id)`;

  yield* sql`
    INSERT INTO project_task_spec_versions (
      task_id, version, spec_json, author, author_thread_id, note, created_at
    )
    SELECT
      task_id,
      1,
      json_object('background', request, 'goal', '', 'nonGoals', '', 'todos', json('[]')),
      'pm',
      NULL,
      'Created',
      created_at
    FROM project_tasks
  `;
  yield* sql`
    INSERT INTO project_task_sessions (task_id, thread_id, role, created_at)
    SELECT task_id, lead_thread_id, 'lead', stage_changed_at
    FROM project_tasks
    WHERE lead_thread_id IS NOT NULL
  `;
});
