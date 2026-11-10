import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * When the task's current memory hold began, so its length survives a restart
 * and is added to the task's memory stall time when the hold clears.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE project_tasks ADD COLUMN memory_hold_since TEXT`;
  // A hold already in place counts from now: its real start was never recorded.
  yield* sql`
    UPDATE project_tasks
    SET memory_hold_since = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE memory_hold IS NOT NULL
  `;
});
