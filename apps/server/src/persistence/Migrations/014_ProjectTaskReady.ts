import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A task keeps the Ready gate's pass, set by task_ready and cleared by new failures or comments. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE project_tasks ADD COLUMN ready_json TEXT`;
});
