import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as TurnAuthorService from "../../../orchestration-v2/TurnAuthorService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  success: Schema.Struct({
    author: Schema.Struct({ displayName: Schema.String }),
    memory: Schema.NullOr(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    TurnAuthorService.TurnAuthorService,
  ],
};

const MemoryReadTool = Tool.make("memory_read", {
  ...shared,
  description:
    "Needs an agent running inside a T3 thread. Read the stored memory of the person who sent the current message in this thread. The memory belongs to that person only; other people's memory is never readable.",
})
  .annotate(Tool.Title, "Read user memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const MemoryUpdateTool = Tool.make("memory_update", {
  ...shared,
  description: `Needs an agent running inside a T3 thread. Replace the stored memory of the person who sent the current message. Call this ONLY when that person explicitly asks you to remember, change, or forget something about them. Never store memory on your own initiative. Read the memory first, then pass the full new markdown content (max ${TurnAuthorService.USER_MEMORY_MAX_CHARS} characters). Pass an empty string to forget everything. The memory is added to every later message from that person.`,
  parameters: Schema.Struct({
    content: Schema.String.check(Schema.isMaxLength(TurnAuthorService.USER_MEMORY_MAX_CHARS)),
  }),
})
  .annotate(Tool.Title, "Update user memory")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const MemoryToolkit = Toolkit.make(MemoryReadTool, MemoryUpdateTool);
