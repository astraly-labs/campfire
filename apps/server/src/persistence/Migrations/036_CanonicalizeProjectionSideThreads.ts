import { SideThread, ThreadId } from "@t3tools/contracts";
import { canonicalizeSideThreads } from "@t3tools/shared/sideThread";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeSideThreads = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(SideThread)),
);
const encodeSideThreads = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(SideThread)));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly threadId: string;
    readonly sideThreadsJson: string;
  }>`
    SELECT
      thread_id AS "threadId",
      side_threads_json AS "sideThreadsJson"
    FROM projection_threads
    WHERE side_threads_json <> '[]'
  `;

  for (const row of rows) {
    const sideThreads = yield* decodeSideThreads(row.sideThreadsJson);
    const canonical = canonicalizeSideThreads(ThreadId.make(row.threadId), sideThreads);
    const canonicalJson = yield* encodeSideThreads(canonical);
    if (canonicalJson === row.sideThreadsJson) continue;
    yield* sql`
      UPDATE projection_threads
      SET side_threads_json = ${canonicalJson}
      WHERE thread_id = ${row.threadId}
    `;
  }
});
