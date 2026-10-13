import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS orchestration_v2_projection_side_threads (
    thread_id TEXT NOT NULL PRIMARY KEY,
    payload_json TEXT NOT NULL,
    summary_json TEXT
  )`;
});
