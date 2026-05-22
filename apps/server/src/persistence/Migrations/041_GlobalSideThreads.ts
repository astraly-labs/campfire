/**
 * Migration 041 — workspace-wide global side threads.
 *
 * The `Global chat` feature reuses the SideThread aggregate but with no
 * parent agent thread. To express that in the read-model we must allow
 * `projection_side_threads.parent_thread_id` to be NULL.
 *
 * SQLite has no `ALTER COLUMN`, so we rebuild the table the canonical way:
 *   1. Create a new table with the relaxed NOT NULL constraint.
 *   2. Copy every row across.
 *   3. Drop the old table and rename the new one.
 *   4. Recreate the (parent_thread_id) index, but only for non-NULL parents
 *      so the global chat row doesn't bloat it.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_projection_side_threads_parent_thread_id`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_side_threads_new (
      side_thread_id      TEXT PRIMARY KEY,
      parent_thread_id    TEXT,
      created_by_user_id  TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      archived_at         TEXT,
      stream_version      INTEGER NOT NULL DEFAULT 0,
      snapshot_json       TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_side_threads_new (
      side_thread_id,
      parent_thread_id,
      created_by_user_id,
      created_at,
      updated_at,
      archived_at,
      stream_version,
      snapshot_json
    )
    SELECT
      side_thread_id,
      parent_thread_id,
      created_by_user_id,
      created_at,
      updated_at,
      archived_at,
      stream_version,
      snapshot_json
    FROM projection_side_threads
  `;

  yield* sql`DROP TABLE projection_side_threads`;
  yield* sql`ALTER TABLE projection_side_threads_new RENAME TO projection_side_threads`;

  // Partial index — the global chat has parent_thread_id IS NULL and we
  // never query by parent for it, so excluding NULLs keeps the index lean.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_side_threads_parent_thread_id
    ON projection_side_threads(parent_thread_id)
    WHERE parent_thread_id IS NOT NULL
  `;
});
