/**
 * Migration 039 — `projection_inbox_dismissals`.
 *
 * Per-user soft-dismiss state for inbox rows. A row here means "user has
 * dismissed every mention of this side-thread up to `dismissed_at`". A new
 * mention with `occurred_at > dismissed_at` re-surfaces the side-thread in
 * the inbox without any explicit undismiss step.
 *
 * Populated by the side-thread projection pipeline on
 * `sidethread.inbox-dismissed` events; truncate-then-replay safe via PK.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_inbox_dismissals (
      user_id        TEXT NOT NULL,
      side_thread_id TEXT NOT NULL,
      dismissed_at   TEXT NOT NULL,
      PRIMARY KEY (user_id, side_thread_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_inbox_dismissals_user
    ON projection_inbox_dismissals(user_id)
  `;
});
