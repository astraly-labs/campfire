import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";

type MigrationRow = { readonly id: number; readonly name: string };

// The fork reserves 1–50 for Campfire, so upstream's V2 preview ids 53/54 are 59/60 here
// and V2 lands at 61. Reconcile them without replaying schema or losing import progress.
function v2PreviewId(history: ReadonlyArray<MigrationRow>): number | "invalid" | undefined {
  const later = history.filter((row) => row.id >= 59);
  const legacy = later.find(
    (row) => row.name === "OrchestrationV2" && (row.id === 59 || row.id === 60),
  );
  if (!legacy) return undefined;
  const valid = later.every(
    (row) =>
      row === legacy ||
      (legacy.id === 60 &&
        ((row.id === 59 && row.name === "PullRequestFilesViewed") ||
          (row.id === 61 && row.name === "RemoveRedundantProjectionIndexes"))),
  );
  return valid ? legacy.id : "invalid";
}

/** The history as startup's preview reconciliation leaves it, or null when startup rejects it. */
export function reconciledV2PreviewHistory(
  history: ReadonlyArray<MigrationRow>,
): ReadonlyArray<MigrationRow> | null {
  const previewId = v2PreviewId(history);
  if (previewId === undefined) return history;
  if (previewId === "invalid") return null;
  return [
    ...history.filter((row) => row.id < 59),
    { id: 59, name: "PullRequestFilesViewed" },
    { id: 60, name: "ProjectionThreadsAutoSettleDisabledAt" },
    { id: 61, name: "OrchestrationV2" },
    ...(history.some((row) => row.id === 61)
      ? [{ id: 62, name: "RemoveRedundantProjectionIndexes" }]
      : []),
  ];
}

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
      const previewId = v2PreviewId(
        history.map((row) => ({ id: row.migration_id, name: row.name })),
      );
      if (previewId === undefined) return [];
      if (previewId === "invalid") {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade V2 preview with unexpected later migrations.",
        });
      }
      const executed: Array<readonly [number, string]> = [];
      if (previewId === 59) {
        yield* PullRequestFilesViewed;
        executed.push([59, "PullRequestFilesViewed"]);
      }
      yield* AutoSettleDisabledAt;
      executed.push([60, "ProjectionThreadsAutoSettleDisabledAt"]);
      // Move the later entry first to avoid a primary-key collision.
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 62 WHERE migration_id = 61 AND name = 'RemoveRedundantProjectionIndexes'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 61 WHERE migration_id = ${previewId} AND name = 'OrchestrationV2'`;
      if (previewId === 59) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (59, 'PullRequestFilesViewed')`;
      }
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (60, 'ProjectionThreadsAutoSettleDisabledAt')`;
      return executed;
    }),
  );
});
