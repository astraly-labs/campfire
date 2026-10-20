import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("069_AuthSessionEmail", (it) => {
  it.effect("adds a nullable email to existing auth sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 68 });
      yield* sql`
        INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES (
          'session-before-email', 'google:alice', '[]', 'browser-session-cookie',
          '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 69 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(auth_sessions)
      `;
      assert.equal(columns.find((column) => column.name === "email")?.notnull, 0);
      assert.deepStrictEqual(yield* sql`SELECT session_id, email FROM auth_sessions`, [
        { session_id: "session-before-email", email: null },
      ]);
    }),
  );
});
