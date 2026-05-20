/**
 * Migration 040 — consolidate side threads to one per parent thread.
 *
 * v0 modeled side threads as one-per-message (anchored on a specific
 * assistant message). This migration collapses every side thread sharing
 * a `parent_thread_id` into a single canonical aggregate keyed by
 * `st-{parent_thread_id}`, and folds historical "anchor" semantics into a
 * per-message `quoted_message_id` so the inbox can still scroll to the
 * referenced agent message.
 *
 * Migration is non-destructive on `side_thread_events`: the event store
 * stays append-only and the projector tolerates the old payload shape
 * (rebroadcasting via bootstrap remaps to the canonical id).
 *
 * Steps:
 *   1. Add `quoted_message_id` to `projection_side_thread_messages` and
 *      `projection_side_thread_message_mentions` (backfill from the
 *      side-thread's anchor).
 *   2. Reassign every message / mention / dismissal to the canonical
 *      `st-{parent_thread_id}` side-thread id.
 *   3. Collapse `projection_side_threads` rows to one per parent (oldest
 *      `created_at` wins for the snapshot metadata).
 *   4. Drop the now-unused anchor columns and their index.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // 1. Add quoted_message_id columns. SQLite tolerates `ADD COLUMN IF NOT
  //    EXISTS` only via PRAGMA, so we guard via PRAGMA table_info — keep it
  //    idempotent in case the migration is replayed.
  yield* sql`ALTER TABLE projection_side_thread_messages ADD COLUMN quoted_message_id TEXT`.pipe(
    Effect.ignore,
  );
  yield* sql`ALTER TABLE projection_side_thread_message_mentions ADD COLUMN quoted_message_id TEXT`.pipe(
    Effect.ignore,
  );

  // Backfill from the historical anchor on the side-thread itself. Any
  // historical message in a thread inherited the anchor's "this discusses
  // message X" semantic, so the quote points at the same agent message.
  yield* sql`
    UPDATE projection_side_thread_messages
    SET quoted_message_id = (
      SELECT anchor_message_id
      FROM projection_side_threads
      WHERE projection_side_threads.side_thread_id = projection_side_thread_messages.side_thread_id
    )
    WHERE quoted_message_id IS NULL
  `;
  yield* sql`
    UPDATE projection_side_thread_message_mentions
    SET quoted_message_id = anchor_message_id
    WHERE quoted_message_id IS NULL
  `;

  // 2. Compute the canonical id for each existing thread: `st-{parent}`.
  //    Update every child table to point at the canonical id before we
  //    collapse the parent rows. Using a temporary mapping table keeps the
  //    UPDATE statements simple and consistent across the children.
  yield* sql`
    CREATE TEMPORARY TABLE _sidethread_canonical AS
    SELECT
      side_thread_id AS old_id,
      'st-' || parent_thread_id AS new_id,
      parent_thread_id
    FROM projection_side_threads
  `;

  yield* sql`
    UPDATE projection_side_thread_messages
    SET side_thread_id = (
      SELECT new_id FROM _sidethread_canonical WHERE old_id = projection_side_thread_messages.side_thread_id
    )
    WHERE side_thread_id IN (SELECT old_id FROM _sidethread_canonical)
  `;
  yield* sql`
    UPDATE projection_side_thread_message_mentions
    SET side_thread_id = (
      SELECT new_id FROM _sidethread_canonical WHERE old_id = projection_side_thread_message_mentions.side_thread_id
    )
    WHERE side_thread_id IN (SELECT old_id FROM _sidethread_canonical)
  `;
  yield* sql`
    UPDATE projection_inbox_dismissals
    SET side_thread_id = (
      SELECT new_id FROM _sidethread_canonical WHERE old_id = projection_inbox_dismissals.side_thread_id
    )
    WHERE side_thread_id IN (SELECT old_id FROM _sidethread_canonical)
  `;

  // Dismissals may now collide: the same user could have dismissed two
  // distinct anchored threads that both fold into the canonical id. Keep
  // the most recent `dismissed_at` so the user doesn't lose visibility on
  // any post-dismiss mention.
  yield* sql`
    DELETE FROM projection_inbox_dismissals
    WHERE rowid NOT IN (
      SELECT MAX(rowid) FROM projection_inbox_dismissals
      GROUP BY user_id, side_thread_id
    )
  `;

  // 3. Collapse the side-thread snapshot rows. Pick the oldest row per
  //    parent to seed (createdBy, createdAt); newer rows are deleted.
  //    We rewrite each kept row's id+snapshot_json so SELECT-ing it yields
  //    a coherent canonical aggregate.
  yield* sql`
    DELETE FROM projection_side_threads
    WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM projection_side_threads GROUP BY parent_thread_id
    )
  `;
  yield* sql`
    UPDATE projection_side_threads
    SET side_thread_id = 'st-' || parent_thread_id
  `;
  // Bump the snapshot_json so it matches the new id; the next bootstrap
  // replay (running on server startup right after this migration) will
  // overwrite this anyway, but keeping the JSON coherent avoids decoders
  // tripping in the meantime.
  yield* sql`
    UPDATE projection_side_threads
    SET snapshot_json = json_set(snapshot_json, '$.id', side_thread_id)
    WHERE json_valid(snapshot_json)
  `;
  yield* sql`
    UPDATE projection_side_threads
    SET snapshot_json = json_remove(snapshot_json, '$.anchor')
    WHERE json_valid(snapshot_json)
  `;

  // 4. Drop anchor columns + the now-orphan index. SQLite has supported
  //    `DROP COLUMN` since 3.35 (Mar 2021), well within our floor.
  yield* sql`DROP INDEX IF EXISTS idx_projection_side_threads_anchor_message_id`;
  yield* sql`ALTER TABLE projection_side_threads DROP COLUMN anchor_kind`.pipe(Effect.ignore);
  yield* sql`ALTER TABLE projection_side_threads DROP COLUMN anchor_message_id`.pipe(
    Effect.ignore,
  );
  yield* sql`ALTER TABLE projection_side_thread_message_mentions DROP COLUMN anchor_message_id`.pipe(
    Effect.ignore,
  );

  yield* sql`DROP TABLE IF EXISTS _sidethread_canonical`;
});
