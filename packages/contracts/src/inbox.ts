/**
 * Inbox — Slack-style aggregate of side-threads where the current user has
 * been @mentioned. Read-only: every item is derived from
 * `projection_side_thread_message_mentions` and lets the UI deep-link into
 * the originating side-thread without scanning every thread.
 *
 * @module contracts/inbox
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SideThreadId, SideThreadMessageId } from "./sidethread.ts";
import { UserRef } from "./user.ts";

/**
 * One side-thread the current user has been mentioned in, with enough
 * metadata to render a row (preview, timestamps, mention count) and deep
 * link back via the parent thread + anchor message.
 */
export const InboxItem = Schema.Struct({
  sideThreadId: SideThreadId,
  parentThreadId: ThreadId,
  anchorMessageId: SideThreadMessageId,
  lastMentionAt: IsoDateTime,
  lastMentionMessageId: SideThreadMessageId,
  lastMentionAuthor: UserRef,
  lastMentionPreview: TrimmedNonEmptyString,
  mentionsCount: NonNegativeInt,
});
export type InboxItem = typeof InboxItem.Type;

/**
 * No userId in the input — the server uses the WebSocket session's resolved
 * identity (`identity.getCurrentUser`) so one peer cannot enumerate
 * another's mentions.
 */
export const InboxListInput = Schema.Struct({});
export type InboxListInput = typeof InboxListInput.Type;

export const InboxListResult = Schema.Struct({
  items: Schema.Array(InboxItem),
});
export type InboxListResult = typeof InboxListResult.Type;

export const InboxSubscribeInput = Schema.Struct({});
export type InboxSubscribeInput = typeof InboxSubscribeInput.Type;

/**
 * Push event delivered when the user gains, loses (e.g. on archive or
 * dismiss) or sees an update to one of their inbox items. The client merges
 * this into its local store without re-issuing a full `inbox.list`
 * round-trip.
 */
export const InboxStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    items: Schema.Array(InboxItem),
  }),
  Schema.Struct({
    kind: Schema.Literal("upserted"),
    item: InboxItem,
  }),
  Schema.Struct({
    kind: Schema.Literal("removed"),
    sideThreadId: SideThreadId,
  }),
]);
export type InboxStreamEvent = typeof InboxStreamEvent.Type;

export const INBOX_WS_METHODS = {
  list: "inbox.list",
  subscribe: "inbox.subscribe",
} as const;
export type InboxWsMethod = (typeof INBOX_WS_METHODS)[keyof typeof INBOX_WS_METHODS];

export const InboxRpcSchemas = {
  list: {
    input: InboxListInput,
    output: InboxListResult,
  },
  subscribe: {
    input: InboxSubscribeInput,
    output: InboxStreamEvent,
  },
} as const;

export class InboxListError extends Schema.TaggedErrorClass<InboxListError>()("InboxListError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}

export class InboxSubscribeError extends Schema.TaggedErrorClass<InboxSubscribeError>()(
  "InboxSubscribeError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
