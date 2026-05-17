import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS side_thread_events (
      sequence            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id            TEXT NOT NULL UNIQUE,
      side_thread_id      TEXT NOT NULL,
      stream_version      INTEGER NOT NULL,
      event_type          TEXT NOT NULL,
      occurred_at         TEXT NOT NULL,
      command_id          TEXT,
      causation_event_id  TEXT,
      correlation_id      TEXT,
      actor_user_id       TEXT NOT NULL,
      payload_json        TEXT NOT NULL,
      metadata_json       TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_side_thread_events_stream_version
    ON side_thread_events(side_thread_id, stream_version)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_side_thread_events_stream_sequence
    ON side_thread_events(side_thread_id, sequence)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_side_thread_events_command_id
    ON side_thread_events(command_id)
  `;
});
