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

/**
 * Directory of users known to the backend — drives mention autocomplete in
 * side-thread composers. Sourced from the `users` table that
 * `UserIdentityService` upserts on Tailscale pairing.
 */
export const UsersDirectoryInput = Schema.Struct({});
export type UsersDirectoryInput = typeof UsersDirectoryInput.Type;

export const UsersDirectoryResult = Schema.Struct({
  users: Schema.Array(UserRef),
});
export type UsersDirectoryResult = typeof UsersDirectoryResult.Type;

export const USERS_WS_METHODS = {
  directory: "users.directory",
} as const;
export type UsersWsMethod = (typeof USERS_WS_METHODS)[keyof typeof USERS_WS_METHODS];

export class UsersDirectoryError extends Schema.TaggedErrorClass<UsersDirectoryError>()(
  "UsersDirectoryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
