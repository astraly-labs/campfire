import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type UserMemoryRepositoryError,
} from "./Errors.ts";

/** One markdown note per signed-in user subject. */
export class UserMemoryRepository extends Context.Service<
  UserMemoryRepository,
  {
    readonly get: (
      subject: string,
    ) => Effect.Effect<Option.Option<string>, UserMemoryRepositoryError>;
    /** Replaces the note. Blank content deletes it. */
    readonly set: (input: {
      readonly subject: string;
      readonly content: string;
    }) => Effect.Effect<void, UserMemoryRepositoryError>;
  }
>()("t3/persistence/UserMemory/UserMemoryRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findNote = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ content: Schema.String }),
    execute: (subject) => sql`SELECT content FROM user_memory WHERE subject = ${subject}`,
  });

  const writeNote = (subject: string, content: string) =>
    content.length === 0
      ? sql`DELETE FROM user_memory WHERE subject = ${subject}`
      : DateTime.now.pipe(
          Effect.flatMap(
            (now) => sql`
              INSERT INTO user_memory (subject, content, updated_at)
              VALUES (${subject}, ${content}, ${DateTime.formatIso(now)})
              ON CONFLICT (subject) DO UPDATE SET
                content = excluded.content,
                updated_at = excluded.updated_at
            `,
          ),
        );

  return UserMemoryRepository.of({
    get: (subject) =>
      findNote(subject).pipe(
        Effect.map(Option.map((row) => row.content)),
        Effect.mapError((cause) =>
          Schema.isSchemaError(cause)
            ? PersistenceDecodeError.fromSchemaError("UserMemoryRepository.get", cause)
            : new PersistenceSqlError({ operation: "UserMemoryRepository.get", cause }),
        ),
      ),
    set: ({ subject, content }) =>
      writeNote(subject, content.trim()).pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) => new PersistenceSqlError({ operation: "UserMemoryRepository.set", cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(UserMemoryRepository, make);
