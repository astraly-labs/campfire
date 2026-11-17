import type { ServerLowDiskVolume } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no free-space query.
import * as NodeFSP from "node:fs/promises";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";

const GIB = 1024 ** 3;

/** @public A volume with less free space than this is reported as low. */
export const LOW_DISK_THRESHOLD_BYTES = 20 * GIB;

const SAMPLE_INTERVAL = "60 seconds";
// A hung network mount must not stall every later sample.
const FOLDER_SAMPLE_TIMEOUT = "10 seconds";

/** Free space of one folder the server depends on, as read from its volume. */
export interface VolumeSample<Role extends string = ServerLowDiskVolume["role"]> {
  readonly role: Role;
  readonly path: string;
  /** `stat().dev`, so two folders on one volume are reported once. */
  readonly device: number;
  readonly freeBytes: number;
  readonly totalBytes: number;
}

export class StorageMonitor extends Context.Service<
  StorageMonitor,
  {
    readonly snapshot: Effect.Effect<ReadonlyArray<ServerLowDiskVolume>>;
    /** Emits the current set on subscribe, then each meaningful change. */
    readonly streamChanges: Stream.Stream<ReadonlyArray<ServerLowDiskVolume>>;
  }
>()("t3/storage/StorageMonitor") {}

/** Samples are in priority order: the first folder on a volume names it. */
export function distinctVolumes<Sample extends { readonly device: number }>(
  samples: ReadonlyArray<Sample>,
): ReadonlyArray<Sample> {
  const seenDevices = new Set<number>();
  return samples.filter((sample) => {
    if (seenDevices.has(sample.device)) return false;
    seenDevices.add(sample.device);
    return true;
  });
}

function lowVolumes(samples: ReadonlyArray<VolumeSample>): ReadonlyArray<ServerLowDiskVolume> {
  return distinctVolumes(samples)
    .filter((sample) => sample.freeBytes < LOW_DISK_THRESHOLD_BYTES)
    .map(({ role, path, freeBytes, totalBytes }) => ({ role, path, freeBytes, totalBytes }));
}

/** Clients show whole GiB, so movement inside one is not worth a websocket frame. */
function sameReport(
  left: ReadonlyArray<ServerLowDiskVolume>,
  right: ReadonlyArray<ServerLowDiskVolume>,
): boolean {
  return (
    left.length === right.length &&
    left.every((volume, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        volume.role === other.role &&
        volume.path === other.path &&
        Math.floor(volume.freeBytes / GIB) === Math.floor(other.freeBytes / GIB)
      );
    })
  );
}

const logTransitions = Effect.fn("StorageMonitor.logTransitions")(function* (
  previous: ReadonlyArray<ServerLowDiskVolume>,
  next: ReadonlyArray<ServerLowDiskVolume>,
) {
  for (const volume of next) {
    if (previous.some((old) => old.role === volume.role)) continue;
    yield* Effect.logWarning("storage.low-disk", {
      role: volume.role,
      path: volume.path,
      freeBytes: volume.freeBytes,
    });
  }
  for (const volume of previous) {
    if (next.some((current) => current.role === volume.role)) continue;
    yield* Effect.logInfo("storage.low-disk-recovered", { role: volume.role, path: volume.path });
  }
});

/** @public Tests drive `sample` directly instead of reading real disks. */
export const make = Effect.fn("StorageMonitor.make")(function* (
  sample: Effect.Effect<ReadonlyArray<VolumeSample>>,
) {
  const latest = yield* Ref.make<ReadonlyArray<ServerLowDiskVolume>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<ServerLowDiskVolume>>(),
    PubSub.shutdown,
  );

  // The loop is the only writer, so a plain read-then-write cannot race.
  const tick = Effect.gen(function* () {
    const next = lowVolumes(yield* sample);
    const previous = yield* Ref.get(latest);
    if (sameReport(previous, next)) return;
    yield* Ref.set(latest, next);
    yield* logTransitions(previous, next);
    yield* PubSub.publish(changes, next);
  });

  // Forked so a slow first read never holds up server startup.
  yield* tick.pipe(
    Effect.andThen(Effect.sleep(SAMPLE_INTERVAL)),
    Effect.forever,
    Effect.forkScoped,
  );

  return StorageMonitor.of({
    snapshot: Ref.get(latest),
    streamChanges: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const current = yield* Ref.get(latest);
        return Stream.concat(Stream.make(current), Stream.fromSubscription(subscription));
      }),
    ),
  });
});

/** None when the folder cannot be read in time, such as on an unplugged or frozen drive. */
export const sampleFolder = <Role extends string>({
  role,
  path,
}: Pick<VolumeSample<Role>, "role" | "path">): Effect.Effect<Option.Option<VolumeSample<Role>>> =>
  Effect.tryPromise(async (): Promise<VolumeSample<Role>> => {
    const [stat, statfs] = await Promise.all([
      NodeFSP.stat(path),
      NodeFSP.statfs(path, { bigint: true }),
    ]);
    return {
      role,
      path,
      device: stat.dev,
      freeBytes: Number(statfs.bavail * statfs.bsize),
      totalBytes: Number(statfs.blocks * statfs.bsize),
    };
  }).pipe(
    Effect.timeout(FOLDER_SAMPLE_TIMEOUT),
    Effect.tapError((cause) => Effect.logDebug("storage folder unreadable", { role, path, cause })),
    Effect.option,
  );

/**
 * Reads each folder's volume, in order. A folder that cannot be read, such as
 * one on an unplugged drive, is left out rather than reported.
 */
export const sampleFolders = (
  folders: ReadonlyArray<Pick<VolumeSample, "role" | "path">>,
): Effect.Effect<ReadonlyArray<VolumeSample>> =>
  Effect.forEach(folders, sampleFolder, { concurrency: "unbounded" }).pipe(
    Effect.map((samples) => samples.flatMap((sample) => Option.toArray(sample))),
  );

export const layer = Layer.effect(
  StorageMonitor,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;

    const sample = Effect.gen(function* () {
      // Unreadable settings skip the worktrees folder rather than guess at it.
      const settings = yield* settingsService.getSettings.pipe(Effect.option);
      const worktreesDir = Option.isSome(settings)
        ? resolveWorktreesDirectory(
            settings.value.worktreesDirectory,
            config.worktreesDir,
            path,
            home,
          )
        : null;
      return yield* sampleFolders([
        { role: "state", path: config.stateDir },
        ...(worktreesDir === null ? [] : [{ role: "worktrees" as const, path: worktreesDir }]),
      ]);
    });

    return yield* make(sample);
  }),
);
