/**
 * Presence — transient "who is looking at what right now" state. Volatile by
 * design: lives entirely in server memory, no persistence, no replay. Two
 * clients of the same `UserId` collapse to the most-recent entry (last
 * heartbeat wins) because we only care about "is this human currently
 * focused on this conversation", not socket-level fan-out.
 *
 * @module contracts/presence
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SideThreadId } from "./sidethread.ts";
import { UserRef } from "./user.ts";

/**
 * Where the user is currently typing, if anywhere. Mirrors the focus
 * structure of the heartbeat input so the renderer can pulse the avatar in
 * the exact spot (parent header / side-thread anchor).
 */
export const PresenceTypingFocus = Schema.Union([Schema.Literal("parent"), Schema.Literal("side")]);
export type PresenceTypingFocus = typeof PresenceTypingFocus.Type;

/**
 * Single user's current focus. `parentThreadId` is the agent thread the user
 * has open. `sideThreadId` is non-null only when the side-thread drawer is
 * the active surface — set independently from the parent so the UI can show
 * "viewing parent + drawer focused on anchor X".
 *
 * `typingIn` is reset to null whenever the server hasn't seen a typing
 * heartbeat in the last few seconds (see PresenceTypingTtlMs on the
 * server side).
 */
export const PresenceEntry = Schema.Struct({
  user: UserRef,
  parentThreadId: Schema.NullOr(ThreadId),
  sideThreadId: Schema.NullOr(SideThreadId),
  typingIn: Schema.NullOr(PresenceTypingFocus),
  lastSeenAt: IsoDateTime,
});
export type PresenceEntry = typeof PresenceEntry.Type;

/**
 * Sent by the client every ~4s while it is alive, and immediately on focus
 * change or typing. `parentThreadId` is null when the user is on a non-
 * thread route (inbox, settings) — they then disappear from per-thread
 * presence but the server keeps the entry around so other clients still
 * know the human is online (useful later for "active in workspace").
 */
export const PresenceHeartbeatInput = Schema.Struct({
  parentThreadId: Schema.NullOr(ThreadId),
  sideThreadId: Schema.NullOr(SideThreadId),
  typingIn: Schema.NullOr(PresenceTypingFocus),
});
export type PresenceHeartbeatInput = typeof PresenceHeartbeatInput.Type;

export const PresenceHeartbeatResult = Schema.Struct({
  /** Server-clock acknowledgement — lets the client detect skew if needed. */
  serverTime: IsoDateTime,
});
export type PresenceHeartbeatResult = typeof PresenceHeartbeatResult.Type;

/**
 * One frame of the presence stream. We emit a full snapshot on every change
 * because the population is tiny (≤ ~5 users) — way cheaper than a delta
 * protocol for the development cost.
 */
export const PresenceSnapshotEvent = Schema.Struct({
  kind: Schema.Literal("snapshot"),
  entries: Schema.Array(PresenceEntry),
});
export type PresenceSnapshotEvent = typeof PresenceSnapshotEvent.Type;

export const PresenceSubscribeInput = Schema.Struct({});
export type PresenceSubscribeInput = typeof PresenceSubscribeInput.Type;

export const PRESENCE_WS_METHODS = {
  heartbeat: "presence.heartbeat",
  subscribe: "presence.subscribe",
} as const;
export type PresenceWsMethod = (typeof PRESENCE_WS_METHODS)[keyof typeof PRESENCE_WS_METHODS];

export const PresenceRpcSchemas = {
  heartbeat: {
    input: PresenceHeartbeatInput,
    output: PresenceHeartbeatResult,
  },
  subscribe: {
    input: PresenceSubscribeInput,
    output: PresenceSnapshotEvent,
  },
} as const;

export class PresenceError extends Schema.TaggedErrorClass<PresenceError>()("PresenceError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}
