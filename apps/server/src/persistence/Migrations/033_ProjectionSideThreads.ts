import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_side_threads (
      side_thread_id      TEXT PRIMARY KEY,
      parent_thread_id    TEXT NOT NULL,
      anchor_kind         TEXT NOT NULL,
      anchor_message_id   TEXT,
      created_by_user_id  TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      archived_at         TEXT,
      stream_version      INTEGER NOT NULL DEFAULT 0,
      snapshot_json       TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_side_thread_messages (
      message_id           TEXT PRIMARY KEY,
      side_thread_id       TEXT NOT NULL,
      author_user_id       TEXT NOT NULL,
      author_display_name  TEXT NOT NULL,
      text                 TEXT NOT NULL,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_side_threads_parent_thread_id
    ON projection_side_threads(parent_thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_side_threads_anchor_message_id
    ON projection_side_threads(anchor_message_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_side_thread_messages_side_thread_created
    ON projection_side_thread_messages(side_thread_id, created_at)
  `;
});
