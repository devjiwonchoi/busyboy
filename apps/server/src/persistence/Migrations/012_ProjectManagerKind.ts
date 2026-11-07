import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A manager is a project's PM, or the Director of the whole workspace. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE project_managers ADD COLUMN kind TEXT NOT NULL DEFAULT 'pm'`;
});
