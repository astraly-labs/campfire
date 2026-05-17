/**
 * UserIdentityService — resolves a Tailscale peer IP to a stable `UserRef`.
 *
 * Backed by `tailscale whois <ip> --json` in production, with a short-lived
 * in-memory cache (TTL ~5 minutes) to avoid hammering the CLI on every
 * incoming WS frame. Side effects: upserts a row in `users` + `user_devices`
 * for first-time pairings.
 *
 * The service lives under `sidethreads/` for now because it is the only
 * consumer; extract to a dedicated `identity/` module if other aggregates
 * (orchestration mentions, audit logs) need it later.
 *
 * @module UserIdentityService
 */
import type { UserRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { UserIdentityError } from "../Errors.ts";

export interface UserIdentityShape {
  readonly resolveByTailnetIp: (tailnetIp: string) => Effect.Effect<UserRef, UserIdentityError>;
}

export class UserIdentityService extends Context.Service<UserIdentityService, UserIdentityShape>()(
  "t3/sidethreads/Services/UserIdentity/UserIdentityService",
) {}
