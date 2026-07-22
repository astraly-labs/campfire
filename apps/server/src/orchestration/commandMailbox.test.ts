import { it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { describe, expect } from "vite-plus/test";

import { makeCommandMailbox } from "./commandMailbox.ts";

class TestMailboxFull extends Data.TaggedError("TestMailboxFull")<{
  readonly message: string;
}> {}

describe("makeCommandMailbox", () => {
  it.effect("preserves FIFO order while a producer waits for capacity", () =>
    Effect.gen(function* () {
      const mailbox = yield* makeCommandMailbox<string, TestMailboxFull>({
        capacity: 1,
        offerTimeout: "1 second",
        onOfferTimeout: () => new TestMailboxFull({ message: "full" }),
      });

      yield* mailbox.offer("first");
      const secondOffer = yield* mailbox.offer("second").pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      expect(yield* mailbox.take).toBe("first");
      yield* Fiber.join(secondOffer);
      expect(yield* mailbox.take).toBe("second");
      expect(yield* mailbox.size).toBe(0);
    }),
  );

  it.effect("fails a timed-out offer without processing it later", () =>
    Effect.gen(function* () {
      const full = new TestMailboxFull({ message: "full" });
      const mailbox = yield* makeCommandMailbox<string, TestMailboxFull>({
        capacity: 1,
        offerTimeout: "1 second",
        onOfferTimeout: () => full,
      });

      yield* mailbox.offer("accepted");
      const rejected = yield* mailbox.offer("rejected").pipe(Effect.flip, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");

      expect(yield* Fiber.join(rejected)).toBe(full);
      expect(yield* mailbox.take).toBe("accepted");
      expect(yield* mailbox.size).toBe(0);
    }),
  );
});
