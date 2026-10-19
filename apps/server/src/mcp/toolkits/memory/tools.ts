import { USER_MEMORY_MAX_CHARS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

export class UserMemoryToolError extends Schema.TaggedErrorClass<UserMemoryToolError>()(
  "UserMemoryToolError",
  { message: Schema.String },
) {}

export const UserMemoryResult = Schema.Struct({
  author: Schema.Struct({
    displayName: Schema.String,
  }),
  memory: Schema.NullOr(Schema.String),
});
export type UserMemoryResult = typeof UserMemoryResult.Type;

const dependencies = [McpInvocationContext.McpInvocationContext];

export const MemoryReadTool = Tool.make("memory_read", {
  description:
    "Read the stored memory of the person who sent the current message in this thread. The memory belongs to that author only; other users' memory is never readable.",
  success: UserMemoryResult,
  failure: UserMemoryToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read user memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const MemoryUpdateTool = Tool.make("memory_update", {
  description: `Replace the stored memory of the person who sent the current message. Call this ONLY when that person explicitly asks you to remember, change, or forget something about them. Never store memory on your own initiative. Read the memory first, then pass the full new markdown content (max ${USER_MEMORY_MAX_CHARS} characters). Pass an empty string to forget everything. The memory is added to every later message from that person.`,
  parameters: Schema.Struct({
    content: Schema.String.check(Schema.isMaxLength(USER_MEMORY_MAX_CHARS)),
  }),
  success: UserMemoryResult,
  failure: UserMemoryToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update user memory")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const MemoryToolkit = Toolkit.make(MemoryReadTool, MemoryUpdateTool);
