import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";

// The fork reserves 1–50 for Campfire. Reconcile V2 preview positions relative
// to its own ledger without replaying schema or losing import progress.
export const reconcileV2PreviewMigration = Effect.fn("reconcileV2PreviewMigration")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 59
      `;
      const legacy = history.find(
        (row) =>
          row.name === "OrchestrationV2" && (row.migration_id === 59 || row.migration_id === 60),
      );
      if (!legacy) return [];
      const valid = history.every(
        (row) =>
          row === legacy ||
          (legacy.migration_id === 60 &&
            ((row.migration_id === 59 && row.name === "PullRequestFilesViewed") ||
              (row.migration_id === 61 && row.name === "RemoveRedundantProjectionIndexes"))),
      );
      if (!valid) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade V2 preview with unexpected later migrations.",
        });
      }
      const executed: Array<readonly [number, string]> = [];
      if (legacy.migration_id === 59) {
        yield* PullRequestFilesViewed;
        executed.push([59, "PullRequestFilesViewed"]);
      }
      yield* AutoSettleDisabledAt;
      executed.push([60, "ProjectionThreadsAutoSettleDisabledAt"]);
      // Move the later entry first to avoid a primary-key collision.
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 62 WHERE migration_id = 61 AND name = 'RemoveRedundantProjectionIndexes'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 61 WHERE migration_id = ${legacy.migration_id} AND name = 'OrchestrationV2'`;
      if (legacy.migration_id === 59) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (59, 'PullRequestFilesViewed')`;
      }
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (60, 'ProjectionThreadsAutoSettleDisabledAt')`;
      return executed;
    }),
  );
});
