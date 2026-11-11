import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Why a task is held for memory ("waiting" or "paused"); null when it is not. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE project_tasks ADD COLUMN memory_hold TEXT`;
});
