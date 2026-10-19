import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as UserMemory from "../../../persistence/UserMemory.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MemoryToolkit, UserMemoryToolError } from "./tools.ts";

export const MemoryToolkitHandlersLive = MemoryToolkit.toLayer(
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const userMemory = yield* UserMemory.UserMemoryRepository;

    const fail = (message: string) => new UserMemoryToolError({ message });

    // The author is always resolved server-side from the thread, never taken
    // from the agent: it is the author of the latest user message. Projections
    // only set `author` for Google-authenticated users.
    const resolveCurrentAuthor = (threadId: ThreadId) =>
      projectionSnapshotQuery.getThreadDetailById(threadId, { includeActivities: false }).pipe(
        Effect.mapError(() => fail("Could not read the current thread.")),
        Effect.flatMap((thread) => {
          const author = Option.getOrUndefined(thread)?.messages.findLast(
            (message) => message.role === "user",
          )?.author;
          return author
            ? Effect.succeed(author)
            : Effect.fail(fail("The sender of the current message is not a signed-in user."));
        }),
      );

    const run = (content?: string) =>
      Effect.gen(function* () {
        const { threadId } = yield* McpInvocationContext.McpInvocationContext;
        const author = yield* resolveCurrentAuthor(threadId);
        if (content !== undefined) {
          yield* userMemory
            .set({ subject: author.subject, content })
            .pipe(Effect.mapError(() => fail("Could not save the memory.")));
        }
        const memory = yield* userMemory
          .get(author.subject)
          .pipe(Effect.mapError(() => fail("Could not read the memory.")));
        return {
          author: { displayName: author.displayName },
          memory: Option.getOrNull(memory),
        };
      });

    return {
      memory_read: () => run(),
      memory_update: ({ content }) => run(content),
    };
  }),
);
