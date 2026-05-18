import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { UserRef } from "./user.ts";

/**
 * Source of the currently-resolved identity. `tailscale-whois` means the
 * server matched the inbound peer IP to a tailnet user via
 * `tailscale whois`. `local-fallback` is used when no tailnet identity is
 * available (e.g. dev on localhost) and the server synthesised a stable
 * `local:<os-user>` identity from `os.userInfo()`.
 */
export const IdentitySource = Schema.Literals(["tailscale-whois", "local-fallback"]);
export type IdentitySource = typeof IdentitySource.Type;

/**
 * Snapshot of the current user. `user.displayName` is the effective name
 * (override if set, otherwise canonical). `canonicalDisplayName` is the
 * underlying source name and powers the "Reset to default" UX in Settings.
 */
export const IdentityCurrentUser = Schema.Struct({
  user: UserRef,
  source: IdentitySource,
  canonicalDisplayName: TrimmedNonEmptyString,
  hasOverride: Schema.Boolean,
});
export type IdentityCurrentUser = typeof IdentityCurrentUser.Type;

export const IdentitySetDisplayNameInput = Schema.Struct({
  displayName: TrimmedNonEmptyString,
});
export type IdentitySetDisplayNameInput = typeof IdentitySetDisplayNameInput.Type;

export const IdentityClearDisplayNameInput = Schema.Struct({});
export type IdentityClearDisplayNameInput = typeof IdentityClearDisplayNameInput.Type;

export const IdentityGetCurrentUserInput = Schema.Struct({});
export type IdentityGetCurrentUserInput = typeof IdentityGetCurrentUserInput.Type;

export class IdentityServiceError extends Schema.TaggedErrorClass<IdentityServiceError>()(
  "IdentityServiceError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const IdentityRpcSchemas = {
  getCurrentUser: {
    input: IdentityGetCurrentUserInput,
    output: IdentityCurrentUser,
  },
  setDisplayName: {
    input: IdentitySetDisplayNameInput,
    output: IdentityCurrentUser,
  },
  clearDisplayName: {
    input: IdentityClearDisplayNameInput,
    output: IdentityCurrentUser,
  },
} as const;

export const IDENTITY_WS_METHODS = {
  getCurrentUser: "identity.getCurrentUser",
  setDisplayName: "identity.setDisplayName",
  clearDisplayName: "identity.clearDisplayName",
} as const;
export type IdentityWsMethod = (typeof IDENTITY_WS_METHODS)[keyof typeof IDENTITY_WS_METHODS];
