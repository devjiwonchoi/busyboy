import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The spec version a plan approval card asks the user to review. Null for other kinds. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE project_attention_items ADD COLUMN spec_version INTEGER`;
});
