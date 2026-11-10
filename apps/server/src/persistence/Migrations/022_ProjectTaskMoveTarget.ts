import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Where a task's lead is being moved; null when it is not moving. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE project_tasks ADD COLUMN move_target TEXT`;
});
