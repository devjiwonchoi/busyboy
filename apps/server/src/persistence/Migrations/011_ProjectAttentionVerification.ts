import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The Verification section of a plan approval card. Null for other kinds and older cards. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE project_attention_items ADD COLUMN verification TEXT`;
});
