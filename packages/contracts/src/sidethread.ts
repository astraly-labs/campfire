import * as Schema from "effect/Schema";

import {
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { UserId, UserRef } from "./user.ts";

/**
 * Slack-style side conversation anchored to a parent agent thread. Lets
 * humans discuss a specific message without interrupting the agent.
 */
export const SideThreadId = TrimmedNonEmptyString.pipe(Schema.brand("SideThreadId"));
export type SideThreadId = typeof SideThreadId.Type;

export const SideThreadMessageId = TrimmedNonEmptyString.pipe(Schema.brand("SideThreadMessageId"));
export type SideThreadMessageId = typeof SideThreadMessageId.Type;

export const SideThreadAggregateKind = Schema.Literal("sidethread");
export type SideThreadAggregateKind = typeof SideThreadAggregateKind.Type;

/**
 * Where the side thread is hooked into the parent conversation. v0 only
 * supports anchoring on a whole orchestration message; finer-grained
 * anchoring (per content block, per code range) is intentionally out of
 * scope for the first release.
 */
export const SideThreadAnchorKind = Schema.Literals(["message"]);
export type SideThreadAnchorKind = typeof SideThreadAnchorKind.Type;

export const SideThreadMessageAnchor = Schema.Struct({
  kind: Schema.Literal("message"),
  messageId: MessageId,
});
export type SideThreadMessageAnchor = typeof SideThreadMessageAnchor.Type;

export const SideThreadAnchor = Schema.Union([SideThreadMessageAnchor]);
export type SideThreadAnchor = typeof SideThreadAnchor.Type;

export const SideThreadMessage = Schema.Struct({
  id: SideThreadMessageId,
  author: UserRef,
  text: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SideThreadMessage = typeof SideThreadMessage.Type;

/**
 * Read-model snapshot of a side thread aggregate.
 */
export const SideThread = Schema.Struct({
  id: SideThreadId,
  parentThreadId: ThreadId,
  anchor: SideThreadAnchor,
  createdBy: UserRef,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(SideThreadMessage),
});
export type SideThread = typeof SideThread.Type;

export const SideThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  sideThread: SideThread,
});
export type SideThreadDetailSnapshot = typeof SideThreadDetailSnapshot.Type;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const SideThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("sidethread.create"),
  commandId: CommandId,
  sideThreadId: SideThreadId,
  parentThreadId: ThreadId,
  anchor: SideThreadAnchor,
  createdBy: UserRef,
});
export type SideThreadCreateCommand = typeof SideThreadCreateCommand.Type;

export const SideThreadMessagePostCommand = Schema.Struct({
  type: Schema.Literal("sidethread.message.post"),
  commandId: CommandId,
  sideThreadId: SideThreadId,
  messageId: SideThreadMessageId,
  author: UserRef,
  text: TrimmedNonEmptyString,
});
export type SideThreadMessagePostCommand = typeof SideThreadMessagePostCommand.Type;

export const SideThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("sidethread.archive"),
  commandId: CommandId,
  sideThreadId: SideThreadId,
  archivedBy: UserId,
});
export type SideThreadArchiveCommand = typeof SideThreadArchiveCommand.Type;

export const SideThreadCommand = Schema.Union([
  SideThreadCreateCommand,
  SideThreadMessagePostCommand,
  SideThreadArchiveCommand,
]);
export type SideThreadCommand = typeof SideThreadCommand.Type;

export const SideThreadCommandType = Schema.Literals([
  "sidethread.create",
  "sidethread.message.post",
  "sidethread.archive",
]);
export type SideThreadCommandType = typeof SideThreadCommandType.Type;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const SideThreadEventMetadata = Schema.Struct({});
export type SideThreadEventMetadata = typeof SideThreadEventMetadata.Type;

const SideThreadEventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: SideThreadAggregateKind,
  aggregateId: SideThreadId,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: SideThreadEventMetadata,
} as const;

export const SideThreadCreatedPayload = Schema.Struct({
  sideThreadId: SideThreadId,
  parentThreadId: ThreadId,
  anchor: SideThreadAnchor,
  createdBy: UserRef,
});
export type SideThreadCreatedPayload = typeof SideThreadCreatedPayload.Type;

export const SideThreadMessagePostedPayload = Schema.Struct({
  sideThreadId: SideThreadId,
  messageId: SideThreadMessageId,
  author: UserRef,
  text: TrimmedNonEmptyString,
});
export type SideThreadMessagePostedPayload = typeof SideThreadMessagePostedPayload.Type;

export const SideThreadArchivedPayload = Schema.Struct({
  sideThreadId: SideThreadId,
  archivedBy: UserId,
});
export type SideThreadArchivedPayload = typeof SideThreadArchivedPayload.Type;

export const SideThreadCreatedEvent = Schema.Struct({
  ...SideThreadEventBaseFields,
  type: Schema.Literal("sidethread.created"),
  payload: SideThreadCreatedPayload,
});
export type SideThreadCreatedEvent = typeof SideThreadCreatedEvent.Type;

export const SideThreadMessagePostedEvent = Schema.Struct({
  ...SideThreadEventBaseFields,
  type: Schema.Literal("sidethread.message-posted"),
  payload: SideThreadMessagePostedPayload,
});
export type SideThreadMessagePostedEvent = typeof SideThreadMessagePostedEvent.Type;

export const SideThreadArchivedEvent = Schema.Struct({
  ...SideThreadEventBaseFields,
  type: Schema.Literal("sidethread.archived"),
  payload: SideThreadArchivedPayload,
});
export type SideThreadArchivedEvent = typeof SideThreadArchivedEvent.Type;

export const SideThreadEvent = Schema.Union([
  SideThreadCreatedEvent,
  SideThreadMessagePostedEvent,
  SideThreadArchivedEvent,
]);
export type SideThreadEvent = typeof SideThreadEvent.Type;

export const SideThreadEventType = Schema.Literals([
  "sidethread.created",
  "sidethread.message-posted",
  "sidethread.archived",
]);
export type SideThreadEventType = typeof SideThreadEventType.Type;

// ---------------------------------------------------------------------------
// Stream items (WebSocket subscriptions)
// ---------------------------------------------------------------------------

export const SideThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: SideThreadDetailSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: SideThreadEvent,
  }),
]);
export type SideThreadStreamItem = typeof SideThreadStreamItem.Type;

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export const SideThreadDispatchResult = Schema.Struct({
  acceptedAt: IsoDateTime,
  events: Schema.Array(SideThreadEvent),
});
export type SideThreadDispatchResult = typeof SideThreadDispatchResult.Type;

export const SideThreadSubscribeInput = Schema.Struct({
  sideThreadId: SideThreadId,
});
export type SideThreadSubscribeInput = typeof SideThreadSubscribeInput.Type;

export const SideThreadRpcSchemas = {
  dispatchCommand: {
    input: SideThreadCommand,
    output: SideThreadDispatchResult,
  },
  subscribeSideThread: {
    input: SideThreadSubscribeInput,
    output: SideThreadStreamItem,
  },
} as const;

export const SIDETHREAD_WS_METHODS = {
  dispatchCommand: "sidethread.dispatchCommand",
  subscribeSideThread: "sidethread.subscribeSideThread",
} as const;
export type SideThreadWsMethod = (typeof SIDETHREAD_WS_METHODS)[keyof typeof SIDETHREAD_WS_METHODS];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SideThreadDispatchCommandError extends Schema.TaggedErrorClass<SideThreadDispatchCommandError>()(
  "SideThreadDispatchCommandError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class SideThreadSubscribeError extends Schema.TaggedErrorClass<SideThreadSubscribeError>()(
  "SideThreadSubscribeError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class SideThreadGetSnapshotError extends Schema.TaggedErrorClass<SideThreadGetSnapshotError>()(
  "SideThreadGetSnapshotError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
