import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A thread a scheduled task launched opens with the task's message, while a
  // task bound to an existing thread only posts after someone else's opener.
  // The first user message is served by the partial
  // orchestration_v2_projection_turn_items_user_message_idx index (migration 060).
  yield* sql`
    WITH launched AS (
      SELECT
        threads.thread_id,
        (
          SELECT json_extract(items.payload_json, '$.scheduledTaskId')
          FROM orchestration_v2_projection_turn_items AS items
          WHERE items.thread_id = threads.thread_id
            AND items.type = 'user_message'
          ORDER BY items.ordinal, items.turn_item_id
          LIMIT 1
        ) AS scheduled_task_id
      FROM orchestration_v2_projection_threads AS threads
      WHERE json_type(threads.payload_json, '$.scheduledTaskId') IS NULL
    )
    UPDATE orchestration_v2_projection_threads
    SET payload_json = json_set(payload_json, '$.scheduledTaskId', launched.scheduled_task_id)
    FROM launched
    WHERE orchestration_v2_projection_threads.thread_id = launched.thread_id
      AND launched.scheduled_task_id IS NOT NULL
  `;
});
