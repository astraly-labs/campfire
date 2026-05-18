/**
 * Migration 035 — `projection_side_thread_message_mentions`.
 *
 * Per-mention pivot table populated by the side-thread projection pipeline.
 * Powers the Slack-style Inbox by letting us query "every side-thread where
 * `user_id` was tagged" with a single index scan, ordered by recency.
 *
 * The (message_id, user_id) primary key makes projector replay idempotent:
 * truncate-then-replay on bootstrap reinserts the same rows without conflict.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_side_thread_message_mentions (
      message_id          TEXT NOT NULL,
      user_id             TEXT NOT NULL,
      side_thread_id      TEXT NOT NULL,
      parent_thread_id    TEXT NOT NULL,
      anchor_message_id   TEXT,
      author_user_id      TEXT NOT NULL,
      author_display_name TEXT NOT NULL,
      text_preview        TEXT NOT NULL,
      occurred_at         TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pst_mentions_user_occurred
    ON projection_side_thread_message_mentions(user_id, occurred_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pst_mentions_side_thread
    ON projection_side_thread_message_mentions(side_thread_id)
  `;
});
