import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

export type UserMemoryRepositoryError = PersistenceSqlError | PersistenceDecodeError;

/**
 * One markdown note per authenticated user subject. The provider reactor
 * injects it into the turns that user sends, and the `memory_*` MCP tools let
 * the agent read and replace it for the current turn's author only.
 */
export class UserMemoryRepository extends Context.Service<
  UserMemoryRepository,
  {
    readonly get: (
      subject: string,
    ) => Effect.Effect<Option.Option<string>, UserMemoryRepositoryError>;
    /** Replaces the memory. Empty content deletes it. */
    readonly set: (input: {
      readonly subject: string;
      readonly content: string;
    }) => Effect.Effect<void, UserMemoryRepositoryError>;
  }
>()("t3/persistence/UserMemory/UserMemoryRepository") {}

const toRepositoryError =
  (operation: string) =>
  (cause: unknown): UserMemoryRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : new PersistenceSqlError({ operation, cause });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ content: Schema.String }),
    execute: (subject) => sql`
      SELECT content FROM user_memory WHERE subject = ${subject}
    `,
  });

  const upsertRow = SqlSchema.void({
    Request: Schema.Struct({
      subject: Schema.String,
      content: Schema.String,
      updatedAt: Schema.DateTimeUtcFromString,
    }),
    execute: ({ subject, content, updatedAt }) => sql`
      INSERT INTO user_memory (subject, content, updated_at)
      VALUES (${subject}, ${content}, ${updatedAt})
      ON CONFLICT (subject) DO UPDATE SET
        content = excluded.content,
        updated_at = excluded.updated_at
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: Schema.String,
    execute: (subject) => sql`
      DELETE FROM user_memory WHERE subject = ${subject}
    `,
  });

  return UserMemoryRepository.of({
    get: (subject) =>
      getRow(subject).pipe(
        Effect.map(Option.map((row) => row.content)),
        Effect.mapError(toRepositoryError("UserMemoryRepository.get")),
      ),
    set: ({ subject, content }) =>
      (content.trim().length === 0
        ? deleteRow(subject)
        : DateTime.now.pipe(
            Effect.flatMap((updatedAt) =>
              upsertRow({ subject, content: content.trim(), updatedAt }),
            ),
          )
      ).pipe(Effect.mapError(toRepositoryError("UserMemoryRepository.set"))),
  });
});

export const layer = Layer.effect(UserMemoryRepository, make);
