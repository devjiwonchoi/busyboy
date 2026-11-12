import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Structured decision scope. Null preserves the unknown state of older cards. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE project_attention_items ADD COLUMN context_json TEXT`;
});
