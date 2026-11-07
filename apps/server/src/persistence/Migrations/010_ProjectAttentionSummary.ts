import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The short summary a plan approval card shows. Null for other kinds and older cards. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE project_attention_items ADD COLUMN summary TEXT`;
});
