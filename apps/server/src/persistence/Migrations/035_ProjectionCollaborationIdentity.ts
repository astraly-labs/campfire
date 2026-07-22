import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!projectColumns.some((entry) => entry.name === "created_by_json")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN created_by_json TEXT`;
  }

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((entry) => entry.name === "created_by_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN created_by_json TEXT`;
  }

  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!messageColumns.some((entry) => entry.name === "author_json")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN author_json TEXT`;
  }
});
