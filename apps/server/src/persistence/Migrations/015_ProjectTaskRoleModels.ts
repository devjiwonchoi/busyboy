import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A task keeps its own model per role and the model that last ran each role. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE project_tasks ADD COLUMN role_models_json TEXT NOT NULL DEFAULT '{}'`;
  yield* sql`ALTER TABLE project_tasks ADD COLUMN model_steps_json TEXT NOT NULL DEFAULT '{}'`;
});
