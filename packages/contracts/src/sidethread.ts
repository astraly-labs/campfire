import * as Effect from "effect/Effect";
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
 * Default-empty array of {@link UserRef} mentions. We use
 * `withDecodingDefaultKey` so events persisted before the mention feature
 * decode cleanly with `mentions = []`.
 */
const MentionsField = Schema.Array(UserRef).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])));

/**
 * Optional reference to the parent-thread agent message a side-thread message
 * is quoting. Older events predate this field; the decoder defaults to `null`
 * so historical payloads decode without modification.
 */
const QuotedMessageIdField = Schema.NullOr(MessageId).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(null)),
);

/**
 * Single Slack-style side conversation per parent thread. One side-thread
 * exists per parent thread; humans use it to discuss the agent's work
 * without interrupting the agent. Individual messages can optionally quote
 * a specific agent message via `quotedMessageId`.
 */
export const SideThreadId = TrimmedNonEmptyString.pipe(Schema.brand("SideThreadId"));
export type SideThreadId = typeof SideThreadId.Type;

export const SideThreadMessageId = TrimmedNonEmptyString.pipe(Schema.brand("SideThreadMessageId"));
export type SideThreadMessageId = typeof SideThreadMessageId.Type;

export const SideThreadAggregateKind = Schema.Literal("sidethread");
export type SideThreadAggregateKind = typeof SideThreadAggregateKind.Type;

/**
 * Mentions denormalized into the message at write time. Each mention is a
 * pinned {@link UserRef} so historical messages still render correctly if a
 * user later renames themselves. Optional with default `[]` so messages
 * persisted before the inbox feature decode without errors.
 */
export const SideThreadMessage = Schema.Struct({
  id: SideThreadMessageId,
  author: UserRef,
  text: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  mentions: MentionsField,
  quotedMessageId: QuotedMessageIdField,
});
export type SideThreadMessage = typeof SideThreadMessage.Type;

/**
 * Read-model snapshot of a side thread aggregate.
 */
export const SideThread = Schema.Struct({
  id: SideThreadId,
  parentThreadId: ThreadId,
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
  /**
   * Users explicitly tagged by the author. The composer resolves the
   * autocomplete selection into a {@link UserRef} list and ships it alongside
   * the text — we don't reparse `@handles` server-side so a user with `@`
   * in their handle can't be spoofed. Optional for older clients.
   */
  mentions: MentionsField,
  /**
   * Optional parent-thread message this side-thread message is quoting —
   * populated by the "Cite excerpt" and "Take a look" affordances. The UI
   * uses it to render a tiny back-reference and to scroll to the referenced
   * message in the parent thread.
   */
  quotedMessageId: QuotedMessageIdField,
});
export type SideThreadMessagePostCommand = typeof SideThreadMessagePostCommand.Type;

export const SideThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("sidethread.archive"),
  commandId: CommandId,
  sideThreadId: SideThreadId,
  archivedBy: UserId,
});
export type SideThreadArchiveCommand = typeof SideThreadArchiveCommand.Type;

/**
 * Soft-dismiss the inbox row for `(userId, sideThreadId)`. The mention
 * history stays in `projection_side_thread_message_mentions`; the inbox
 * read model filters anything `<= dismissed_at`. Any future mention with a
 * later `occurredAt` re-surfaces the row.
 *
 * The server overrides `userId` with the WebSocket session's identity so a
 * peer cannot dismiss another user's inbox row.
 */
export const SideThreadInboxDismissCommand = Schema.Struct({
  type: Schema.Literal("sidethread.inbox.dismiss"),
  commandId: CommandId,
  sideThreadId: SideThreadId,
  userId: UserId,
});
export type SideThreadInboxDismissCommand = typeof SideThreadInboxDismissCommand.Type;

export const SideThreadCommand = Schema.Union([
  SideThreadCreateCommand,
  SideThreadMessagePostCommand,
  SideThreadArchiveCommand,
  SideThreadInboxDismissCommand,
]);
export type SideThreadCommand = typeof SideThreadCommand.Type;

export const SideThreadCommandType = Schema.Literals([
  "sidethread.create",
  "sidethread.message.post",
  "sidethread.archive",
  "sidethread.inbox.dismiss",
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
  createdBy: UserRef,
});
export type SideThreadCreatedPayload = typeof SideThreadCreatedPayload.Type;

export const SideThreadMessagePostedPayload = Schema.Struct({
  sideThreadId: SideThreadId,
  messageId: SideThreadMessageId,
  author: UserRef,
  text: TrimmedNonEmptyString,
  mentions: MentionsField,
  quotedMessageId: QuotedMessageIdField,
});
export type SideThreadMessagePostedPayload = typeof SideThreadMessagePostedPayload.Type;

export const SideThreadArchivedPayload = Schema.Struct({
  sideThreadId: SideThreadId,
  archivedBy: UserId,
});
export type SideThreadArchivedPayload = typeof SideThreadArchivedPayload.Type;

export const SideThreadInboxDismissedPayload = Schema.Struct({
  sideThreadId: SideThreadId,
  userId: UserId,
});
export type SideThreadInboxDismissedPayload = typeof SideThreadInboxDismissedPayload.Type;

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

export const SideThreadInboxDismissedEvent = Schema.Struct({
  ...SideThreadEventBaseFields,
  type: Schema.Literal("sidethread.inbox-dismissed"),
  payload: SideThreadInboxDismissedPayload,
});
export type SideThreadInboxDismissedEvent = typeof SideThreadInboxDismissedEvent.Type;

export const SideThreadEvent = Schema.Union([
  SideThreadCreatedEvent,
  SideThreadMessagePostedEvent,
  SideThreadArchivedEvent,
  SideThreadInboxDismissedEvent,
]);
export type SideThreadEvent = typeof SideThreadEvent.Type;

export const SideThreadEventType = Schema.Literals([
  "sidethread.created",
  "sidethread.message-posted",
  "sidethread.archived",
  "sidethread.inbox-dismissed",
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
