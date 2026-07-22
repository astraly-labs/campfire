import * as Schema from "effect/Schema";

import {
  AuthSessionId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const PresenceUser = Schema.Struct({
  subject: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  networkLogin: Schema.optional(TrimmedNonEmptyString),
});
export type PresenceUser = typeof PresenceUser.Type;

export const PresenceEntry = Schema.Struct({
  sessionId: AuthSessionId,
  user: PresenceUser,
  threadId: Schema.NullOr(ThreadId),
  typing: Schema.Boolean,
  lastSeenAt: IsoDateTime,
});
export type PresenceEntry = typeof PresenceEntry.Type;

export const PresenceSnapshot = Schema.Struct({
  revision: NonNegativeInt,
  serverTime: IsoDateTime,
  entries: Schema.Array(PresenceEntry),
});
export type PresenceSnapshot = typeof PresenceSnapshot.Type;

export const PresenceHeartbeatInput = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  typing: Schema.Boolean,
});
export type PresenceHeartbeatInput = typeof PresenceHeartbeatInput.Type;

export const PresenceHeartbeatResult = Schema.Struct({
  revision: NonNegativeInt,
  serverTime: IsoDateTime,
});
export type PresenceHeartbeatResult = typeof PresenceHeartbeatResult.Type;

export const PRESENCE_WS_METHODS = {
  heartbeat: "presence.heartbeat",
  subscribe: "presence.subscribe",
} as const;
