import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The latest plan gate check of a task: its round, status, verdicts and checker. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE project_tasks ADD COLUMN plan_check_json TEXT`;
});
