import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("071_ScheduledTaskThreadOrigin", (it) => {
  it.effect("marks only threads whose first message came from a scheduled task", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });

      const insertThread = (threadId: string) => sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        )
        VALUES (
          ${threadId}, 'project-1', ${threadId}, 'codex', 'full-access', 'default',
          '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
          ${JSON.stringify({ id: threadId, title: threadId })}
        )
      `;
      const insertUserMessage = (
        threadId: string,
        ordinal: number,
        scheduledTaskId: string | null,
      ) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
        )
        VALUES (
          ${`${threadId}:item-${ordinal}`}, ${threadId}, ${ordinal}, 'user_message', 'completed',
          '2026-10-01T00:00:00.000Z',
          ${JSON.stringify(scheduledTaskId === null ? { text: "hi" } : { text: "hi", scheduledTaskId })}
        )
      `;

      yield* insertThread("launched");
      yield* insertUserMessage("launched", 2, null);
      yield* insertUserMessage("launched", 1, "task-launch");
      yield* insertThread("bound");
      yield* insertUserMessage("bound", 2, "task-bound");
      yield* insertUserMessage("bound", 1, null);
      yield* insertThread("empty");

      yield* runMigrations({ toMigrationInclusive: 71 });

      const rows = yield* sql<{ readonly thread_id: string; readonly payload_json: string }>`
        SELECT thread_id, payload_json FROM orchestration_v2_projection_threads ORDER BY thread_id
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.thread_id, JSON.parse(row.payload_json)]),
        [
          ["bound", { id: "bound", title: "bound" }],
          ["empty", { id: "empty", title: "empty" }],
          ["launched", { id: "launched", title: "launched", scheduledTaskId: "task-launch" }],
        ],
      );
    }),
  );
});
