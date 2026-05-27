/**
 * Migration 043 — `projection_side_thread_participants`.
 *
 * One row per (side-thread, user) recording that `user_id` has posted at least
 * one message in `side_thread_id`. Populated by the side-thread projection
 * pipeline on `sidethread.message-posted`. Powers the "activity" half of the
 * Inbox: "every side-thread I participate in", so a new message by someone
 * else can be pushed to me even when I wasn't @mentioned.
 *
 * The (side_thread_id, user_id) primary key makes projector replay idempotent:
 * truncate-then-replay on bootstrap reinserts the same rows without conflict.
 * The `user_id` index serves the inbox query ("threads where I participate").
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_side_thread_participants (
      side_thread_id   TEXT NOT NULL,
      user_id          TEXT NOT NULL,
      first_posted_at  TEXT NOT NULL,
      PRIMARY KEY (side_thread_id, user_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pst_participants_user
    ON projection_side_thread_participants(user_id)
  `;
});
