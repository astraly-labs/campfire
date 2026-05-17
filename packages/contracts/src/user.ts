import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Stable handle for a human collaborator across devices. Derived from
 * the Tailscale tailnet identity (e.g. the login name returned by
 * `tailscale whois` on the inbound peer IP). Multiple device pairings
 * can map to the same `UserId`.
 */
export const UserId = TrimmedNonEmptyString.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

export const User = Schema.Struct({
  id: UserId,
  displayName: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type User = typeof User.Type;

/**
 * Reference to a user denormalized into collaborative events. The
 * `displayName` is captured at write time so historical events stay
 * readable if the user later renames themselves.
 */
export const UserRef = Schema.Struct({
  id: UserId,
  displayName: TrimmedNonEmptyString,
});
export type UserRef = typeof UserRef.Type;
