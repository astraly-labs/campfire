/**
 * UserDirectoryLive — SQLite-backed implementation that surfaces the
 * effective `UserRef` (override-aware) for every user known to the backend.
 *
 * @module UserDirectoryLive
 */
import { type UserId, type UserRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { UserDirectoryService, type UserDirectoryShape } from "../Services/UserDirectory.ts";

interface UserRow {
  readonly user_id: string;
  readonly display_name: string;
  readonly display_name_override: string | null;
}

const makeUserDirectory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listUsers: UserDirectoryShape["listUsers"] = () =>
    Effect.gen(function* () {
      const rows = yield* sql<UserRow>`
        SELECT user_id, display_name, display_name_override
        FROM users
        ORDER BY COALESCE(display_name_override, display_name) ASC
      `.pipe(Effect.mapError(toPersistenceSqlError("UserDirectory.listUsers")));

      return rows.map<UserRef>((row) => ({
        id: row.user_id as UserId,
        displayName: row.display_name_override ?? row.display_name,
      }));
    });

  return { listUsers } satisfies UserDirectoryShape;
});

export const UserDirectoryLive = Layer.effect(UserDirectoryService, makeUserDirectory);
