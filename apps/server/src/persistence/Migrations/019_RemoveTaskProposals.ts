import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Task proposal cards are gone: tasks start from task_create. A proposal the user
 * never answered becomes a Todo task; one they removed or answered with feedback is
 * cancelled. Proposal cards are deleted.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE project_tasks
    SET stage = 'inbox'
    WHERE stage = 'proposed'
      AND EXISTS (
        SELECT 1 FROM project_attention_items AS item
        WHERE item.task_id = project_tasks.task_id
          AND item.kind = 'proposal'
          AND item.answered_at IS NULL
          AND item.superseded_at IS NULL
      )
  `;
  // Their logs gain the "created" entry that adding a proposal used to write.
  yield* sql`
    INSERT INTO project_task_events (
      event_id, project_id, task_id, kind, body, actor_thread_id, created_at
    )
    SELECT 'task-event:migrated-' || task_id, project_id, task_id, 'created', title, NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM project_tasks
    WHERE stage = 'inbox'
      AND task_id IN (
        SELECT item.task_id FROM project_attention_items AS item
        WHERE item.kind = 'proposal' AND item.answered_at IS NULL AND item.superseded_at IS NULL
      )
  `;
  yield* sql`UPDATE project_tasks SET stage = 'cancelled' WHERE stage = 'proposed'`;
  yield* sql`DELETE FROM project_attention_items WHERE kind = 'proposal'`;
});
