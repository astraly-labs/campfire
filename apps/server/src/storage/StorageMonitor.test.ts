import type { ServerLowDiskVolume } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeOS from "node:os";

import * as StorageMonitor from "./StorageMonitor.ts";

const GIB = 1024 ** 3;
const TOTAL = 500 * GIB;

const folder = (
  role: StorageMonitor.VolumeSample["role"],
  device: number,
  freeBytes: number,
): StorageMonitor.VolumeSample => ({
  role,
  path: role === "state" ? "/data/userdata" : "/ssd/worktrees",
  device,
  freeBytes,
  totalBytes: TOTAL,
});

/** A monitor over samples the test sets, plus every set it publishes after the first. */
const setup = (initial: ReadonlyArray<StorageMonitor.VolumeSample>) =>
  Effect.gen(function* () {
    const samples = yield* Ref.make(initial);
    const monitor = yield* StorageMonitor.make(Ref.get(samples));
    const published = yield* Ref.make<ReadonlyArray<ReadonlyArray<ServerLowDiskVolume>>>([]);
    yield* monitor.streamChanges.pipe(
      Stream.drop(1),
      Stream.runForEach((volumes) => Ref.update(published, (all) => [...all, volumes])),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    const nextPoll = (next: ReadonlyArray<StorageMonitor.VolumeSample>) =>
      Ref.set(samples, next).pipe(Effect.andThen(TestClock.adjust("60 seconds")));
    return { monitor, published, nextPoll };
  });

describe("StorageMonitor", () => {
  it.effect("reports only folders under the threshold", () =>
    Effect.gen(function* () {
      const { monitor } = yield* setup([
        folder("state", 1, 12 * GIB),
        folder("worktrees", 2, StorageMonitor.LOW_DISK_THRESHOLD_BYTES),
      ]);
      expect(yield* monitor.snapshot).toEqual([
        { role: "state", path: "/data/userdata", freeBytes: 12 * GIB, totalBytes: TOTAL },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("reports two folders on one volume once, as state", () =>
    Effect.gen(function* () {
      const { monitor } = yield* setup([folder("state", 7, GIB), folder("worktrees", 7, GIB)]);
      expect((yield* monitor.snapshot).map((volume) => volume.role)).toEqual(["state"]);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves out a folder whose volume cannot be read", () =>
    Effect.gen(function* () {
      const samples = yield* StorageMonitor.sampleFolders([
        { role: "state", path: NodeOS.tmpdir() },
        { role: "worktrees", path: "/t3-storage-monitor-test/unplugged-drive" },
      ]);
      expect(samples.map((sample) => sample.role)).toEqual(["state"]);
      expect(samples[0]?.totalBytes).toBeGreaterThan(0);
    }),
  );

  it.effect("publishes on whole-GiB crossings and recovery, not on every poll", () =>
    Effect.gen(function* () {
      const { published, nextPoll } = yield* setup([folder("state", 1, 12 * GIB + 900)]);

      yield* nextPoll([folder("state", 1, 12 * GIB + 100)]);
      yield* nextPoll([folder("state", 1, 12 * GIB)]);
      expect(yield* Ref.get(published)).toEqual([]);

      yield* nextPoll([folder("state", 1, 12 * GIB - 1)]);
      yield* nextPoll([folder("state", 1, 25 * GIB)]);
      expect(
        (yield* Ref.get(published)).map((volumes) => volumes.map((volume) => volume.freeBytes)),
      ).toEqual([[12 * GIB - 1], []]);
    }).pipe(Effect.scoped),
  );

  it.effect("sends a new subscriber the current set before any change", () =>
    Effect.gen(function* () {
      const { monitor } = yield* setup([folder("state", 1, 5 * GIB)]);
      const head = yield* Stream.runHead(monitor.streamChanges);
      expect(Option.getOrThrow(head).map((volume) => volume.freeBytes)).toEqual([5 * GIB]);
    }).pipe(Effect.scoped),
  );
});
