import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

export interface CommandMailbox<A, E> {
  readonly offer: (item: A) => Effect.Effect<void, E>;
  readonly take: Effect.Effect<A>;
  readonly size: Effect.Effect<number>;
}

interface CommandMailboxOptions<A, E> {
  readonly capacity: number;
  readonly offerTimeout: Duration.Input;
  readonly onOfferTimeout: (item: A) => E;
}

/**
 * A bounded FIFO mailbox whose producers receive an explicit failure when
 * backpressure outlives the configured admission deadline.
 */
export const makeCommandMailbox = Effect.fn("makeCommandMailbox")(function* <A, E>(
  options: CommandMailboxOptions<A, E>,
): Effect.fn.Return<CommandMailbox<A, E>> {
  const queue = yield* Queue.bounded<A>(Math.max(1, Math.floor(options.capacity)));

  const offer = Effect.fn("CommandMailbox.offer")(function* (item: A) {
    const admitted = yield* Queue.offer(queue, item).pipe(
      Effect.timeoutOption(options.offerTimeout),
    );
    if (Option.isNone(admitted)) {
      return yield* Effect.fail(options.onOfferTimeout(item));
    }
  });

  return {
    offer,
    take: Queue.take(queue),
    size: Queue.size(queue),
  };
});
