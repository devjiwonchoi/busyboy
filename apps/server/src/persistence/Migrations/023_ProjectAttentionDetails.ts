import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Older requests have no folded details.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE project_attention_items ADD COLUMN details_json TEXT`;
});
