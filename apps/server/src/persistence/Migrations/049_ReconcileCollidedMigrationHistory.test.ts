import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("049_ReconcileCollidedMigrationHistory", (it) => {
  it.effect("repairs databases where upstream migration IDs were already recorded", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 48 });
      yield* sql`ALTER TABLE projection_projects DROP COLUMN default_thread_env_mode`;
      yield* sql`ALTER TABLE projection_threads DROP COLUMN unsettled_at`;
      yield* runMigrations({ toMigrationInclusive: 49 });

      const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isTrue(projectColumns.some((column) => column.name === "default_thread_env_mode"));
      assert.isTrue(threadColumns.some((column) => column.name === "unsettled_at"));
    }),
  );
});
