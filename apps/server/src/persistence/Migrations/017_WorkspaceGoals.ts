import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The user's workspace goals, kept by the Director, and the projects and tasks linked
 * to each. A project link has no task.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_goals (
      goal_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      detail TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_goal_links (
      goal_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      task_id TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_goal_links_unique
    ON workspace_goal_links(goal_id, project_id, COALESCE(task_id, ''))
  `;
});
