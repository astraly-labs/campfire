import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_ProjectionThreadSideThreads", (it) => {
  it.effect("adds a durable empty SideThread projection to existing thread rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_at,
          updated_at
        )
        VALUES (
          'thread-before-side-threads',
          'project-1',
          'Existing thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          '2026-07-22T00:00:00.000Z',
          '2026-07-22T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 34 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_threads)
      `;
      const rows = yield* sql<{ readonly sideThreadsJson: string }>`
        SELECT side_threads_json AS "sideThreadsJson"
        FROM projection_threads
        WHERE thread_id = 'thread-before-side-threads'
      `;

      const sideThreadsColumn = columns.find((column) => column.name === "side_threads_json");
      assert.equal(sideThreadsColumn?.notnull, 1);
      assert.deepEqual(rows, [{ sideThreadsJson: "[]" }]);
    }),
  );
});
