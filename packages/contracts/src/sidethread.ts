import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
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
 * `parentThreadId` is nullable to support workspace-wide global chats that
 * are not anchored to any agent thread. Default-decoded to `null` so events
 * that omit the key (e.g. global-chat creation) parse cleanly; historical
 * events that always carried a parent decode unchanged.
 */
const ParentThreadIdField = Schema.NullOr(ThreadId).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(null)),
);

/**
 * Polymorphic pointer to "another conversation" that the author wants to
 * attach to a side-thread message — the "link a chat" affordance. Renders
 * as a clickable card that navigates to the target.
 *
 * V1 ships two kinds: a regular agent thread, and the workspace-wide global
 * chat. The discriminated union keeps the door open for future kinds
 * (e.g. `side-thread` to deep-link into a specific peer side thread) without
 * re-shaping the message payload.
 */
export const LinkedAgentThreadRef = Schema.Struct({
  kind: Schema.Literal("agent-thread"),
  threadId: ThreadId,
});
export type LinkedAgentThreadRef = typeof LinkedAgentThreadRef.Type;

export const LinkedGlobalChatRef = Schema.Struct({
  kind: Schema.Literal("global-chat"),
});
export type LinkedGlobalChatRef = typeof LinkedGlobalChatRef.Type;

export const LinkedRef = Schema.Union([LinkedAgentThreadRef, LinkedGlobalChatRef]);
export type LinkedRef = typeof LinkedRef.Type;

/**
 * Default-decoded to `null` so historical messages without a link decode
 * unchanged. Composer ships the resolved {@link LinkedRef} alongside
 * `mentions` / `quotedMessageId` / `attachments`.
 */
const LinkedRefField = Schema.NullOr(LinkedRef).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(null)),
);


/**
 * Inline media stapled onto a side-thread message. V1 ships GIFs only —
 * the discriminated union keeps the door open for future `image`/`file`
 * variants without re-shaping the message payload.
 */
export const SideThreadGifAttachment = Schema.Struct({
  kind: Schema.Literal("gif"),
  /**
   * Playback URL — Tenor's MP4/WebM variant. Rendered as an autoplay/loop/
   * muted `<video>` to mirror Telegram's silent-GIF UX while still streaming
   * efficiently.
   */
  url: TrimmedNonEmptyString,
  /** Static preview thumbnail used while the video loads. */
  previewUrl: TrimmedNonEmptyString,
  width: PositiveInt,
  height: PositiveInt,
  /**
   * Provider-side id (e.g. Tenor `id`). Stored so clients can call
   * `/registershare` post-send per Tenor TOS and so we can dedup or
   * surface analytics later.
   */
  providerId: Schema.NullOr(TrimmedNonEmptyString),
});
export type SideThreadGifAttachment = typeof SideThreadGifAttachment.Type;

export const SideThreadAttachment = Schema.Union([SideThreadGifAttachment]);
export type SideThreadAttachment = typeof SideThreadAttachment.Type;

/**
 * Default-empty list of attachments. Same back-compat trick as
 * {@link MentionsField}: messages persisted before this feature decode
 * cleanly with `attachments = []`.
 */
const AttachmentsField = Schema.Array(SideThreadAttachment).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed([])),
);

/**
 * Reaction bucket — one entry per distinct emoji, with the denormalized
 * {@link UserRef} list of reactors so the UI can render names without an
 * extra round-trip. Pinning the `UserRef` mirrors how we pin mentions.
 */
export const SideThreadMessageReaction = Schema.Struct({
  emoji: TrimmedNonEmptyString,
  users: Schema.Array(UserRef),
});
export type SideThreadMessageReaction = typeof SideThreadMessageReaction.Type;

const ReactionsField = Schema.Array(SideThreadMessageReaction).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed([])),
);

/**
 * Single Slack-style side conversation per parent thread. One side-thread
 * exists per parent thread; humans use it to discuss the agent's work
 * without interrupting the agent. Individual messages can optionally quote
 * a specific agent message via `quotedMessageId`.
 */
export const SideThreadId = TrimmedNonEmptyString.pipe(Schema.brand("SideThreadId"));
export type SideThreadId = typeof SideThreadId.Type;

/**
 * Well-known SideThreadId for the workspace-wide "Global chat" — a single
 * Slack-style channel shared by everyone in the workspace, not anchored to
 * any agent thread. The id is hard-coded so client and server can both refer
 * to it without a discovery round-trip. The aggregate is created lazily on
 * the first subscribe (server-side) by `ensureGlobalChat`.
 */
export const GLOBAL_CHAT_SIDETHREAD_ID = "st-global" as unknown as SideThreadId;

export const isGlobalChat = (id: SideThreadId): boolean =>
  (id as unknown as string) === (GLOBAL_CHAT_SIDETHREAD_ID as unknown as string);

export const SideThreadMessageId = TrimmedNonEmptyString.pipe(Schema.brand("SideThreadMessageId"));
export type SideThreadMessageId = typeof SideThreadMessageId.Type;

/**
 * Reply-to pointer for a message that is itself a side-thread message —
 * Telegram-style "tap to reply". Distinct from {@link QuotedMessageIdField}
 * which targets a parent-thread *agent* message (the "Take a look" flow).
 * Default-null so events persisted before this feature decode cleanly.
 */
const ReplyToSideThreadMessageIdField = Schema.NullOr(SideThreadMessageId).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(null)),
);

/**
 * Timestamp of the last in-place edit, or `null` for never-edited
 * messages. The UI uses non-null as the trigger for the "edited" hint
 * next to the timestamp (Telegram convention).
 */
const EditedAtField = Schema.NullOr(IsoDateTime).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(null)),
);

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
  /**
   * `text` is optional at write time when the message carries a non-empty
   * `attachments` list (e.g. a standalone GIF). The decoder accepts the
   * legacy required-string shape via the default-key fallback so historical
   * messages decode unchanged.
   */
  text: TrimmedString,
  author: UserRef,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  mentions: MentionsField,
  quotedMessageId: QuotedMessageIdField,
  attachments: AttachmentsField,
  reactions: ReactionsField,
  /** Optional "link a chat" pointer; see {@link LinkedRef}. */
  linkedRef: LinkedRefField,
  /** Optional reply target — see {@link ReplyToSideThreadMessageIdField}. */
  replyToSideThreadMessageId: ReplyToSideThreadMessageIdField,
  /** Last edit timestamp, or `null` if the message has never been edited. */
  editedAt: EditedAtField,
});
export type SideThreadMessage = typeof SideThreadMessage.Type;

/**
 * Per-user "last read" marker inside a side thread. We pin the {@link UserRef}
 * (rather than just the id) so the UI can render "seen by Bob" without a
 * directory lookup if Bob is later renamed or removed from the workspace.
 *
 * `lastReadAt` is the `occurredAt` of the last message the user has
 * acknowledged — a message M is considered seen by U when
 * `readBy[U].lastReadAt >= M.createdAt`. We compare on timestamps rather
 * than messageIds so we don't need an index lookup to answer "is this
 * message seen".
 */
export const SideThreadReadMarker = Schema.Struct({
  user: UserRef,
  lastReadAt: IsoDateTime,
});
export type SideThreadReadMarker = typeof SideThreadReadMarker.Type;

const ReadByField = Schema.Array(SideThreadReadMarker).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed([])),
);

/**
 * Read-model snapshot of a side thread aggregate.
 */
export const SideThread = Schema.Struct({
  id: SideThreadId,
  /** `null` for the workspace-wide global chat. See {@link GLOBAL_CHAT_SIDETHREAD_ID}. */
  parentThreadId: ParentThreadIdField,
  createdBy: UserRef,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(SideThreadMessage),
  /** Per-user "last read" markers. Empty for fresh threads or older events. */
  readBy: ReadByField,
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
  /** `null` creates a workspace-wide global chat (not anchored to any agent thread). */
  parentThreadId: ParentThreadIdField,
  createdBy: UserRef,
});
export type SideThreadCreateCommand = typeof SideThreadCreateCommand.Type;

export const SideThreadMessagePostCommand = Schema.Struct({
  type: Schema.Literal("sidethread.message.post"),
  commandId: CommandId,
  sideThreadId: SideThreadId,
  messageId: SideThreadMessageId,
  author: UserRef,
  /**
   * Allowed to be empty when {@link attachments} is non-empty (e.g. a
   * standalone GIF). The decider enforces "at least one of text or
   * attachments" so empty/empty posts can't be persisted.
   */
  text: TrimmedString,
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
  /** Inline media (GIFs in V1). Defaults to empty for older clients. */
  attachments: AttachmentsField,
  /** Optional pointer to another conversation. Defaults to `null`. */
  linkedRef: LinkedRefField,
  /** Optional reply target (a previous message in the same side thread). */
  replyToSideThreadMessageId: ReplyToSideThreadMessageIdField,
});
export type SideThreadMessagePostCommand = typeof SideThreadMessagePostCommand.Type;

/**
 * Toggle a single emoji reaction by `user` on `messageId`. The decider
 * inspects the current read model: if `user` has already reacted with
 * `emoji` it emits `action: "removed"`, otherwise `"added"`. Keeping this a
 * single toggle command (rather than separate add/remove) means the UI
 * doesn't need to track which buckets the user is in — it just dispatches
 * the emoji and lets the server resolve.
 */
export const SideThreadMessageReactCommand = Schema.Struct({
  type: Schema.Literal("sidethread.message.react"),
  commandId: CommandId,
  sideThreadId: SideThreadId,
  messageId: SideThreadMessageId,
  user: UserRef,
  emoji: TrimmedNonEmptyString,
});
export type SideThreadMessageReactCommand = typeof SideThreadMessageReactCommand.Type;

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

/**
 * In-place edit of a previously-posted side-thread message. The decider
 * enforces that {@link editor} matches the original author — peers
 * cannot rewrite each other's messages. Empty text is rejected (use the
 * future delete command for that).
 */
export const SideThreadMessageEditCommand = Schema.Struct({
  type: Schema.Literal("sidethread.message.edit"),
  commandId: CommandId,
  sideThreadId: SideThreadId,
  messageId: SideThreadMessageId,
  editor: UserRef,
  text: TrimmedNonEmptyString,
});
export type SideThreadMessageEditCommand = typeof SideThreadMessageEditCommand.Type;

/**
 * Telegram-style "I've seen up to here" marker. Clients dispatch this when
 * the drawer is opened or when a new message arrives while the drawer is
 * focused. The decider drops the command as a no-op if `lastReadAt` is not
 * strictly newer than the user's current marker — read state is monotonic.
 */
export const SideThreadMarkReadCommand = Schema.Struct({
  type: Schema.Literal("sidethread.mark-read"),
  commandId: CommandId,
  sideThreadId: SideThreadId,
  user: UserRef,
  lastReadAt: IsoDateTime,
});
export type SideThreadMarkReadCommand = typeof SideThreadMarkReadCommand.Type;

export const SideThreadCommand = Schema.Union([
  SideThreadCreateCommand,
  SideThreadMessagePostCommand,
  SideThreadMessageReactCommand,
  SideThreadArchiveCommand,
  SideThreadInboxDismissCommand,
  SideThreadMarkReadCommand,
  SideThreadMessageEditCommand,
]);
export type SideThreadCommand = typeof SideThreadCommand.Type;

export const SideThreadCommandType = Schema.Literals([
  "sidethread.create",
  "sidethread.message.post",
  "sidethread.message.react",
  "sidethread.archive",
  "sidethread.inbox.dismiss",
  "sidethread.mark-read",
  "sidethread.message.edit",
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
  parentThreadId: ParentThreadIdField,
  createdBy: UserRef,
});
export type SideThreadCreatedPayload = typeof SideThreadCreatedPayload.Type;

export const SideThreadMessagePostedPayload = Schema.Struct({
  sideThreadId: SideThreadId,
  messageId: SideThreadMessageId,
  author: UserRef,
  text: TrimmedString,
  mentions: MentionsField,
  quotedMessageId: QuotedMessageIdField,
  attachments: AttachmentsField,
  linkedRef: LinkedRefField,
  replyToSideThreadMessageId: ReplyToSideThreadMessageIdField,
});
export type SideThreadMessagePostedPayload = typeof SideThreadMessagePostedPayload.Type;

/**
 * The toggle resolved into a concrete add/remove. We persist `action` so
 * a stream subscriber can apply the delta without re-running the toggle
 * logic — important for the projector which only sees one event at a time.
 */
export const SideThreadMessageReactedPayload = Schema.Struct({
  sideThreadId: SideThreadId,
  messageId: SideThreadMessageId,
  user: UserRef,
  emoji: TrimmedNonEmptyString,
  action: Schema.Literals(["added", "removed"]),
});
export type SideThreadMessageReactedPayload = typeof SideThreadMessageReactedPayload.Type;

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

export const SideThreadMarkedReadPayload = Schema.Struct({
  sideThreadId: SideThreadId,
  user: UserRef,
  lastReadAt: IsoDateTime,
});
export type SideThreadMarkedReadPayload = typeof SideThreadMarkedReadPayload.Type;

export const SideThreadMessageEditedPayload = Schema.Struct({
  sideThreadId: SideThreadId,
  messageId: SideThreadMessageId,
  editor: UserRef,
  text: TrimmedNonEmptyString,
});
export type SideThreadMessageEditedPayload = typeof SideThreadMessageEditedPayload.Type;

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

export const SideThreadMessageReactedEvent = Schema.Struct({
  ...SideThreadEventBaseFields,
  type: Schema.Literal("sidethread.message-reacted"),
  payload: SideThreadMessageReactedPayload,
});
export type SideThreadMessageReactedEvent = typeof SideThreadMessageReactedEvent.Type;

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

export const SideThreadMarkedReadEvent = Schema.Struct({
  ...SideThreadEventBaseFields,
  type: Schema.Literal("sidethread.marked-read"),
  payload: SideThreadMarkedReadPayload,
});
export type SideThreadMarkedReadEvent = typeof SideThreadMarkedReadEvent.Type;

export const SideThreadMessageEditedEvent = Schema.Struct({
  ...SideThreadEventBaseFields,
  type: Schema.Literal("sidethread.message-edited"),
  payload: SideThreadMessageEditedPayload,
});
export type SideThreadMessageEditedEvent = typeof SideThreadMessageEditedEvent.Type;

export const SideThreadEvent = Schema.Union([
  SideThreadCreatedEvent,
  SideThreadMessagePostedEvent,
  SideThreadMessageReactedEvent,
  SideThreadArchivedEvent,
  SideThreadInboxDismissedEvent,
  SideThreadMarkedReadEvent,
  SideThreadMessageEditedEvent,
]);
export type SideThreadEvent = typeof SideThreadEvent.Type;

export const SideThreadEventType = Schema.Literals([
  "sidethread.created",
  "sidethread.message-posted",
  "sidethread.message-reacted",
  "sidethread.archived",
  "sidethread.inbox-dismissed",
  "sidethread.marked-read",
  "sidethread.message-edited",
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
