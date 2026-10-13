import { AuthSessionId, ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { describe, expect } from "vite-plus/test";

import { Presence, layerTest } from "./Presence.ts";

const aliceSession = AuthSessionId.make("session-alice");
const bobSession = AuthSessionId.make("session-bob");
const carolSession = AuthSessionId.make("session-carol");
const threadA = ThreadId.make("thread-a");

const alice = { subject: "google:alice", displayName: "Alice" } as const;
const bob = { subject: "google:bob", displayName: "Bob" } as const;
const carol = { subject: "google:carol", displayName: "Carol" } as const;

describe("Presence", () => {
  it.effect("bounds sessions and evicts stale typing and presence", () =>
    Effect.gen(function* () {
      const presence = yield* Presence;
      const first = yield* presence.touch({
        connectionId: "connection-alice",
        sessionId: aliceSession,
        user: alice,
        focus: { threadId: threadA, typing: true },
      });
      const unchanged = yield* presence.touch({
        connectionId: "connection-alice",
        sessionId: aliceSession,
        user: alice,
        focus: { threadId: threadA, typing: true },
      });
      yield* presence.touch({
        connectionId: "connection-bob",
        sessionId: bobSession,
        user: bob,
        focus: { threadId: null, typing: false },
      });
      yield* presence.touch({
        connectionId: "connection-carol",
        sessionId: carolSession,
        user: carol,
        focus: { threadId: null, typing: false },
      });

      expect(first.revision).toBe(1);
      expect(unchanged.revision).toBe(1);
      expect((yield* presence.snapshot).entries.map((entry) => entry.user.subject)).toEqual([
        "google:bob",
        "google:carol",
      ]);

      yield* TestClock.adjust("16 millis");
      expect((yield* presence.snapshot).entries).toEqual([]);
    }).pipe(
      Effect.provide(
        layerTest({
          capacity: 2,
          presenceTtlMs: 15,
          typingTtlMs: 5,
          sweepIntervalMs: 1,
        }),
      ),
    ),
  );

  it.effect("expires typing independently and drops disconnected sessions immediately", () =>
    Effect.gen(function* () {
      const presence = yield* Presence;
      yield* presence.touch({
        connectionId: "connection-alice",
        sessionId: aliceSession,
        user: alice,
        focus: { threadId: threadA, typing: true },
      });

      yield* TestClock.adjust("6 millis");
      const afterTypingTtl = yield* presence.snapshot;
      expect(afterTypingTtl.entries[0]?.typing).toBe(false);
      expect(afterTypingTtl.entries[0]?.threadId).toBe(threadA);

      yield* presence.drop("connection-alice");
      expect((yield* presence.snapshot).entries).toEqual([]);
    }).pipe(Effect.provide(layerTest({ presenceTtlMs: 100, typingTtlMs: 5, sweepIntervalMs: 1 }))),
  );

  it.effect("coalesces updates for a stalled subscriber to the newest full snapshot", () =>
    Effect.gen(function* () {
      const presence = yield* Presence;
      const sawInitial = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let itemIndex = 0;
      const collected = yield* presence.snapshots.pipe(
        Stream.take(2),
        Stream.tap(() => {
          itemIndex += 1;
          return itemIndex === 1
            ? Deferred.succeed(sawInitial, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void;
        }),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(sawInitial);

      yield* presence.touch({
        connectionId: "connection-alice",
        sessionId: aliceSession,
        user: alice,
        focus: { threadId: threadA, typing: false },
      });
      yield* presence.touch({
        connectionId: "connection-bob",
        sessionId: bobSession,
        user: bob,
        focus: { threadId: threadA, typing: false },
      });
      yield* presence.touch({
        connectionId: "connection-carol",
        sessionId: carolSession,
        user: carol,
        focus: { threadId: threadA, typing: false },
      });
      yield* Deferred.succeed(release, undefined);

      const snapshots = Array.from(yield* Fiber.join(collected));
      expect(snapshots.map((snapshot) => snapshot.revision)).toEqual([0, 3]);
      expect(snapshots[1]?.entries).toHaveLength(3);
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("keeps a session present until its last websocket disconnects", () =>
    Effect.gen(function* () {
      const presence = yield* Presence;
      yield* presence.touch({
        connectionId: "connection-alice-first",
        sessionId: aliceSession,
        user: alice,
        focus: { threadId: null, typing: false },
      });
      yield* presence.touch({
        connectionId: "connection-alice-second",
        sessionId: aliceSession,
        user: alice,
        focus: { threadId: threadA, typing: true },
      });

      expect((yield* presence.snapshot).entries).toHaveLength(1);
      expect((yield* presence.snapshot).entries[0]?.threadId).toBe(threadA);

      yield* presence.drop("connection-alice-second");
      expect((yield* presence.snapshot).entries).toHaveLength(1);
      expect((yield* presence.snapshot).entries[0]?.threadId).toBeNull();

      yield* presence.drop("connection-alice-first");
      expect((yield* presence.snapshot).entries).toEqual([]);
    }).pipe(Effect.provide(layerTest())),
  );
});
