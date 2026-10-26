import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Thread settlement was removed. Its events carried the whole thread, like
 * `thread.metadata-updated`, and the event store decodes rows by type, so
 * stored ones become metadata updates. Rewriting in place keeps sequences and
 * stream versions contiguous.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE orchestration_events
    SET event_type = 'thread.metadata-updated'
    WHERE event_type IN ('thread.settled', 'thread.unsettled', 'thread.auto-settle-set')
  `;
});
