import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Closes questions left open on tasks that were already done or cancelled. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE project_attention_items
    SET superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE answered_at IS NULL
      AND superseded_at IS NULL
      AND task_id IN (
        SELECT task_id FROM project_tasks WHERE stage IN ('done', 'cancelled')
      )
  `;
});
