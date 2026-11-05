import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A question closed without an answer because a newer one replaced it. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE project_attention_items ADD COLUMN superseded_at TEXT`;
});
