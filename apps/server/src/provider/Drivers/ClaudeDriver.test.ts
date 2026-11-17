import { assert, it } from "@effect/vitest";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { makeCapabilitiesProbeCache } from "./ClaudeDriver.ts";

const countingProbe = <A>(results: ReadonlyArray<Effect.Effect<A | undefined, string>>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const probe = Ref.getAndUpdate(calls, (n) => n + 1).pipe(
      Effect.flatMap((index) => results[Math.min(index, results.length - 1)]!),
    );
    return { calls, probe };
  });

it.effect("retries a probe that found no capabilities instead of caching the miss", () =>
  Effect.gen(function* () {
    const { calls, probe } = yield* countingProbe([
      Effect.succeed(undefined),
      Effect.succeed("ok"),
    ]);
    const cache = yield* makeCapabilitiesProbeCache(probe);

    assert.strictEqual(yield* Cache.get(cache, "probe"), undefined);
    assert.strictEqual(yield* Cache.get(cache, "probe"), "ok");
    assert.strictEqual(yield* Ref.get(calls), 2);
  }),
);

it.effect("retries a probe that failed instead of caching the failure", () =>
  Effect.gen(function* () {
    const { calls, probe } = yield* countingProbe([
      Effect.fail("spawn ENOENT"),
      Effect.succeed("ok"),
    ]);
    const cache = yield* makeCapabilitiesProbeCache(probe);

    assert.strictEqual(yield* Effect.flip(Cache.get(cache, "probe")), "spawn ENOENT");
    assert.strictEqual(yield* Cache.get(cache, "probe"), "ok");
    assert.strictEqual(yield* Ref.get(calls), 2);
  }),
);

it.effect("reuses a successful probe until its five-minute TTL expires", () =>
  Effect.gen(function* () {
    const { calls, probe } = yield* countingProbe([Effect.succeed("ok")]);
    const cache = yield* makeCapabilitiesProbeCache(probe);

    yield* Cache.get(cache, "probe");
    yield* TestClock.adjust("4 minutes");
    yield* Cache.get(cache, "probe");
    assert.strictEqual(yield* Ref.get(calls), 1);

    yield* TestClock.adjust("2 minutes");
    yield* Cache.get(cache, "probe");
    assert.strictEqual(yield* Ref.get(calls), 2);
  }),
);
