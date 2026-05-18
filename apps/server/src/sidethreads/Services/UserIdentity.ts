/**
 * UserIdentityService — resolves a Tailscale peer IP to a stable `UserRef`.
 *
 * Backed by `tailscale whois <ip> --json` in production, with a short-lived
 * in-memory cache (TTL ~5 minutes) to avoid hammering the CLI on every
 * incoming WS frame. Side effects: upserts a row in `users` + `user_devices`
 * for first-time pairings.
 *
 * The service also handles the "local fallback" path used when no tailnet
 * identity is available (dev on localhost, non-tailnet IP) and exposes
 * mutations for the user-controlled display-name override stored in the
 * `users.display_name_override` column.
 *
 * The service lives under `sidethreads/` for now because it is the only
 * consumer; extract to a dedicated `identity/` module if other aggregates
 * (orchestration mentions, audit logs) need it later.
 *
 * @module UserIdentityService
 */
import type { IdentitySource, UserId, UserRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { UserIdentityError } from "../Errors.ts";

export interface ResolvedIdentity {
  /**
   * The effective `UserRef` — `displayName` is the override when set,
   * otherwise the canonical name (from Tailscale or the local fallback).
   */
  readonly user: UserRef;
  /**
   * The underlying source name (Tailscale `UserProfile.DisplayName`, or the
   * OS username for the local fallback). Used by the Settings UI to power
   * a "Reset to default" affordance.
   */
  readonly canonicalDisplayName: string;
  readonly source: IdentitySource;
  readonly hasOverride: boolean;
}

export interface UserIdentityShape {
  /**
   * Resolve a peer by their tailnet IPv4 address via `tailscale whois`.
   * Returns the effective `UserRef` (override-aware).
   */
  readonly resolveByTailnetIp: (tailnetIp: string) => Effect.Effect<UserRef, UserIdentityError>;
  /**
   * Resolve the current user from an inbound HTTP request remote address.
   * Falls back to a synthetic `local:<os-user>` identity when the address
   * is missing or non-tailnet (dev on localhost, IPv6 link-local, etc.).
   */
  readonly resolveByRequestIp: (
    ipAddress: string | null | undefined,
  ) => Effect.Effect<ResolvedIdentity, UserIdentityError>;
  /**
   * Resolve identity from Tailscale Serve injected headers (`tailscale-user-login`
   * + `tailscale-user-name`). When TLS is terminated by the local daemon the
   * peer's tailnet IP is no longer visible on the socket (everything looks
   * like `127.0.0.1`), so the daemon ships these headers as the only
   * authoritative way to know who is on the other end. Returns
   * `Option.none` if the headers are absent or empty so the caller can fall
   * back to {@link resolveByRequestIp}.
   */
  readonly resolveFromTailscaleHeaders: (params: {
    readonly login: string | undefined;
    readonly displayName: string | undefined;
  }) => Effect.Effect<Option.Option<ResolvedIdentity>, UserIdentityError>;
  /**
   * Persist a user-chosen display-name override (or clear it when `null`).
   * Returns the refreshed `ResolvedIdentity` so callers can update caches.
   */
  readonly setDisplayNameOverride: (
    userId: UserId,
    override: string | null,
  ) => Effect.Effect<ResolvedIdentity, UserIdentityError>;
}

export class UserIdentityService extends Context.Service<UserIdentityService, UserIdentityShape>()(
  "t3/sidethreads/Services/UserIdentity/UserIdentityService",
) {}
