import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

import { ServerConfig } from "../../config.ts";
import {
  WorktreeArtifactRetention,
  type WorktreeArtifactRetentionShape,
} from "../Services/WorktreeArtifactRetention.ts";

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Directories deleted from each idle worktree. All entries here MUST be
 * conventionally gitignored, regenerable from source + lockfile, and not
 * a place an agent would intentionally persist its own work.
 *
 * Notably excluded:
 *  - `dist/` / `build/` — sometimes regenerable, sometimes the intended
 *    deliverable. Too ambiguous to nuke automatically.
 *  - nested `__pycache__/` — small and dispersed; not worth the recursive
 *    walk. The top-level `.venv/` is the actual heavyweight.
 */
const ARTIFACT_DIRECTORY_NAMES: ReadonlyArray<string> = [
  "target",
  ".venv",
  "venv",
  "node_modules",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
];

export interface WorktreeArtifactRetentionLiveOptions {
  /** Worktrees whose mtime is strictly older than this are eligible. */
  readonly retentionMs?: number;
  /** Cadence between sweeps; the first sweep runs at start. */
  readonly sweepIntervalMs?: number;
  /**
   * Override the directory to sweep. Defaults to `ServerConfig.worktreesDir`.
   * Used by tests to point at a temp dir.
   */
  readonly worktreesDir?: string;
}

const makeWorktreeArtifactRetention = (options?: WorktreeArtifactRetentionLiveOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;

    const retentionMs = Math.max(1, options?.retentionMs ?? DEFAULT_RETENTION_MS);
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const worktreesDir = options?.worktreesDir ?? serverConfig.worktreesDir;

    const isOldDirectory = (info: FileSystem.File.Info, cutoffMs: number): boolean => {
      if (info.type !== "Directory") return false;
      const mtime = info.mtime;
      if (Option.isNone(mtime)) return false;
      return mtime.value.getTime() < cutoffMs;
    };

    const tryRemoveArtifact = (artifactPath: string) =>
      Effect.gen(function* () {
        const infoOption = yield* fileSystem.stat(artifactPath).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none<FileSystem.File.Info>())),
        );
        if (Option.isNone(infoOption)) return 0;
        // Skip symlinks and anything that isn't a regular directory — we
        // don't want to chase a symlink out of the worktree by accident.
        if (infoOption.value.type !== "Directory") return 0;
        const result = yield* fileSystem
          .remove(artifactPath, { recursive: true, force: true })
          .pipe(
            Effect.as(1 as const),
            Effect.catchCause((cause) =>
              Effect.logWarning("worktree.artifact-retention.remove-failed", {
                artifactPath,
                cause,
              }).pipe(Effect.as(0 as const)),
            ),
          );
        return result;
      });

    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cutoffMs = now - retentionMs;

      const projects = yield* fileSystem
        .readDirectory(worktreesDir, { recursive: false })
        .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));
      if (projects.length === 0) return;

      let touchedWorktrees = 0;
      let removedArtifacts = 0;

      for (const projectName of projects) {
        const projectDir = path.join(worktreesDir, projectName);
        const projectInfoOption = yield* fileSystem.stat(projectDir).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none<FileSystem.File.Info>())),
        );
        if (Option.isNone(projectInfoOption)) continue;
        if (projectInfoOption.value.type !== "Directory") continue;

        const worktrees = yield* fileSystem
          .readDirectory(projectDir, { recursive: false })
          .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

        for (const worktreeName of worktrees) {
          const worktreeDir = path.join(projectDir, worktreeName);
          const worktreeInfoOption = yield* fileSystem.stat(worktreeDir).pipe(
            Effect.map(Option.some),
            Effect.catch(() => Effect.succeed(Option.none<FileSystem.File.Info>())),
          );
          if (Option.isNone(worktreeInfoOption)) continue;
          if (!isOldDirectory(worktreeInfoOption.value, cutoffMs)) continue;

          let removedInWorktree = 0;
          for (const artifactName of ARTIFACT_DIRECTORY_NAMES) {
            const artifactPath = path.join(worktreeDir, artifactName);
            removedInWorktree += yield* tryRemoveArtifact(artifactPath);
          }
          if (removedInWorktree > 0) {
            touchedWorktrees += 1;
            removedArtifacts += removedInWorktree;
          }
        }
      }

      if (removedArtifacts > 0) {
        yield* Effect.logInfo("worktree.artifact-retention.swept", {
          worktreesDir,
          touchedWorktrees,
          removedArtifacts,
          retentionMs,
          cutoffIso: DateTime.formatIso(DateTime.makeUnsafe(cutoffMs)),
        });
      }
    });

    const start: WorktreeArtifactRetentionShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("worktree.artifact-retention.sweep-failed", { error }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("worktree.artifact-retention.sweep-defect", { defect }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );
        yield* Effect.logInfo("worktree.artifact-retention.started", {
          worktreesDir,
          retentionMs,
          sweepIntervalMs,
          artifactDirectoryNames: ARTIFACT_DIRECTORY_NAMES,
        });
      });

    return {
      start,
    } satisfies WorktreeArtifactRetentionShape;
  });

export const makeWorktreeArtifactRetentionLive = (options?: WorktreeArtifactRetentionLiveOptions) =>
  Layer.effect(WorktreeArtifactRetention, makeWorktreeArtifactRetention(options));

export const WorktreeArtifactRetentionLive = makeWorktreeArtifactRetentionLive();
