import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export interface LiveSubscriptionBuffer<A, E> {
  readonly offer: (item: A) => Effect.Effect<void>;
  readonly takeAll: Effect.Effect<ReadonlyArray<A>, E>;
  readonly stream: Stream.Stream<A, E>;
}

interface LiveSubscriptionBufferOptions<E> {
  readonly capacity: number;
  readonly label: string;
  readonly onOverflow: () => E;
}

/**
 * Isolates a live subscriber from a hot producer without silently dropping
 * domain events. Once the fixed backlog is full, the queue drains everything
 * already accepted and then fails the subscription. Durable clients can resume
 * from their last applied sequence while unrelated subscribers keep running.
 */
export const makeLiveSubscriptionBuffer = Effect.fn("makeLiveSubscriptionBuffer")(function* <A, E>(
  options: LiveSubscriptionBufferOptions<E>,
): Effect.fn.Return<LiveSubscriptionBuffer<A, E>> {
  const capacity = Math.max(1, Math.floor(options.capacity));
  const queue = yield* Queue.dropping<A, E>(capacity);

  const offer = Effect.fn("LiveSubscriptionBuffer.offer")(function* (item: A) {
    if (yield* Queue.offer(queue, item)) {
      return;
    }

    const failed = yield* Queue.fail(queue, options.onOverflow());
    if (failed) {
      yield* Effect.logWarning("Live subscription buffer overflowed; resync required.").pipe(
        Effect.annotateLogs({
          capacity,
          subscription: options.label,
        }),
      );
    }
  });

  return {
    offer,
    takeAll: Queue.takeAll(queue),
    stream: Stream.fromQueue(queue),
  };
});
