import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS users (
      user_id      TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS user_devices (
      device_id    TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      tailnet_name TEXT NOT NULL,
      paired_at    TEXT NOT NULL,
      last_seen_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_user_devices_user_id
    ON user_devices(user_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_user_devices_tailnet_name
    ON user_devices(tailnet_name)
  `;
});
