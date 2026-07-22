import { it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { makeDurableEventFeed } from "./durableEventFeed.ts";

interface TestEvent {
  readonly sequence: number;
}

class TestReadError extends Data.TaggedError("TestReadError")<{
  readonly message: string;
}> {}

describe("makeDurableEventFeed", () => {
  it.effect("coalesces wake-ups while fast and blocked subscribers both remain lossless", () =>
    Effect.gen(function* () {
      const persisted = yield* Ref.make<ReadonlyArray<TestEvent>>([]);
      const latestSequence = yield* Ref.make(0);
      const firstSlowEvent = yield* Deferred.make<void>();
      const releaseSlowSubscriber = yield* Deferred.make<void>();
      const slowReceived: number[] = [];
      const fastReceived: number[] = [];
      const feed = yield* makeDurableEventFeed<TestEvent, TestReadError>({
        currentSequence: Ref.get(latestSequence),
        read: (fromSequenceExclusive, limit) =>
          Stream.unwrap(
            Ref.get(persisted).pipe(
              Effect.map((events) =>
                Stream.fromIterable(
                  events.filter((event) => event.sequence > fromSequenceExclusive).slice(0, limit),
                ),
              ),
            ),
          ),
        sequence: (event) => event.sequence,
        retryDelay: 0,
        onReadError: () => Effect.void,
      });

      const slowFiber = yield* feed.stream.pipe(
        Stream.take(5),
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            slowReceived.push(event.sequence);
            if (event.sequence === 1) {
              yield* Deferred.succeed(firstSlowEvent, undefined);
              yield* Deferred.await(releaseSlowSubscriber);
            }
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      const fastFiber = yield* feed.stream.pipe(
        Stream.take(5),
        Stream.runForEach((event) => Effect.sync(() => fastReceived.push(event.sequence))),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;

      for (let sequence = 1; sequence <= 5; sequence += 1) {
        yield* Ref.update(persisted, (events) => [...events, { sequence }]);
        yield* Ref.set(latestSequence, sequence);
        yield* feed.notify(sequence);
        if (sequence === 1) {
          yield* Deferred.await(firstSlowEvent);
        }
      }

      yield* Fiber.join(fastFiber);
      yield* Deferred.succeed(releaseSlowSubscriber, undefined);
      yield* Fiber.join(slowFiber);

      expect(fastReceived).toEqual([1, 2, 3, 4, 5]);
      expect(slowReceived).toEqual([1, 2, 3, 4, 5]);
    }),
  );

  it.effect("retries a failed durable read from the last emitted sequence", () =>
    Effect.gen(function* () {
      const persisted = yield* Ref.make<ReadonlyArray<TestEvent>>([]);
      const latestSequence = yield* Ref.make(0);
      const attempts = yield* Ref.make(0);
      const readErrors = yield* Ref.make(0);
      const feed = yield* makeDurableEventFeed<TestEvent, TestReadError>({
        currentSequence: Ref.get(latestSequence),
        read: (fromSequenceExclusive, limit): Stream.Stream<TestEvent, TestReadError> =>
          Stream.unwrap(
            Effect.gen(function* () {
              const attempt = yield* Ref.getAndUpdate(attempts, (count) => count + 1);
              if (attempt === 0) {
                const prefix: Stream.Stream<TestEvent> = Stream.make({ sequence: 1 });
                return Stream.concat(
                  prefix,
                  Stream.fail(new TestReadError({ message: "temporary read failure" })),
                );
              }
              const events = yield* Ref.get(persisted);
              return Stream.fromIterable(
                events.filter((event) => event.sequence > fromSequenceExclusive).slice(0, limit),
              );
            }),
          ),
        sequence: (event) => event.sequence,
        retryDelay: 0,
        onReadError: () => Ref.update(readErrors, (count) => count + 1),
      });

      const receivedFiber = yield* feed.stream.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* Ref.set(persisted, [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }]);
      yield* Ref.set(latestSequence, 3);
      yield* feed.notify(3);

      const received = Array.from(yield* Fiber.join(receivedFiber));
      expect(received.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(yield* Ref.get(readErrors)).toBe(1);
    }),
  );
});
