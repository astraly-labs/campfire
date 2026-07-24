import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ContextAssistantSessionId = TrimmedNonEmptyString.pipe(
  Schema.brand("ContextAssistantSessionId"),
);
export type ContextAssistantSessionId = typeof ContextAssistantSessionId.Type;

export const ContextAssistantAskInput = Schema.Struct({
  sessionId: ContextAssistantSessionId,
  sourceThreadId: ThreadId,
  prompt: TrimmedNonEmptyString,
});
export type ContextAssistantAskInput = typeof ContextAssistantAskInput.Type;

export const ContextAssistantCloseInput = Schema.Struct({
  sessionId: ContextAssistantSessionId,
});
export type ContextAssistantCloseInput = typeof ContextAssistantCloseInput.Type;

export const ContextAssistantCloseResult = Schema.Struct({
  closed: Schema.Boolean,
});
export type ContextAssistantCloseResult = typeof ContextAssistantCloseResult.Type;

export const ContextAssistantStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("assistant.delta"),
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("assistant.completed"),
  }),
  Schema.Struct({
    type: Schema.Literal("assistant.failed"),
    message: TrimmedNonEmptyString,
  }),
]);
export type ContextAssistantStreamEvent = typeof ContextAssistantStreamEvent.Type;

export class ContextAssistantError extends Schema.TaggedErrorClass<ContextAssistantError>()(
  "ContextAssistantError",
  {
    code: Schema.Literals([
      "source_not_found",
      "session_conflict",
      "session_busy",
      "provider_error",
    ]),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
