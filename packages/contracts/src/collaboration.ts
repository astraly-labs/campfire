import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ASSISTANT_CITATION_CONTEXT_LENGTH,
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
} from "./assistantCitations.ts";
import { ChatImageAttachment, UploadChatImageAttachment } from "./chatAttachment.ts";

export const ThreadKind = Schema.Literals(["default", "review"]);
export type ThreadKind = typeof ThreadKind.Type;
export const DEFAULT_THREAD_KIND: ThreadKind = "default";

export const CollaborationUser = Schema.Struct({
  subject: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
});
export type CollaborationUser = typeof CollaborationUser.Type;

export const SideThreadId = TrimmedNonEmptyString.pipe(Schema.brand("SideThreadId"));
export type SideThreadId = typeof SideThreadId.Type;
export const SideThreadMessageId = TrimmedNonEmptyString.pipe(Schema.brand("SideThreadMessageId"));
export type SideThreadMessageId = typeof SideThreadMessageId.Type;

export const SideThreadAuthor = CollaborationUser;
export type SideThreadAuthor = typeof SideThreadAuthor.Type;

export const SideThreadGifAttachment = Schema.Struct({
  type: Schema.Literal("gif"),
  url: TrimmedNonEmptyString,
  previewUrl: TrimmedNonEmptyString,
  width: NonNegativeInt,
  height: NonNegativeInt,
  providerId: Schema.optional(TrimmedNonEmptyString),
});
export type SideThreadGifAttachment = typeof SideThreadGifAttachment.Type;

export const SideThreadAttachment = Schema.Union([ChatImageAttachment, SideThreadGifAttachment]);
export type SideThreadAttachment = typeof SideThreadAttachment.Type;

export const SideThreadPostAttachment = Schema.Union([
  UploadChatImageAttachment,
  SideThreadGifAttachment,
]);
export type SideThreadPostAttachment = typeof SideThreadPostAttachment.Type;

export const SideThreadLinkedRef = Schema.Struct({
  kind: Schema.Literal("agent-thread"),
  threadId: ThreadId,
});
export type SideThreadLinkedRef = typeof SideThreadLinkedRef.Type;

/** One selection toolbar both cites and quotes, so both share the citation length limit. */
export const SIDE_THREAD_QUOTE_MAX_TEXT_LENGTH = ASSISTANT_CITATION_MAX_TEXT_LENGTH;

/**
 * The passage of `quotedMessageId` that a side-thread message quotes. It is
 * located in the rendered message text the way an assistant citation is.
 */
export const SideThreadQuotedExcerpt = Schema.Struct({
  text: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(SIDE_THREAD_QUOTE_MAX_TEXT_LENGTH),
  ),
  start: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  end: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  prefix: Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_CONTEXT_LENGTH)),
  suffix: Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_CONTEXT_LENGTH)),
}).check(
  Schema.makeFilter((excerpt) => excerpt.end > excerpt.start && excerpt.text.trim().length > 0),
);
export type SideThreadQuotedExcerpt = typeof SideThreadQuotedExcerpt.Type;

export const SideThreadMessageReaction = Schema.Struct({
  emoji: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
  users: Schema.Array(SideThreadAuthor),
});
export type SideThreadMessageReaction = typeof SideThreadMessageReaction.Type;

export const SideThreadReadMarker = Schema.Struct({
  user: SideThreadAuthor,
  lastReadAt: IsoDateTime,
});
export type SideThreadReadMarker = typeof SideThreadReadMarker.Type;

export const SideThreadMessage = Schema.Struct({
  id: SideThreadMessageId,
  author: SideThreadAuthor,
  text: Schema.String.check(Schema.isMaxLength(20_000)),
  mentions: Schema.optional(Schema.Array(SideThreadAuthor)),
  quotedMessageId: Schema.optional(MessageId),
  quotedExcerpt: Schema.optional(SideThreadQuotedExcerpt),
  attachments: Schema.optional(Schema.Array(SideThreadAttachment)),
  reactions: Schema.optional(Schema.Array(SideThreadMessageReaction)),
  linkedRef: Schema.optional(SideThreadLinkedRef),
  replyToSideThreadMessageId: Schema.optional(SideThreadMessageId),
  createdAt: IsoDateTime,
  updatedAt: Schema.optional(IsoDateTime),
  editedAt: Schema.optional(IsoDateTime),
});
export type SideThreadMessage = typeof SideThreadMessage.Type;

export const SideThread = Schema.Struct({
  id: SideThreadId,
  anchorMessageId: Schema.optional(MessageId),
  createdBy: SideThreadAuthor,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(SideThreadMessage),
  readBy: Schema.optional(Schema.Array(SideThreadReadMarker)),
});
export type SideThread = typeof SideThread.Type;

export const SideThreadShellMessagePreview = Schema.Struct({
  id: SideThreadMessageId,
  author: SideThreadAuthor,
  text: Schema.String.check(Schema.isMaxLength(500)),
  mentions: Schema.Array(SideThreadAuthor),
  hasAttachments: Schema.Boolean,
  createdAt: IsoDateTime,
  editedAt: Schema.optional(IsoDateTime),
});
export type SideThreadShellMessagePreview = typeof SideThreadShellMessagePreview.Type;

/** Bounded collaboration metadata carried by thread-shell snapshots. */
export const SideThreadShellSummary = Schema.Struct({
  id: SideThreadId,
  anchorMessageId: Schema.optional(MessageId),
  createdBy: SideThreadAuthor,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  messageCount: NonNegativeInt,
  latestMessage: Schema.NullOr(SideThreadShellMessagePreview),
  latestMentions: Schema.Array(SideThreadShellMessagePreview),
  participants: Schema.Array(SideThreadAuthor),
  readBy: Schema.Array(SideThreadReadMarker),
});
export type SideThreadShellSummary = typeof SideThreadShellSummary.Type;

export const SideThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("sidethread.create"),
  commandId: CommandId,
  collaborationUser: Schema.optional(Schema.NullOr(CollaborationUser)),
  threadId: ThreadId,
  sideThreadId: SideThreadId,
  anchorMessageId: Schema.optional(MessageId),
  createdAt: IsoDateTime,
});

export const ClientSideThreadMessagePostCommand = Schema.Struct({
  type: Schema.Literal("sidethread.message.post"),
  commandId: CommandId,
  collaborationUser: Schema.optional(Schema.NullOr(CollaborationUser)),
  threadId: ThreadId,
  sideThreadId: SideThreadId,
  messageId: SideThreadMessageId,
  text: Schema.String.check(Schema.isMaxLength(20_000)),
  mentions: Schema.optional(Schema.Array(SideThreadAuthor)),
  quotedMessageId: Schema.optional(MessageId),
  quotedExcerpt: Schema.optional(SideThreadQuotedExcerpt),
  attachments: Schema.optional(Schema.Array(SideThreadPostAttachment)),
  linkedRef: Schema.optional(SideThreadLinkedRef),
  replyToSideThreadMessageId: Schema.optional(SideThreadMessageId),
  createdAt: IsoDateTime,
});

export const SideThreadMessagePostCommand = ClientSideThreadMessagePostCommand.mapFields(
  Struct.assign({
    attachments: Schema.optional(Schema.Array(SideThreadAttachment)),
  }),
);

export const SideThreadMessageReactCommand = Schema.Struct({
  type: Schema.Literal("sidethread.message.react"),
  commandId: CommandId,
  collaborationUser: Schema.optional(Schema.NullOr(CollaborationUser)),
  threadId: ThreadId,
  sideThreadId: SideThreadId,
  messageId: SideThreadMessageId,
  emoji: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
  createdAt: IsoDateTime,
});

export const SideThreadMessageEditCommand = Schema.Struct({
  type: Schema.Literal("sidethread.message.edit"),
  commandId: CommandId,
  collaborationUser: Schema.optional(Schema.NullOr(CollaborationUser)),
  threadId: ThreadId,
  sideThreadId: SideThreadId,
  messageId: SideThreadMessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  createdAt: IsoDateTime,
});

export const SideThreadMarkReadCommand = Schema.Struct({
  type: Schema.Literal("sidethread.mark-read"),
  commandId: CommandId,
  collaborationUser: Schema.optional(Schema.NullOr(CollaborationUser)),
  threadId: ThreadId,
  sideThreadId: SideThreadId,
  lastReadAt: IsoDateTime,
  createdAt: IsoDateTime,
});

export const SideThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("sidethread.archive"),
  commandId: CommandId,
  collaborationUser: Schema.optional(Schema.NullOr(CollaborationUser)),
  threadId: ThreadId,
  sideThreadId: SideThreadId,
  createdAt: IsoDateTime,
});

export const SideThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  sideThreadId: SideThreadId,
  anchorMessageId: Schema.optional(MessageId),
  createdBy: SideThreadAuthor,
  createdAt: IsoDateTime,
});

export const SideThreadMessagePostedPayload = Schema.Struct({
  threadId: ThreadId,
  sideThreadId: SideThreadId,
  messageId: SideThreadMessageId,
  author: SideThreadAuthor,
  text: Schema.String.check(Schema.isMaxLength(20_000)),
  mentions: Schema.optional(Schema.Array(SideThreadAuthor)),
  quotedMessageId: Schema.optional(MessageId),
  quotedExcerpt: Schema.optional(SideThreadQuotedExcerpt),
  attachments: Schema.optional(Schema.Array(SideThreadAttachment)),
  linkedRef: Schema.optional(SideThreadLinkedRef),
  replyToSideThreadMessageId: Schema.optional(SideThreadMessageId),
  createdAt: IsoDateTime,
});

export const SideThreadMessageReactedPayload = Schema.Struct({
  threadId: ThreadId,
  sideThreadId: SideThreadId,
  messageId: SideThreadMessageId,
  user: SideThreadAuthor,
  emoji: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
  action: Schema.Literals(["added", "removed"]),
  createdAt: IsoDateTime,
});

export const SideThreadMessageEditedPayload = Schema.Struct({
  threadId: ThreadId,
  sideThreadId: SideThreadId,
  messageId: SideThreadMessageId,
  editor: SideThreadAuthor,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  editedAt: IsoDateTime,
});

export const SideThreadMarkedReadPayload = Schema.Struct({
  threadId: ThreadId,
  sideThreadId: SideThreadId,
  user: SideThreadAuthor,
  lastReadAt: IsoDateTime,
  createdAt: IsoDateTime,
});

export const SideThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  sideThreadId: SideThreadId,
  archivedAt: IsoDateTime,
});

export const SideThreadCommand = Schema.Union([
  SideThreadCreateCommand,
  SideThreadMessagePostCommand,
  SideThreadMessageReactCommand,
  SideThreadMessageEditCommand,
  SideThreadMarkReadCommand,
  SideThreadArchiveCommand,
]);
export type SideThreadCommand = typeof SideThreadCommand.Type;

export const SideThreadEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("sidethread.created"), payload: SideThreadCreatedPayload }),
  Schema.Struct({
    type: Schema.Literal("sidethread.message-posted"),
    payload: SideThreadMessagePostedPayload,
  }),
  Schema.Struct({
    type: Schema.Literal("sidethread.message-reacted"),
    payload: SideThreadMessageReactedPayload,
  }),
  Schema.Struct({
    type: Schema.Literal("sidethread.message-edited"),
    payload: SideThreadMessageEditedPayload,
  }),
  Schema.Struct({
    type: Schema.Literal("sidethread.marked-read"),
    payload: SideThreadMarkedReadPayload,
  }),
  Schema.Struct({
    type: Schema.Literal("sidethread.archived"),
    payload: SideThreadArchivedPayload,
  }),
  Schema.Struct({
    type: Schema.Literal("sidethread.imported"),
    payload: Schema.Struct({ threadId: ThreadId, sideThread: SideThread }),
  }),
]);
export type SideThreadEvent = typeof SideThreadEvent.Type;
