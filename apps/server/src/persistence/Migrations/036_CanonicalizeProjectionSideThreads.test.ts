import { SideThread } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const SideThreadsJson = Schema.fromJsonString(Schema.Array(SideThread));
const decodeSideThreads = Schema.decodeUnknownEffect(SideThreadsJson);
const encodeSideThreads = Schema.encodeUnknownEffect(SideThreadsJson);

layer("036_CanonicalizeProjectionSideThreads", (it) => {
  it.effect("merges legacy discussions into one canonical thread discussion", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project-legacy-side-threads', 'Existing project', '/tmp/existing', '[]',
          '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
        )
      `;

      const sideThreadsJson = yield* encodeSideThreads([
        {
          id: "message:legacy-1",
          createdBy: { subject: "google:alice", displayName: "Alice" },
          createdAt: "2026-07-23T00:01:00.000Z",
          updatedAt: "2026-07-23T00:02:00.000Z",
          archivedAt: null,
          messages: [
            {
              id: "side-message-1",
              author: { subject: "google:alice", displayName: "Alice" },
              text: "first",
              createdAt: "2026-07-23T00:02:00.000Z",
            },
          ],
        },
        {
          id: "message:legacy-2",
          createdBy: { subject: "google:bob", displayName: "Bob" },
          createdAt: "2026-07-23T00:03:00.000Z",
          updatedAt: "2026-07-23T00:05:00.000Z",
          archivedAt: null,
          messages: [
            {
              id: "side-message-2",
              author: { subject: "google:bob", displayName: "Bob" },
              text: "second",
              createdAt: "2026-07-23T00:04:00.000Z",
            },
          ],
          readBy: [
            {
              user: { subject: "google:alice", displayName: "Alice" },
              lastReadAt: "2026-07-23T00:05:00.000Z",
            },
          ],
        },
      ]);
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, side_threads_json
        ) VALUES (
          'thread-legacy-side-threads', 'project-legacy-side-threads', 'Existing thread',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z',
          ${sideThreadsJson}
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const rows = yield* sql<{ readonly sideThreadsJson: string }>`
        SELECT side_threads_json AS "sideThreadsJson"
        FROM projection_threads
        WHERE thread_id = 'thread-legacy-side-threads'
      `;
      const sideThreads = yield* decodeSideThreads(rows[0]!.sideThreadsJson);
      assert.equal(sideThreads.length, 1);
      assert.equal(sideThreads[0]?.id, "thread:thread-legacy-side-threads");
      assert.deepEqual(
        sideThreads[0]?.messages.map((message) => message.id),
        ["side-message-1", "side-message-2"],
      );
      assert.deepEqual(
        sideThreads[0]?.readBy?.map((marker) => marker.lastReadAt),
        ["2026-07-23T00:05:00.000Z"],
      );
    }),
  );
});
