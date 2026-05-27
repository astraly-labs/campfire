/**
 * Inbox — Slack-style aggregate of side-threads that need the current user's
 * attention. Read-only: every item is derived server-side and lets the UI
 * deep-link into the originating side-thread without scanning every thread.
 *
 * Two kinds of items share one shape (discriminated by `kind`):
 *  - `"mention"` — the user was @mentioned in a side-thread message. Derived
 *    from `projection_side_thread_message_mentions`. Dismissable.
 *  - `"activity"` — a new message landed in a side-thread the user
 *    participates in (i.e. has posted in), authored by someone else. Derived
 *    from `projection_side_thread_participants` + the latest non-self message.
 *    Not dismissable; clears by visiting the thread.
 *
 * @module contracts/inbox
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SideThreadId, SideThreadMessageId } from "./sidethread.ts";
import { UserRef } from "./user.ts";

/**
 * Discriminates the two reasons a side-thread surfaces in the inbox. The web
 * client renders each kind in its own section ("Mentions" vs "Activité").
 */
export const InboxItemKind = Schema.Literals(["mention", "activity"]);
export type InboxItemKind = typeof InboxItemKind.Type;

/**
 * One side-thread the current user needs to look at, with enough metadata to
 * render a row (preview, timestamps, count) and deep link back into the
 * parent conversation.
 *
 * Field names are kind-neutral: for a `"mention"` row they describe the
 * latest mention; for an `"activity"` row they describe the latest message by
 * another participant. `quotedMessageId` is the optional parent-thread message
 * the side-thread message was quoting (mention rows only) — used to scroll to
 * the right spot when the user opens the row; always `null` for activity rows.
 */
export const InboxItem = Schema.Struct({
  kind: InboxItemKind,
  sideThreadId: SideThreadId,
  /**
   * `null` for the workspace-wide global chat — that side-thread has no
   * parent agent thread. Clients should route such rows to `/global` instead
   * of the standard parent-thread deep link.
   */
  parentThreadId: Schema.NullOr(ThreadId),
  quotedMessageId: Schema.NullOr(MessageId),
  /** Timestamp of the latest mention (mention rows) or message (activity rows). */
  lastActivityAt: IsoDateTime,
  lastMessageId: SideThreadMessageId,
  lastAuthor: UserRef,
  lastPreview: TrimmedNonEmptyString,
  /**
   * Mention rows: number of visible (post-dismiss) mentions in the thread.
   * Activity rows: number of messages by other participants in the thread.
   */
  count: NonNegativeInt,
});
export type InboxItem = typeof InboxItem.Type;

/**
 * No userId in the input — the server uses the WebSocket session's resolved
 * identity (`identity.getCurrentUser`) so one peer cannot enumerate
 * another's inbox.
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
 * round-trip. `removed` carries `itemKind` because a side-thread can hold both
 * a mention row and an activity row at once — dismissing the mention must not
 * drop the activity row (and vice versa).
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
    itemKind: InboxItemKind,
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
