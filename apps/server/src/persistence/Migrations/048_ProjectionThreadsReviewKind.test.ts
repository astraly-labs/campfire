import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048_ProjectionThreadsReviewKind", (it) => {
  it.effect("defaults existing threads and preserves review metadata", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES (
          'thread-before-review-kind', 'project-1', 'Existing thread',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 48 });
      const migratedRows = yield* sql<{
        readonly kind: string;
        readonly reviewPullRequestNumber: number | null;
      }>`
        SELECT kind, review_pull_request_number AS "reviewPullRequestNumber"
        FROM projection_threads
        WHERE thread_id = 'thread-before-review-kind'
      `;
      assert.deepEqual(migratedRows, [{ kind: "default", reviewPullRequestNumber: null }]);

      yield* sql`
        UPDATE projection_threads
        SET kind = 'review', review_pull_request_number = 42
        WHERE thread_id = 'thread-before-review-kind'
      `;

      const rows = yield* sql<{
        readonly kind: string;
        readonly reviewPullRequestNumber: number | null;
      }>`
        SELECT kind, review_pull_request_number AS "reviewPullRequestNumber"
        FROM projection_threads
        WHERE thread_id = 'thread-before-review-kind'
      `;
      assert.deepEqual(rows, [{ kind: "review", reviewPullRequestNumber: 42 }]);
    }),
  );
});
