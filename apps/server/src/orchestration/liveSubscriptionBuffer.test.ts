import { it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { makeLiveSubscriptionBuffer } from "./liveSubscriptionBuffer.ts";
import { orchestrationSubscriptionOverflowsTotal } from "../observability/Metrics.ts";

class TestOverflow extends Data.TaggedError("TestOverflow")<{
  readonly message: string;
}> {}

describe("makeLiveSubscriptionBuffer", () => {
  it.effect("drains accepted items and then fails when a producer exceeds capacity", () =>
    Effect.gen(function* () {
      const overflow = new TestOverflow({ message: "subscriber fell behind" });
      const received: number[] = [];
      const buffer = yield* makeLiveSubscriptionBuffer<number, TestOverflow>({
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
      const buffer = yield* makeLiveSubscriptionBuffer<number, TestOverflow>({
        capacity: 2,
        label: "test",
        onOverflow: () => new TestOverflow({ message: "subscriber fell behind" }),
      });

      yield* buffer.offer(1);
      yield* buffer.offer(2);

      const values = yield* buffer.stream.pipe(Stream.take(2), Stream.runCollect);
      expect(Array.from(values)).toEqual([1, 2]);
    }),
  );

  it.effect("drains an accepted batch before propagating overflow", () =>
    Effect.gen(function* () {
      const overflow = new TestOverflow({ message: "subscriber fell behind" });
      const buffer = yield* makeLiveSubscriptionBuffer<number, TestOverflow>({
        capacity: 2,
        label: "test",
        onOverflow: () => overflow,
      });

      yield* buffer.offer(1);
      yield* buffer.offer(2);
      yield* buffer.offer(3);

      expect(Array.from(yield* buffer.takeAll)).toEqual([1, 2]);
      expect(yield* Effect.flip(buffer.takeAll)).toBe(overflow);
    }),
  );

  it.effect("counts a bounded orchestration subscriber that must resynchronize", () =>
    Effect.gen(function* () {
      const metric = Metric.withAttributes(orchestrationSubscriptionOverflowsTotal, [
        ["stream", "thread"],
      ]);
      const before = yield* Metric.value(metric);
      const buffer = yield* makeLiveSubscriptionBuffer<number, TestOverflow>({
        capacity: 1,
        label: "thread:test",
        metricLabel: "thread",
        onOverflow: () => new TestOverflow({ message: "subscriber fell behind" }),
      });

      yield* buffer.offer(1);
      yield* buffer.offer(2);

      const after = yield* Metric.value(metric);
      expect(after.count - before.count).toBe(1);
    }),
  );
});
