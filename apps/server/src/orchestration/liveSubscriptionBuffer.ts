import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  orchestrationSubscriptionBufferHighWaterMark,
  orchestrationSubscriptionCatchUpDuration,
  orchestrationSubscriptionOverflowsTotal,
} from "../observability/Metrics.ts";

export interface LiveSubscriptionBuffer<A, E> {
  readonly offer: (item: A) => Effect.Effect<void>;
  readonly markSynchronized: Effect.Effect<void>;
  readonly takeAll: Effect.Effect<ReadonlyArray<A>, E>;
  readonly stream: Stream.Stream<A, E>;
}

interface LiveSubscriptionBufferOptions<E> {
  readonly capacity: number;
  readonly label: string;
  readonly metricLabel?: "shell" | "thread";
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
  const startedAtMillis = yield* Clock.currentTimeMillis;
  const highWaterMark = yield* Ref.make(0);
  const synchronizing = yield* Ref.make(true);

  const recordCatchUp = Effect.fn("LiveSubscriptionBuffer.recordCatchUp")(function* (
    bufferedEvents: number,
  ) {
    const observedHighWaterMark = yield* Ref.modify(highWaterMark, (current) => {
      const next = Math.max(current, bufferedEvents);
      return [next, next];
    });
    const catchUpMillis = Math.max(0, (yield* Clock.currentTimeMillis) - startedAtMillis);
    if (options.metricLabel !== undefined) {
      const attributes: ReadonlyArray<[string, string]> = [["stream", options.metricLabel]];
      yield* Metric.update(
        Metric.withAttributes(orchestrationSubscriptionBufferHighWaterMark, attributes),
        observedHighWaterMark,
      );
      yield* Metric.update(
        Metric.withAttributes(orchestrationSubscriptionCatchUpDuration, attributes),
        Duration.millis(catchUpMillis),
      );
    }
    return { catchUpMillis, highWaterMark: observedHighWaterMark } as const;
  });

  const offer = Effect.fn("LiveSubscriptionBuffer.offer")(function* (item: A) {
    if (yield* Queue.offer(queue, item)) {
      if (yield* Ref.get(synchronizing)) {
        const bufferedEvents = yield* Queue.size(queue);
        yield* Ref.update(highWaterMark, (current) => Math.max(current, bufferedEvents));
      }
      return;
    }

    const bufferedEvents = yield* Queue.size(queue);
    const diagnostics = yield* recordCatchUp(bufferedEvents);
    const failed = yield* Queue.fail(queue, options.onOverflow());
    if (failed) {
      if (options.metricLabel !== undefined) {
        yield* Metric.update(
          Metric.withAttributes(orchestrationSubscriptionOverflowsTotal, [
            ["stream", options.metricLabel],
          ]),
          1,
        );
      }
      yield* Effect.logWarning("Live subscription buffer overflowed; resync required.").pipe(
        Effect.annotateLogs({
          bufferedEvents,
          catchUpMillis: diagnostics.catchUpMillis,
          capacity,
          highWaterMark: diagnostics.highWaterMark,
          subscription: options.label,
        }),
      );
    }
  });

  const markSynchronized = Effect.gen(function* () {
    if (!(yield* Ref.getAndSet(synchronizing, false))) {
      return;
    }
    const bufferedEvents = yield* Queue.size(queue);
    const diagnostics = yield* recordCatchUp(bufferedEvents);
    if (diagnostics.catchUpMillis >= 1_000 || diagnostics.highWaterMark >= capacity / 4) {
      yield* Effect.logInfo("Live subscription catch-up completed.").pipe(
        Effect.annotateLogs({
          bufferedEvents,
          catchUpMillis: diagnostics.catchUpMillis,
          capacity,
          highWaterMark: diagnostics.highWaterMark,
          subscription: options.label,
        }),
      );
    }
  });

  return {
    offer,
    markSynchronized,
    takeAll: Queue.takeAll(queue),
    stream: Stream.fromQueue(queue),
  };
});
