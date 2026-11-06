import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Who answered an attention item: the user's click ("user") or a checked PM relay ("pm"). */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE project_attention_items ADD COLUMN answered_by TEXT`;
});
