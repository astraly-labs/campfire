import { type CollaborationUser, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as AuthSessions from "../persistence/AuthSessions.ts";
import type { UserMemoryRepositoryError } from "../persistence/Errors.ts";
import * as UserMemory from "../persistence/UserMemory.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { withTurnAuthorContext } from "./turnAuthorContext.ts";

export const USER_MEMORY_MAX_CHARS = 4_000;

export class TurnAuthorUnknownError extends Schema.TaggedError<TurnAuthorUnknownError>()(
  "TurnAuthorUnknownError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "The sender of the current message is not a signed-in user.";
  }
}

export class TurnAuthorMemoryError extends Schema.TaggedError<TurnAuthorMemoryError>()(
  "TurnAuthorMemoryError",
  {
    threadId: ThreadId,
    operation: Schema.Literals(["read", "replace"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The user memory could not be read or saved.";
  }
}

/** A person's memory as the agent sees it: their name, never their subject. */
export interface TurnAuthorMemory {
  readonly author: { readonly displayName: string };
  readonly memory: string | null;
}

/**
 * Who sent a thread's current turn, what the provider is told about them, and
 * their memory. Callers never choose whose memory they touch: the thread's
 * current message decides.
 */
export class TurnAuthorService extends Context.Service<
  TurnAuthorService,
  {
    /** `text` as the provider receives it from `author`; see `withTurnAuthorContext`. */
    readonly providerText: (input: {
      readonly author: CollaborationUser | null | undefined;
      readonly text: string;
    }) => Effect.Effect<string>;
    readonly readMemory: (
      threadId: ThreadId,
    ) => Effect.Effect<TurnAuthorMemory, TurnAuthorUnknownError | TurnAuthorMemoryError>;
    /** Replaces the memory. Blank content deletes it. */
    readonly replaceMemory: (input: {
      readonly threadId: ThreadId;
      readonly content: string;
    }) => Effect.Effect<TurnAuthorMemory, TurnAuthorUnknownError | TurnAuthorMemoryError>;
  }
>()("t3/orchestration-v2/TurnAuthorService") {}

const make = Effect.gen(function* () {
  const authSessions = yield* AuthSessions.AuthSessionRepository;
  const memories = yield* UserMemory.UserMemoryRepository;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  // A failed lookup still names the sender; the turn only loses that detail.
  const orUndefined = <E>(lookup: Effect.Effect<Option.Option<string>, E>, detail: string) =>
    lookup.pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catch((cause) =>
        Effect.logWarning(`[🧠 User memory] Sending the turn without the author's ${detail}.`, {
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    );

  const providerText: TurnAuthorService["Service"]["providerText"] = ({ author, text }) =>
    author == null
      ? Effect.succeed(text)
      : Effect.gen(function* () {
          const email = yield* orUndefined(
            authSessions.getLatestEmailBySubject(author.subject),
            "email",
          );
          const memory = yield* orUndefined(memories.get(author.subject), "memory");
          return withTurnAuthorContext({ author, email, memory, text });
        });

  // The live run's latest message, a steer included, else the thread's latest
  // one. A message queued behind the live run is not the current turn.
  const currentAuthor = Effect.fn("TurnAuthorService.currentAuthor")(function* (
    threadId: ThreadId,
  ) {
    const { run } = yield* projections.getRunningTurnContext(threadId);
    const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
      messageRoles: ["user"],
      ...(run === undefined ? {} : { messageRunIds: [run.id] }),
    });
    return messages.at(-1)?.author ?? null;
  });

  const withCurrentAuthor = (
    threadId: ThreadId,
    operation: TurnAuthorMemoryError["operation"],
    use: (subject: string) => Effect.Effect<Option.Option<string>, UserMemoryRepositoryError>,
  ) =>
    Effect.gen(function* () {
      const author = yield* currentAuthor(threadId).pipe(
        Effect.mapError((cause) => new TurnAuthorMemoryError({ threadId, operation, cause })),
      );
      if (author === null) return yield* new TurnAuthorUnknownError({ threadId });
      const memory = yield* use(author.subject).pipe(
        Effect.mapError((cause) => new TurnAuthorMemoryError({ threadId, operation, cause })),
      );
      return {
        author: { displayName: author.displayName },
        memory: Option.getOrNull(memory),
      } satisfies TurnAuthorMemory;
    });

  return TurnAuthorService.of({
    providerText,
    readMemory: (threadId) => withCurrentAuthor(threadId, "read", memories.get),
    replaceMemory: ({ threadId, content }) =>
      withCurrentAuthor(threadId, "replace", (subject) =>
        memories.set({ subject, content }).pipe(Effect.andThen(memories.get(subject))),
      ),
  });
});

export const layer = Layer.effect(TurnAuthorService, make).pipe(
  Layer.provide(Layer.merge(AuthSessions.layer, UserMemory.layer)),
);
