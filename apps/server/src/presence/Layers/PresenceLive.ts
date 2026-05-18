/**
 * PresenceLive — in-memory implementation of {@link PresenceService}.
 *
 * State machine per user:
 *   touch(...)             → upsert entry, bump `lastSeenAt`, maybe publish
 *   dropUser(userId)       → remove entry, publish
 *   tick (every TICK_MS)   → for each entry:
 *                              · if `now - typingSince > TYPING_TTL_MS` → clear typingIn
 *                              · if `now - lastSeenAt > PRESENCE_TTL_MS` → remove entry
 *                            publish a fresh snapshot iff something changed.
 *
 * "Publish iff changed" matters because the client sends heartbeats every
 * ~4 s as a keepalive: 95 % of them carry no new info, so re-broadcasting
 * each one would generate ~1 frame/sec of noise per subscriber per peer.
 *
 * @module PresenceLive
 */
import type {
  PresenceEntry as PresenceEntryContract,
  PresenceSnapshotEvent,
  PresenceTypingFocus,
  SideThreadId,
  ThreadId,
  UserId,
  UserRef,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { PresenceService, type PresenceServiceShape } from "../Services/PresenceService.ts";

interface InternalEntry {
  readonly user: UserRef;
  readonly parentThreadId: ThreadId | null;
  readonly sideThreadId: SideThreadId | null;
  readonly typingIn: PresenceTypingFocus | null;
  /** ms epoch — wall clock, only used relative to itself. */
  readonly lastSeenAt: number;
  /** ms epoch when the user started typing (or last bumped the typing). */
  readonly typingSince: number | null;
}

/** Drop entries whose owner hasn't heartbeat for this long. */
const PRESENCE_TTL_MS = 12_000;
/** Drop the typing flag — but keep the entry — if not refreshed within this. */
const TYPING_TTL_MS = 3_500;
/** Eviction sweep period. Cheap (Map iteration over ≤ ~5 entries). */
const TICK_MS = 2_000;

/** True when the data that would be exposed to subscribers differs. */
function entryView(
  entry: InternalEntry,
  now: number,
): {
  user: UserRef;
  parentThreadId: ThreadId | null;
  sideThreadId: SideThreadId | null;
  typingIn: PresenceTypingFocus | null;
  lastSeenAt: number;
} {
  const typingExpired = entry.typingSince === null || now - entry.typingSince > TYPING_TTL_MS;
  return {
    user: entry.user,
    parentThreadId: entry.parentThreadId,
    sideThreadId: entry.sideThreadId,
    typingIn: typingExpired ? null : entry.typingIn,
    lastSeenAt: entry.lastSeenAt,
  };
}

/** What two snapshots need to look like to count as "different". */
function viewsDiffer(a: ReturnType<typeof entryView>, b: ReturnType<typeof entryView>): boolean {
  return (
    a.parentThreadId !== b.parentThreadId ||
    a.sideThreadId !== b.sideThreadId ||
    a.typingIn !== b.typingIn ||
    a.user.id !== b.user.id ||
    a.user.displayName !== b.user.displayName
  );
}

function projectSnapshot(
  entries: ReadonlyMap<UserId, InternalEntry>,
  now: number,
): PresenceSnapshotEvent {
  const out: PresenceEntryContract[] = [];
  for (const e of entries.values()) {
    const v = entryView(e, now);
    out.push({
      user: v.user,
      parentThreadId: v.parentThreadId,
      sideThreadId: v.sideThreadId,
      typingIn: v.typingIn,
      lastSeenAt: DateTime.formatIso(DateTime.makeUnsafe(v.lastSeenAt)),
    });
  }
  return { kind: "snapshot", entries: out };
}

const makePresence = Effect.gen(function* () {
  const state = yield* Ref.make<Map<UserId, InternalEntry>>(new Map());
  const pubsub = yield* PubSub.unbounded<PresenceSnapshotEvent>();

  const publishSnapshot = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const map = yield* Ref.get(state);
    const event = projectSnapshot(map, now);
    yield* PubSub.publish(pubsub, event);
  });

  const touch: PresenceServiceShape["touch"] = (input) =>
    Effect.gen(function* () {
      const userId = input.user.id;
      const now = yield* Clock.currentTimeMillis;
      let changed = false;
      yield* Ref.update(state, (prev) => {
        const next = new Map(prev);
        const previousEntry = next.get(userId);
        // Carry forward the previous `typingSince` when the user is still
        // typing in the same surface, so the TTL is anchored to the FIRST
        // typing heartbeat rather than the latest — feels more natural
        // (3.5 s after the user actually stopped typing, not 3.5 s after
        // any random keystroke).
        const typingSince =
          input.typingIn === null
            ? null
            : previousEntry?.typingIn === input.typingIn && previousEntry.typingSince !== null
              ? previousEntry.typingSince
              : now;
        const nextEntry: InternalEntry = {
          user: input.user,
          parentThreadId: input.parentThreadId,
          sideThreadId: input.sideThreadId,
          typingIn: input.typingIn,
          lastSeenAt: now,
          typingSince,
        };
        next.set(userId, nextEntry);
        if (!previousEntry) {
          changed = true;
        } else {
          const prevView = entryView(previousEntry, now);
          const nextView = entryView(nextEntry, now);
          if (viewsDiffer(prevView, nextView)) {
            changed = true;
          }
        }
        return next;
      });
      if (changed) {
        yield* publishSnapshot;
      }
    });

  const dropUser: PresenceServiceShape["dropUser"] = (userId) =>
    Effect.gen(function* () {
      let removed = false;
      yield* Ref.update(state, (prev) => {
        if (!prev.has(userId)) return prev;
        const next = new Map(prev);
        next.delete(userId);
        removed = true;
        return next;
      });
      if (removed) {
        yield* publishSnapshot;
      }
    });

  const sweep = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    let mutated = false;
    yield* Ref.update(state, (prev) => {
      let next: Map<UserId, InternalEntry> | null = null;
      for (const [userId, entry] of prev) {
        const presenceExpired = now - entry.lastSeenAt > PRESENCE_TTL_MS;
        const typingExpired =
          entry.typingIn !== null &&
          (entry.typingSince === null || now - entry.typingSince > TYPING_TTL_MS);
        if (presenceExpired) {
          if (!next) next = new Map(prev);
          next.delete(userId);
          mutated = true;
          continue;
        }
        if (typingExpired) {
          if (!next) next = new Map(prev);
          next.set(userId, { ...entry, typingIn: null, typingSince: null });
          mutated = true;
        }
      }
      return next ?? prev;
    });
    if (mutated) {
      yield* publishSnapshot;
    }
  });

  yield* Effect.forkScoped(
    sweep.pipe(
      Effect.catchDefect((defect: unknown) =>
        Effect.logWarning("[👀 Presence] sweep defect", { defect }),
      ),
      Effect.repeat(Schedule.spaced(Duration.millis(TICK_MS))),
    ),
  );

  const snapshot: PresenceServiceShape["snapshot"] = Effect.gen(function* () {
    const map = yield* Ref.get(state);
    const now = yield* Clock.currentTimeMillis;
    return projectSnapshot(map, now);
  });

  const stream: PresenceServiceShape["stream"] = Stream.fromPubSub(pubsub);

  return {
    touch,
    dropUser,
    snapshot,
    stream,
  } satisfies PresenceServiceShape;
});

export const PresenceLive = Layer.effect(PresenceService, makePresence);

// Exposed for unit tests — pure projection function.
export const __testProjectSnapshot = projectSnapshot;
export const __testEntryView = entryView;
export const __testTTLs = {
  PRESENCE_TTL_MS,
  TYPING_TTL_MS,
  TICK_MS,
};
