/**
 * PresenceService — transient "who is looking at what right now" registry.
 *
 * Single in-memory map keyed by `UserId`: each user has at most one focus
 * record (parent thread + optional side-thread + optional typing flag).
 * Multiple devices for the same user collapse to the most recent heartbeat
 * — the UI only cares about the human, not the socket.
 *
 * Broadcast uses a `PubSub` of `PresenceSnapshotEvent`. The snapshot model
 * is intentionally simple (resend full state on any change) because the
 * population is tiny (≤ ~5 collaborators on a tailnet) — a delta protocol
 * would cost more in code than it saves in bandwidth.
 *
 * @module PresenceService
 */
import type {
  PresenceHeartbeatInput,
  PresenceSnapshotEvent,
  UserId,
  UserRef,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface PresenceTouchInput extends PresenceHeartbeatInput {
  readonly user: UserRef;
}

export interface PresenceServiceShape {
  /**
   * Upsert the current user's focus. Resets the auto-eviction TTL. Publishes
   * a fresh snapshot iff the visible state changed (avoids spamming
   * subscribers every 4 s when nothing moved).
   */
  readonly touch: (input: PresenceTouchInput) => Effect.Effect<void>;

  /**
   * Drop the user entirely (socket close, explicit logout). Always publishes
   * a snapshot so other clients reflow the avatar stacks.
   */
  readonly dropUser: (userId: UserId) => Effect.Effect<void>;

  /**
   * Current snapshot — read-only, useful for tests and for handing a fresh
   * snapshot to a new subscriber before they hook into the live stream.
   */
  readonly snapshot: Effect.Effect<PresenceSnapshotEvent>;

  /**
   * Live updates. A subscriber gets nothing until the next state change —
   * callers should pair this with `snapshot` (concat) to receive an initial
   * frame on subscribe.
   */
  readonly stream: Stream.Stream<PresenceSnapshotEvent>;
}

export class PresenceService extends Context.Service<PresenceService, PresenceServiceShape>()(
  "t3/presence/Services/PresenceService",
) {}
