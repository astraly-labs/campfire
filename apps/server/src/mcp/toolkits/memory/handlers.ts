import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TurnAuthorService from "../../../orchestration-v2/TurnAuthorService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { MemoryToolkit } from "./tools.ts";

const callingThreadId = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "The memory tools")),
  Effect.map((scope) => scope.thread.threadId),
);

const toMcpFailure = (
  error: TurnAuthorService.TurnAuthorUnknownError | TurnAuthorService.TurnAuthorMemoryError,
) =>
  error._tag === "TurnAuthorUnknownError"
    ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
    : unavailable();

export const layer = McpToolAccess.toLayer(MemoryToolkit, {
  memory_read: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const threadId = yield* callingThreadId;
      const turnAuthors = yield* TurnAuthorService.TurnAuthorService;
      return yield* turnAuthors.readMemory(threadId).pipe(Effect.mapError(toMcpFailure));
    }),
  ),
  memory_update: McpToolAccess.actsAsCaller(({ content }) =>
    Effect.gen(function* () {
      const threadId = yield* callingThreadId;
      const turnAuthors = yield* TurnAuthorService.TurnAuthorService;
      return yield* turnAuthors
        .replaceMemory({ threadId, content })
        .pipe(Effect.mapError(toMcpFailure));
    }),
  ),
});
