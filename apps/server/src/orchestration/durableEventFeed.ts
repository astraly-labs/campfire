import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

export interface DurableEventFeed<A> {
  readonly notify: (committedSequence: number) => Effect.Effect<void>;
  readonly stream: Stream.Stream<A>;
}

interface DurableEventFeedOptions<A, E> {
  readonly currentSequence: Effect.Effect<number>;
  readonly read: (fromSequenceExclusive: number, limit: number) => Stream.Stream<A, E>;
  readonly sequence: (item: A) => number;
  readonly retryDelay: Duration.Input;
  readonly onReadError: (error: E) => Effect.Effect<void>;
}

/**
 * Turns the durable event store into a hot feed without retaining a copy of
 * every event for every subscriber. The PubSub carries only the latest
 * committed sequence; subscribers replay their exact missing range.
 */
export const makeDurableEventFeed = Effect.fn("makeDurableEventFeed")(function* <A, E>(
  options: DurableEventFeedOptions<A, E>,
): Effect.fn.Return<DurableEventFeed<A>> {
  const wakeUps = yield* PubSub.sliding<number>(1);

  const notify = (committedSequence: number): Effect.Effect<void> =>
    PubSub.publish(wakeUps, committedSequence).pipe(Effect.asVoid);

  const stream = Stream.unwrap(
    Effect.gen(function* () {
      // Capture the cursor before attaching the wake-up subscription, then
      // capture the head after. Events committed in either side of the race
      // are covered by the initial replay or by a queued wake-up (or both).
      const initialCursor = yield* options.currentSequence;
      const subscription = yield* PubSub.subscribe(wakeUps);
      const initialHead = yield* options.currentSequence;
      const cursor = yield* Ref.make(initialCursor);

      const replayThrough = (targetSequence: number): Stream.Stream<A> =>
        Stream.unwrap(
          Ref.get(cursor).pipe(
            Effect.map((fromSequenceExclusive) => {
              const limit = targetSequence - fromSequenceExclusive;
              if (limit <= 0) {
                return Stream.empty;
              }
              return options
                .read(fromSequenceExclusive, limit)
                .pipe(Stream.tap((item) => Ref.set(cursor, options.sequence(item))));
            }),
          ),
        ).pipe(
          Stream.tapError(options.onReadError),
          Stream.retry(Schedule.spaced(options.retryDelay)),
          Stream.orDie,
        );

      const wakeUpStream = Stream.fromEffect(PubSub.take(subscription)).pipe(
        Stream.repeat(Schedule.forever),
      );
      return Stream.concat(Stream.make(initialHead), wakeUpStream).pipe(
        Stream.flatMap(replayThrough),
      );
    }),
  );

  return { notify, stream };
});
