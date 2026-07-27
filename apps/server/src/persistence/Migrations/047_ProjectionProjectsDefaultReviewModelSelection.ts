import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (columns.some((column) => column.name === "default_review_model_selection_json")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN default_review_model_selection_json TEXT
  `;
});
