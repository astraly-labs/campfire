import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_ProjectionCollaborationIdentity", (it) => {
  it.effect("adds nullable identity columns without rewriting historical projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 34 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project-before-google', 'Existing project', '/tmp/existing', '[]',
          '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES (
          'thread-before-google', 'project-before-google', 'Existing thread',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'message-before-google', 'thread-before-google', 'user', 'hello', 0,
          '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 35 });

      const projects = yield* sql<{ readonly createdBy: string | null }>`
        SELECT created_by_json AS "createdBy" FROM projection_projects
      `;
      const threads = yield* sql<{ readonly createdBy: string | null }>`
        SELECT created_by_json AS "createdBy" FROM projection_threads
      `;
      const messages = yield* sql<{ readonly author: string | null }>`
        SELECT author_json AS "author" FROM projection_thread_messages
      `;
      assert.deepEqual(projects, [{ createdBy: null }]);
      assert.deepEqual(threads, [{ createdBy: null }]);
      assert.deepEqual(messages, [{ author: null }]);
    }),
  );
});
