import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A snoozed card stays open; the user set it aside with a reason and brings it back by hand.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE project_attention_items ADD COLUMN snoozed_at TEXT`;
  yield* sql`ALTER TABLE project_attention_items ADD COLUMN snooze_reason TEXT`;
});
