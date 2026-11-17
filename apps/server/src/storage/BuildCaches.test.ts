import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import * as BuildCaches from "./BuildCaches.ts";

const HOUR_MS = 60 * 60_000;

/** Creates `relative` under `root` with the given files, all last modified `ageMs` ago. */
const makeFolder = Effect.fn(function* (
  root: string,
  relative: string,
  files: ReadonlyArray<string>,
  ageMs: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = path.join(root, relative);
  yield* fs.makeDirectory(folder, { recursive: true });
  for (const file of files) yield* fs.writeFileString(path.join(folder, file), "x");
  // Node reads numeric times as seconds.
  const when = ((yield* Clock.currentTimeMillis) - ageMs) / 1000;
  yield* fs.utimes(folder, when, when);
  return folder;
});

describe("discoverBuildCaches", () => {
  it.live("finds marked Cargo targets in configured folders and managed worktrees only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "build-caches-" });
      const shared = path.join(root, "cargo-targets");
      const worktrees = path.join(root, "worktrees");
      yield* makeFolder(shared, "tagged", ["CACHEDIR.TAG"], 2 * HOUR_MS);
      yield* makeFolder(shared, "rustc", [".rustc_info.json"], 2 * HOUR_MS);
      yield* makeFolder(shared, "plain", ["notes.txt"], 2 * HOUR_MS);
      const outside = yield* makeFolder(root, "outside/target", ["CACHEDIR.TAG"], 2 * HOUR_MS);
      yield* fs.symlink(outside, path.join(shared, "linked"));
      yield* makeFolder(worktrees, "repo/feature/target", ["CACHEDIR.TAG"], 2 * HOUR_MS);
      yield* makeFolder(worktrees, "repo/no-build", [], 2 * HOUR_MS);
      yield* fs.symlink(path.join(root, "outside"), path.join(worktrees, "repo", "linked"));

      const discovery = yield* BuildCaches.discoverBuildCaches({
        folders: [shared],
        worktreeRoots: [worktrees, path.join(root, "missing-old-location")],
      });

      expect(discovery.unreadable).toEqual([]);
      expect(
        discovery.caches.map(({ path: cache, worktreePath }) => ({ cache, worktreePath })),
      ).toEqual([
        { cache: path.join(shared, "rustc"), worktreePath: null },
        { cache: path.join(shared, "tagged"), worktreePath: null },
        {
          cache: path.join(worktrees, "repo", "feature", "target"),
          worktreePath: path.join(worktrees, "repo", "feature"),
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("dates a cache by its newest build output folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "build-caches-" });
      yield* makeFolder(root, "target", ["CACHEDIR.TAG"], 3 * HOUR_MS);
      yield* makeFolder(root, "target/release/deps", [], 10 * 60_000);
      yield* makeFolder(root, "target/release", [], 3 * HOUR_MS);

      const [cache] = (yield* BuildCaches.discoverBuildCaches({
        folders: [root],
        worktreeRoots: [],
      })).caches;
      const now = yield* Clock.currentTimeMillis;

      expect(now - cache!.lastBuildAt).toBeLessThan(BuildCaches.BUILD_IN_USE_WINDOW_MS);
      expect(BuildCaches.buildCacheInUse(cache!, false, now)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a folder that stops answering as unreadable instead of waiting", () =>
    Effect.gen(function* () {
      const fiber = yield* BuildCaches.discoverBuildCaches({
        folders: ["/frozen", "/healthy"],
        worktreeRoots: [],
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");

      expect(yield* Fiber.join(fiber)).toEqual({ caches: [], unreadable: ["/frozen"] });
    }).pipe(
      Effect.provide(
        Layer.merge(
          FileSystem.layerNoop({
            realPath: (path) => Effect.succeed(path),
            readDirectory: (path) => (path === "/frozen" ? Effect.never : Effect.succeed([])),
          }),
          Path.layer,
        ),
      ),
    ),
  );
});

describe("buildCacheInUse", () => {
  const now = 10 * HOUR_MS;

  it("keeps caches built within 30 minutes or owned by a busy worktree", () => {
    expect(BuildCaches.buildCacheInUse({ lastBuildAt: now - 29 * 60_000 }, false, now)).toBe(true);
    expect(BuildCaches.buildCacheInUse({ lastBuildAt: now - HOUR_MS }, true, now)).toBe(true);
    expect(BuildCaches.buildCacheInUse({ lastBuildAt: now - 31 * 60_000 }, false, now)).toBe(false);
  });
});

describe("removeBuildCaches", () => {
  it.live("removes idle caches, keeps busy ones, and never deletes through a link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "build-caches-" });
      const idle = yield* makeFolder(root, "shared/idle", ["CACHEDIR.TAG"], 2 * HOUR_MS);
      const recent = yield* makeFolder(root, "shared/recent", ["CACHEDIR.TAG"], 0);
      const owned = yield* makeFolder(root, "repo/busy/target", ["CACHEDIR.TAG"], 2 * HOUR_MS);
      const keep = yield* makeFolder(root, "elsewhere", ["important.txt"], 0);
      yield* fs.symlink(keep, path.join(idle, "link"));
      const now = yield* Clock.currentTimeMillis;
      const busyWorktree = path.join(root, "repo", "busy");

      const entries = yield* BuildCaches.removeBuildCaches(
        [
          { path: idle, worktreePath: null, lastBuildAt: now - 2 * HOUR_MS, bytes: 1024 },
          { path: recent, worktreePath: null, lastBuildAt: now, bytes: null },
          { path: owned, worktreePath: busyWorktree, lastBuildAt: now - 2 * HOUR_MS, bytes: 7 },
        ],
        (worktreePath) => worktreePath === busyWorktree,
        now,
      );

      expect(entries.map(({ path: cache, outcome }) => [cache, outcome])).toEqual([
        [idle, "removed"],
        [recent, "kept"],
        [owned, "kept"],
      ]);
      expect(yield* fs.exists(idle)).toBe(false);
      expect(yield* fs.exists(recent)).toBe(true);
      expect(yield* fs.exists(owned)).toBe(true);
      expect(yield* fs.exists(path.join(keep, "important.txt"))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a cache that cannot be deleted as failed", () =>
    Effect.gen(function* () {
      const entries = yield* BuildCaches.removeBuildCaches(
        [{ path: "/locked", worktreePath: null, lastBuildAt: 0, bytes: 5 }],
        () => false,
        BuildCaches.BUILD_IN_USE_WINDOW_MS * 2,
      );

      expect(entries).toEqual([
        {
          path: "/locked",
          outcome: "failed",
          reason: expect.stringContaining("Operation not permitted"),
          bytes: null,
        },
      ]);
    }).pipe(
      Effect.provide(
        FileSystem.layerNoop({
          remove: (path) =>
            Effect.fail(
              PlatformError.systemError({
                module: "FileSystem",
                method: "remove",
                _tag: "PermissionDenied",
                description: "Operation not permitted",
                pathOrDescriptor: path,
              }),
            ),
        }),
      ),
    ),
  );
});

describe("makeSizeCache", () => {
  it.effect("keeps measuring after a request gives up and serves the next request", () =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<number>();
      let runs = 0;
      const sizes = yield* BuildCaches.makeSizeCache(() =>
        Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(done))),
      );

      const first = yield* sizes.get("/ssd/cargo-targets/big").pipe(Effect.forkChild);
      yield* TestClock.adjust(BuildCaches.MEASURE_BUDGET);
      expect(yield* Fiber.join(first)).toBeNull();

      yield* Deferred.succeed(done, 42);
      expect(yield* sizes.get("/ssd/cargo-targets/big")).toBe(42);
      expect(runs).toBe(1);
    }).pipe(Effect.scoped),
  );
});
