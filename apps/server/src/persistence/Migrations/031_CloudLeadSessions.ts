import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Cloud sandboxes a restarted server attaches to again; one per Mac worktree. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS cloud_lead_sessions (
      worktree_key TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sandbox_name TEXT NOT NULL,
      sandbox_session_id TEXT,
      relay_token_ref TEXT NOT NULL,
      remote_home TEXT NOT NULL,
      remote_cwd TEXT NOT NULL,
      mcp_endpoint TEXT NOT NULL,
      processes_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
