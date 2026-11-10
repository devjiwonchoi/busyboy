import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Where a task's lead runs: on the user's Mac or in a cloud sandbox. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE project_tasks ADD COLUMN location TEXT NOT NULL DEFAULT 'local'`;
});
