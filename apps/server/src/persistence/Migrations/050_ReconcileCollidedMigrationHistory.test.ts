import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_ReconcileCollidedMigrationHistory", (it) => {
  it.effect("repairs databases where upstream migration IDs were already recorded", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`ALTER TABLE projection_threads DROP COLUMN snoozed_until`;
      yield* sql`ALTER TABLE projection_threads DROP COLUMN snoozed_at`;
      yield* sql`ALTER TABLE projection_threads DROP COLUMN title_regeneration_request_id`;
      yield* sql`ALTER TABLE projection_threads DROP COLUMN title_regeneration_started_at`;
      yield* sql`ALTER TABLE projection_threads DROP COLUMN pinned_at`;
      yield* sql`ALTER TABLE projection_threads DROP COLUMN pin_order_key`;
      yield* sql`ALTER TABLE projection_projects DROP COLUMN default_thread_env_mode`;
      yield* sql`ALTER TABLE projection_threads DROP COLUMN unsettled_at`;
      yield* sql`DROP INDEX idx_projection_turns_thread_keyset`;
      yield* runMigrations({ toMigrationInclusive: 50 });

      const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_turns)
      `;
      assert.isTrue(projectColumns.some((column) => column.name === "default_thread_env_mode"));
      for (const name of [
        "snoozed_until",
        "snoozed_at",
        "title_regeneration_request_id",
        "title_regeneration_started_at",
        "pinned_at",
        "pin_order_key",
        "unsettled_at",
      ]) {
        assert.isTrue(threadColumns.some((column) => column.name === name));
      }
      assert.isTrue(indexes.some((index) => index.name === "idx_projection_turns_thread_keyset"));
    }),
  );
});
