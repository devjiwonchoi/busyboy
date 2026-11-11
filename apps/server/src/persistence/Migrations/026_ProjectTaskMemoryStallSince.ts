import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * When the task's memory hold started holding back work (a running turn stopped,
 * a message held, or a start refused while memory was short), so the stall
 * survives a restart and is added to the task's memory stall time when it ends.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE project_tasks ADD COLUMN memory_stall_since TEXT`;
});
