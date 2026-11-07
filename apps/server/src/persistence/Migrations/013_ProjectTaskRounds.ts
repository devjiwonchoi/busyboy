import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A task counts its Iterate and Ship rounds and keeps the lead's latest self-review. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE project_tasks ADD COLUMN iterate_round INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE project_tasks ADD COLUMN ship_round INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE project_tasks ADD COLUMN review_json TEXT`;
});
