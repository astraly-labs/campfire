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
  ProviderLogRetention,
  type ProviderLogRetentionShape,
} from "../Services/ProviderLogRetention.ts";

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ProviderLogRetentionLiveOptions {
  /** Files whose mtime is strictly older than this are deleted. */
  readonly retentionMs?: number;
  /** Cadence between sweeps. The first sweep runs at start. */
  readonly sweepIntervalMs?: number;
  /**
   * Override the directory to sweep. Defaults to
   * `ServerConfig.providerLogsDir`. Used by tests to point at a temp dir.
   */
  readonly providerLogsDir?: string;
}

const makeProviderLogRetention = (options?: ProviderLogRetentionLiveOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;

    const retentionMs = Math.max(1, options?.retentionMs ?? DEFAULT_RETENTION_MS);
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const providerLogsDir = options?.providerLogsDir ?? serverConfig.providerLogsDir;

    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cutoffMs = now - retentionMs;

      // The dir may not yet exist on a brand-new install; treat that as an
      // empty listing rather than a failure.
      const entries = yield* fileSystem
        .readDirectory(providerLogsDir, { recursive: false })
        .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

      if (entries.length === 0) return;

      let removedCount = 0;
      let bytesFreed = 0;
      let scannedCount = 0;

      yield* Effect.forEach(
        entries,
        (name) =>
          Effect.gen(function* () {
            const filePath = path.join(providerLogsDir, name);
            // Skip if stat fails (e.g. a writer concurrently rotated and
            // unlinked the file between readDirectory and stat).
            const infoOption = yield* fileSystem.stat(filePath).pipe(
              Effect.map(Option.some),
              Effect.catch(() => Effect.succeed(Option.none<FileSystem.File.Info>())),
            );
            if (Option.isNone(infoOption)) return;
            const info = infoOption.value;
            scannedCount += 1;
            if (info.type !== "File") return;

            const mtimeOption = info.mtime;
            // No mtime → conservatively keep the file. Without a sane mtime
            // we cannot decide it is stale.
            if (Option.isNone(mtimeOption)) return;
            const mtimeMs = mtimeOption.value.getTime();
            if (mtimeMs >= cutoffMs) return;

            const sizeNum = Number(info.size);
            yield* fileSystem
              .remove(filePath, { force: true })
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    removedCount += 1;
                    bytesFreed += Number.isFinite(sizeNum) ? sizeNum : 0;
                  }),
                ),
                // A transient FS error (race with adapter rotating the file,
                // permissions) should log + continue, not fail the sweep.
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.log-retention.remove-failed", {
                    file: filePath,
                    cause,
                  }),
                ),
              );
          }),
        { concurrency: 4, discard: true },
      );

      if (removedCount > 0) {
        yield* Effect.logInfo("provider.log-retention.swept", {
          providerLogsDir,
          scannedCount,
          removedCount,
          bytesFreed,
          retentionMs,
          cutoffIso: DateTime.formatIso(DateTime.makeUnsafe(cutoffMs)),
        });
      }
    });

    const start: ProviderLogRetentionShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.log-retention.sweep-failed", { error }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.log-retention.sweep-defect", { defect }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.log-retention.started", {
          providerLogsDir,
          retentionMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderLogRetentionShape;
  });

export const makeProviderLogRetentionLive = (options?: ProviderLogRetentionLiveOptions) =>
  Layer.effect(ProviderLogRetention, makeProviderLogRetention(options));

export const ProviderLogRetentionLive = makeProviderLogRetentionLive();
