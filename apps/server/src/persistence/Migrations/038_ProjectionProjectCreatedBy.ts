/**
 * Migration 038 — denormalize project creator onto `projection_projects`.
 *
 * Mirrors migration 037 for threads: capture the `UserRef` of whoever
 * issued the `project.create` command so the sidebar can partition
 * "My projects" (mine + mentions) from the rest without joining against
 * the users table. Both columns are nullable so historical projects
 * (written before this feature) decode cleanly with `createdBy = null` and
 * the sidebar falls back to the primary-environment heuristic.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN created_by_user_id TEXT
  `;

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN created_by_display_name TEXT
  `;
});
