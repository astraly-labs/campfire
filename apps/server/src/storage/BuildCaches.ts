import type {
  ServerBuildCacheClearEntry,
  ServerBuildCacheClearResult,
  ServerSettings,
  ServerSettingsError,
  ServerStorageUsage,
  ServerStorageVolume,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { PlatformError } from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { openProviderSessionCwds, storageCleanupThreadIdle } from "../storageCleanup.ts";
import { managedWorktreesDirectories, resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import { distinctVolumes, sampleFolder } from "./StorageMonitor.ts";

/** A cache whose build outputs changed this recently probably has a build running. */
export const BUILD_IN_USE_WINDOW_MS = 30 * 60_000;
// Every touch of a cache folder is bounded: a frozen drive hangs reads for ~20 s.
const PROBE_TIMEOUT = "5 seconds";
// Measurements outlive the request that started them, so this exceeds the budget.
const MEASURE_TIMEOUT = "10 minutes";
// The usage request answers within this budget; slower sizes come back as unknown.
export const MEASURE_BUDGET = "2 minutes";
const MEASURE_CONCURRENCY = 3;
const SIZE_TTL = "5 minutes";
const REMOVE_TIMEOUT = "15 minutes";
const CACHE_MARKERS = ["CACHEDIR.TAG", ".rustc_info.json"];
const ACTIVITY_DIRS = [
  "",
  "debug",
  "debug/deps",
  "debug/.fingerprint",
  "release",
  "release/deps",
  "release/.fingerprint",
];

export interface BuildCacheRoots {
  /** Folders whose direct children may be Cargo target folders. */
  readonly folders: ReadonlyArray<string>;
  /** Managed worktree folders, laid out as `<root>/<repo>/<worktree>/target`. */
  readonly worktreeRoots: ReadonlyArray<string>;
}

export interface DiscoveredBuildCache {
  readonly path: string;
  /** The managed worktree that owns this `target`, or null for a shared folder's child. */
  readonly worktreePath: string | null;
  readonly lastBuildAt: number;
}

export interface BuildCacheDiscovery {
  readonly caches: ReadonlyArray<DiscoveredBuildCache>;
  /** Roots that hung or could not be listed. Their caches are left out. */
  readonly unreadable: ReadonlyArray<string>;
}

class FolderUnreadable extends Schema.TaggedError<FolderUnreadable>()("FolderUnreadable", {
  path: Schema.String,
}) {}

export function buildCacheInUse(
  cache: Pick<DiscoveredBuildCache, "lastBuildAt">,
  ownerBusy: boolean,
  now: number,
): boolean {
  return ownerBusy || now - cache.lastBuildAt < BUILD_IN_USE_WINDOW_MS;
}

/**
 * Finds Cargo target folders under `roots`. Symbolic links are never followed,
 * so a link inside a root cannot pull an outside folder in. A root that hangs
 * is reported unreadable and abandoned, which keeps one frozen drive from
 * tying up more than one filesystem thread at a time.
 */
export const discoverBuildCaches = Effect.fn("BuildCaches.discover")(function* (
  roots: BuildCacheRoots,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const bounded = <A, E>(target: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: PROBE_TIMEOUT,
        orElse: () => Effect.fail(new FolderUnreadable({ path: target })),
      }),
    );
  // A missing or unreadable entry is not a cache; only a hang abandons the root.
  const optional = <A>(target: string, effect: Effect.Effect<A, PlatformError>) =>
    bounded(target, Effect.option(effect));
  // A root that cannot be read at all is reported, like a hung one.
  const required = <A>(target: string, effect: Effect.Effect<A, PlatformError>) =>
    bounded(target, effect).pipe(
      Effect.catchTags({
        PlatformError: () => Effect.fail(new FolderUnreadable({ path: target })),
      }),
    );

  /** The canonical path of `logical` when it is a real directory directly inside `realParent`. */
  const realDirectory = Effect.fnUntraced(function* (logical: string, realParent: string) {
    const real = yield* optional(logical, fs.realPath(logical));
    if (Option.isNone(real) || real.value !== path.join(realParent, path.basename(logical)))
      return null;
    const stat = yield* optional(logical, fs.stat(logical));
    return Option.isSome(stat) && stat.value.type === "Directory" ? real.value : null;
  });

  const children = Effect.fnUntraced(function* (directory: string) {
    const names = yield* optional(directory, fs.readDirectory(directory));
    return Option.getOrElse(names, () => []).toSorted();
  });

  const asCache = Effect.fnUntraced(function* (
    target: string,
    realParent: string,
    worktreePath: string | null,
  ) {
    if ((yield* realDirectory(target, realParent)) === null) return null;
    let marked = false;
    for (const marker of CACHE_MARKERS) {
      if (
        Option.getOrElse(yield* optional(target, fs.exists(path.join(target, marker))), () => false)
      ) {
        marked = true;
        break;
      }
    }
    if (!marked) return null;
    let lastBuildAt = 0;
    for (const dir of ACTIVITY_DIRS) {
      const stat = yield* optional(target, fs.stat(path.join(target, dir)));
      const modified = Option.flatMap(stat, (info) => info.mtime);
      if (Option.isSome(modified)) lastBuildAt = Math.max(lastBuildAt, modified.value.getTime());
    }
    return { path: target, worktreePath, lastBuildAt } satisfies DiscoveredBuildCache;
  });

  const inFolder = Effect.fnUntraced(function* (root: string) {
    const real = yield* required(root, fs.realPath(root));
    const names = yield* required(root, fs.readDirectory(root));
    const caches: Array<DiscoveredBuildCache> = [];
    for (const name of names.toSorted()) {
      const cache = yield* asCache(path.join(root, name), real, null);
      if (cache !== null) caches.push(cache);
    }
    return caches;
  });

  const inWorktrees = Effect.fnUntraced(function* (root: string) {
    // An old worktree location that no longer exists has nothing to report.
    if (!Option.getOrElse(yield* optional(root, fs.exists(root)), () => false)) return [];
    const real = yield* required(root, fs.realPath(root));
    const caches: Array<DiscoveredBuildCache> = [];
    for (const repo of yield* children(root)) {
      const repoPath = path.join(root, repo);
      const realRepo = yield* realDirectory(repoPath, real);
      if (realRepo === null) continue;
      for (const worktree of yield* children(repoPath)) {
        const worktreePath = path.join(repoPath, worktree);
        const realWorktree = yield* realDirectory(worktreePath, realRepo);
        if (realWorktree === null) continue;
        const cache = yield* asCache(path.join(worktreePath, "target"), realWorktree, worktreePath);
        if (cache !== null) caches.push(cache);
      }
    }
    return caches;
  });

  const results = yield* Effect.forEach(
    [
      ...roots.folders.map((root) => ({ root, scan: inFolder(root) })),
      ...roots.worktreeRoots.map((root) => ({ root, scan: inWorktrees(root) })),
    ],
    ({ root, scan }) =>
      scan.pipe(
        Effect.map((caches) => ({ caches, unreadable: [] as Array<string> })),
        Effect.catchTags({
          FolderUnreadable: () =>
            Effect.succeed({ caches: [] as Array<DiscoveredBuildCache>, unreadable: [root] }),
        }),
      ),
    { concurrency: "unbounded" },
  );
  const seen = new Set<string>();
  return {
    // A worktree folder can also sit inside a configured folder.
    caches: results
      .flatMap((result) => result.caches)
      .filter((cache) => !seen.has(cache.path) && seen.add(cache.path)),
    unreadable: results.flatMap((result) => result.unreadable),
  } satisfies BuildCacheDiscovery;
});

/**
 * Deletes every cache that is not in use. Never throws for one cache: a
 * permission error or a drive that stops answering marks that path failed.
 */
export const removeBuildCaches = Effect.fn("BuildCaches.remove")(function* (
  caches: ReadonlyArray<DiscoveredBuildCache & { readonly bytes: number | null }>,
  ownerBusy: (worktreePath: string) => boolean,
  now: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const entries: Array<ServerBuildCacheClearEntry> = [];
  for (const cache of caches) {
    const busy = cache.worktreePath !== null && ownerBusy(cache.worktreePath);
    if (buildCacheInUse(cache, busy, now)) {
      entries.push({
        path: cache.path,
        outcome: "kept",
        reason: busy ? "Its worktree has a running thread" : "Built in the last 30 minutes",
        bytes: cache.bytes,
      });
      continue;
    }
    // Removing a symbolic link inside the cache deletes the link, not its target.
    const outcome = yield* fs.remove(cache.path, { recursive: true }).pipe(
      Effect.timeoutOrElse({
        duration: REMOVE_TIMEOUT,
        orElse: () => Effect.fail({ message: "The drive stopped responding" }),
      }),
      Effect.as<ServerBuildCacheClearEntry>({
        path: cache.path,
        outcome: "removed",
        reason: "Removed",
        bytes: cache.bytes,
      }),
      Effect.catch((error: { readonly message: string }) =>
        Effect.logWarning("storage cleanup failed for build cache", {
          path: cache.path,
          error: error.message,
        }).pipe(
          Effect.as<ServerBuildCacheClearEntry>({
            path: cache.path,
            outcome: "failed",
            reason: error.message.split(/\r?\n/)[0] ?? error.message,
            bytes: null,
          }),
        ),
      ),
    );
    entries.push(outcome);
  }
  return entries;
});

/**
 * Caches folder sizes for a few minutes. A request that stops waiting leaves
 * the measurement running in `scope`, so the next request reuses its result.
 */
export const makeSizeCache = Effect.fn("BuildCaches.makeSizeCache")(function* (
  measure: (target: string) => Effect.Effect<number | null>,
) {
  const scope = yield* Effect.scope;
  const measuring = yield* Semaphore.make(MEASURE_CONCURRENCY);
  const sizes = yield* Cache.make({
    capacity: 1_000,
    timeToLive: SIZE_TTL,
    lookup: (target: string) => measuring.withPermits(1)(measure(target)),
  });
  return {
    /** The size, or null when it is not known within the budget. */
    get: (target: string) =>
      Cache.get(sizes, target).pipe(
        Effect.forkIn(scope),
        Effect.flatMap(Fiber.join),
        Effect.timeoutOrElse({ duration: MEASURE_BUDGET, orElse: () => Effect.succeed(null) }),
      ),
    /** A finished measurement, without starting one. */
    known: (target: string) => Cache.getSuccess(sizes, target).pipe(Effect.map(Option.getOrNull)),
    invalidate: (target: string) => Cache.invalidate(sizes, target),
  };
});

export class BuildCaches extends Context.Service<
  BuildCaches,
  {
    readonly usage: Effect.Effect<ServerStorageUsage, ServerSettingsError>;
    readonly clear: Effect.Effect<ServerBuildCacheClearResult, ServerSettingsError>;
  }
>()("t3/storage/BuildCaches") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettingsService.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const processes = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const services = Context.make(FileSystem.FileSystem, fs).pipe(Context.add(Path.Path, path));
  const clearing = yield* Semaphore.make(1);

  // `du` runs out of process, so a frozen drive stalls a child, not a server thread.
  const sizes = yield* makeSizeCache((target) =>
    processes
      .run({
        command: "du",
        args: ["-sk", target],
        timeout: MEASURE_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((result) => {
          if (result.timedOut) return null;
          // du still prints the total after unreadable subfolders, exiting 1.
          const kib = /^(\d+)\s/.exec(result.stdout.trim().split("\n").at(-1) ?? "");
          return kib === null ? null : Number(kib[1]) * 1024;
        }),
        Effect.orElseSucceed(() => null),
      ),
  );

  const buildCacheFolders = (settings: ServerSettings) => [
    ...new Set(
      settings.storageCleanup.buildCacheFolders.flatMap((folder) => {
        const expanded = expandHomePath(folder, home);
        return path.isAbsolute(expanded) ? [path.resolve(expanded)] : [];
      }),
    ),
  ];

  const roots = (settings: ServerSettings): BuildCacheRoots => ({
    folders: buildCacheFolders(settings),
    worktreeRoots: managedWorktreesDirectories(settings, config.worktreesDir, path, home),
  });

  /** Unknown activity counts as busy, so a failed read never clears a live worktree's cache. */
  const ownerBusy = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const settings = yield* settingsService.getSettings;
    const snapshot = yield* projections.getShellSnapshot();
    const cwds = (yield* openProviderSessionCwds(sql)).map((cwd) => path.resolve(cwd));
    const busy = new Set(
      snapshot.threads.flatMap((thread) =>
        thread.worktreePath !== null && !storageCleanupThreadIdle(thread, now, settings)
          ? [path.resolve(thread.worktreePath)]
          : [],
      ),
    );
    return (worktreePath: string) =>
      busy.has(worktreePath) ||
      cwds.some((cwd) => cwd === worktreePath || cwd.startsWith(`${worktreePath}${path.sep}`));
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("storage build cache activity unavailable", { cause }).pipe(
        Effect.as((_worktreePath: string) => true),
      ),
    ),
  );

  const usage = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    const cacheRoots = roots(settings);
    const worktreesDir = resolveWorktreesDirectory(
      settings.worktreesDirectory,
      config.worktreesDir,
      path,
      home,
    );
    const folders: Array<Pick<ServerStorageVolume, "role" | "path">> = [
      { role: "state", path: config.stateDir },
      ...(worktreesDir === null ? [] : [{ role: "worktrees" as const, path: worktreesDir }]),
      ...cacheRoots.folders.map((folder) => ({ role: "build-cache" as const, path: folder })),
    ];
    const [samples, discovery, isBusy] = yield* Effect.all(
      [
        Effect.forEach(folders, sampleFolder, { concurrency: "unbounded" }),
        discoverBuildCaches(cacheRoots).pipe(Effect.provideContext(services)),
        ownerBusy,
      ],
      { concurrency: "unbounded" },
    );
    const bytes = yield* Effect.forEach(discovery.caches, (cache) => sizes.get(cache.path), {
      concurrency: "unbounded",
    });
    const now = yield* Clock.currentTimeMillis;
    const buildCaches = discovery.caches
      .map((cache, index) => ({
        path: cache.path,
        bytes: bytes[index] ?? null,
        lastBuildAt: DateTime.formatIso(DateTime.makeUnsafe(cache.lastBuildAt)),
        inUse: buildCacheInUse(
          cache,
          cache.worktreePath !== null && isBusy(cache.worktreePath),
          now,
        ),
      }))
      .toSorted((left, right) => (right.bytes ?? 0) - (left.bytes ?? 0));
    const sampled = samples.flatMap((sample) => Option.toArray(sample));
    return {
      volumes: distinctVolumes(sampled).map(({ role, path, freeBytes, totalBytes }) => ({
        role,
        path,
        freeBytes,
        totalBytes,
      })),
      buildCaches,
      buildCacheBytes: buildCaches.reduce((total, cache) => total + (cache.bytes ?? 0), 0),
      unreadablePaths: [
        ...new Set([
          ...folders.flatMap((folder, index) =>
            Option.isNone(samples[index]!) ? [folder.path] : [],
          ),
          ...discovery.unreadable,
        ]),
      ],
    } satisfies ServerStorageUsage;
  });

  const clear = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    const discovery = yield* discoverBuildCaches(roots(settings)).pipe(
      Effect.provideContext(services),
    );
    const isBusy = yield* ownerBusy;
    // Sizes come from the last measurement; clearing never waits on a fresh `du`.
    const caches = yield* Effect.forEach(discovery.caches, (cache) =>
      sizes.known(cache.path).pipe(Effect.map((bytes) => ({ ...cache, bytes }))),
    );
    const now = yield* Clock.currentTimeMillis;
    const removed = yield* removeBuildCaches(caches, isBusy, now).pipe(
      Effect.provideContext(services),
    );
    for (const entry of removed)
      if (entry.outcome === "removed") yield* sizes.invalidate(entry.path);
    const entries: Array<ServerBuildCacheClearEntry> = [
      ...removed,
      ...discovery.unreadable.map((folder) => ({
        path: folder,
        outcome: "kept" as const,
        reason: "The folder could not be read",
        bytes: null,
      })),
    ];
    return {
      bytesFreed: entries.reduce(
        (total, entry) => total + (entry.outcome === "removed" ? (entry.bytes ?? 0) : 0),
        0,
      ),
      entries,
    } satisfies ServerBuildCacheClearResult;
  }).pipe(clearing.withPermits(1));

  return BuildCaches.of({ usage, clear });
});

export const layer = Layer.effect(BuildCaches, make);
