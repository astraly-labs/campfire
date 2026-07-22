import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { makeLiveSubscriptionBuffer } from "./liveSubscriptionBuffer.ts";

describe("makeLiveSubscriptionBuffer", () => {
  it.effect("drains accepted items and then fails when a producer exceeds capacity", () =>
    Effect.gen(function* () {
      const overflow = new Error("subscriber fell behind");
      const received: number[] = [];
      const buffer = yield* makeLiveSubscriptionBuffer<number, Error>({
        capacity: 2,
        label: "test",
        onOverflow: () => overflow,
      });

      yield* buffer.offer(1);
      yield* buffer.offer(2);
      yield* buffer.offer(3);

      const failure = yield* buffer.stream.pipe(
        Stream.runForEach((value) => Effect.sync(() => received.push(value))),
        Effect.flip,
      );

      expect(received).toEqual([1, 2]);
      expect(failure).toBe(overflow);
    }),
  );

  it.effect("keeps the stream open while offers remain within capacity", () =>
    Effect.gen(function* () {
      const buffer = yield* makeLiveSubscriptionBuffer<number, Error>({
        capacity: 2,
        label: "test",
        onOverflow: () => new Error("subscriber fell behind"),
      });

      yield* buffer.offer(1);
      yield* buffer.offer(2);

      const values = yield* buffer.stream.pipe(Stream.take(2), Stream.runCollect);
      expect(Array.from(values)).toEqual([1, 2]);
    }),
  );
});
