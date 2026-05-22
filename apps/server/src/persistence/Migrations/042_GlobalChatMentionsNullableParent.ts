/**
 * Migration 042 — relax `projection_side_thread_message_mentions.parent_thread_id`
 * to nullable so @mentions inside the workspace-wide global chat can land in
 * the inbox alongside regular side-thread mentions.
 *
 * Same rebuild dance as migration 041 — SQLite has no `ALTER COLUMN`, so we
 * copy into a fresh table with the relaxed schema, drop the old one, rename,
 * and recreate the indexes.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_pst_mentions_user_occurred`;
  yield* sql`DROP INDEX IF EXISTS idx_pst_mentions_side_thread`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_side_thread_message_mentions_new (
      message_id          TEXT NOT NULL,
      user_id             TEXT NOT NULL,
      side_thread_id      TEXT NOT NULL,
      parent_thread_id    TEXT,
      quoted_message_id   TEXT,
      author_user_id      TEXT NOT NULL,
      author_display_name TEXT NOT NULL,
      text_preview        TEXT NOT NULL,
      occurred_at         TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id)
    )
  `;

  yield* sql`
    INSERT INTO projection_side_thread_message_mentions_new (
      message_id,
      user_id,
      side_thread_id,
      parent_thread_id,
      quoted_message_id,
      author_user_id,
      author_display_name,
      text_preview,
      occurred_at
    )
    SELECT
      message_id,
      user_id,
      side_thread_id,
      parent_thread_id,
      quoted_message_id,
      author_user_id,
      author_display_name,
      text_preview,
      occurred_at
    FROM projection_side_thread_message_mentions
  `;

  yield* sql`DROP TABLE projection_side_thread_message_mentions`;
  yield* sql`
    ALTER TABLE projection_side_thread_message_mentions_new
    RENAME TO projection_side_thread_message_mentions
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
