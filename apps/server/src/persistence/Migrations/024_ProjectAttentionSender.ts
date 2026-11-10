import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Existing requests keep an unknown sender until a new card is raised.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE project_attention_items ADD COLUMN sender_role TEXT`;
  yield* sql`ALTER TABLE project_attention_items ADD COLUMN sender_name TEXT`;
});
