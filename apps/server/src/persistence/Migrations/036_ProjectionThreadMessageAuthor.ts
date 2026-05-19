/**
 * Migration 036 — denormalize message author onto `projection_thread_messages`.
 *
 * Mirrors what side-threads already do: capture the `UserRef` of whoever
 * authored a user prompt so the chat timeline can attribute each bubble.
 * Both columns are nullable so historical messages (written before this
 * feature) decode cleanly with `author = null`.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN author_user_id TEXT
  `;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN author_display_name TEXT
  `;
});
