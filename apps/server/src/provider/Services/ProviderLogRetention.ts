/**
 * ProviderLogRetention - Background sweeper that deletes stale per-thread
 * provider event log files from `providerLogsDir`.
 *
 * Each provider adapter (Claude/Codex/Cursor/OpenCode) opens an
 * `EventNdjsonLogger` per thread that writes to
 * `~/.t3/dev/logs/provider/<threadId>.log` and rotates per-file when the
 * size cap is hit. Rotation bounds the disk per file, but the total disk
 * footprint grows with the number of threads ever served: on a team
 * mac mini after a few weeks of multi-user use we observed ~190 thread
 * subdirectories holding ~3.7 GB of rotated files. This sweeper drops the
 * files whose `mtime` is older than the retention window — analogous to
 * how `ProviderSessionReaper` drops stopped runtime rows on the DB side.
 *
 * @module ProviderLogRetention
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ProviderLogRetentionShape {
  /**
   * Fork a long-running fiber into the provided scope that sweeps stale
   * provider log files on the configured cadence. Resolves immediately;
   * sweeping starts on the first run of the schedule (also at start).
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ProviderLogRetention extends Context.Service<
  ProviderLogRetention,
  ProviderLogRetentionShape
>()("t3/provider/Services/ProviderLogRetention") {}
