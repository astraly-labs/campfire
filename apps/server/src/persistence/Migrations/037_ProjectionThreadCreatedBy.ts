/**
 * Migration 037 — denormalize thread creator onto `projection_threads`.
 *
 * Mirrors the pattern from 036 (per-message author): capture the `UserRef`
 * of whoever issued the `thread.create` command so the thread header can
 * render an "assigned to" avatar without joining against the users table.
 * Both columns are nullable so historical threads (written before this
 * feature) decode cleanly with `createdBy = null`.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN created_by_user_id TEXT
  `;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN created_by_display_name TEXT
  `;
});
