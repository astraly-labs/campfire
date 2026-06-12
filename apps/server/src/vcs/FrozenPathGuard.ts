/**
 * Negative cache for working directories that live on a frozen filesystem.
 *
 * A dataless iCloud Drive folder after sign-out (or a dead network mount)
 * makes every `stat`/`realpath`/`open` block ~10s in an uncancelable
 * `openat$NOCANCEL` syscall. Those calls run on the runtime's small blocking
 * I/O thread pool — the same pool SQLite reads ride on — so a handful of
 * poisoned project roots polled in a loop saturate the pool and starve the
 * whole server (observed: 44s shell snapshots for a 44KB payload).
 *
 * The guard probes a path with a short Effect-level timeout and remembers
 * failures: while a path is marked frozen, callers fail fast without
 * touching the filesystem at all, so the pool drains and stays healthy. One
 * probe per window is allowed through to detect recovery. Note the timeout
 * interrupts the *effect*, not the syscall — the pool thread stays pinned
 * until the kernel gives up — which is exactly why not re-triggering the
 * access for a window matters more than the probe timeout itself.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

export const FROZEN_PATH_PROBE_TIMEOUT_MS = 1_500;
export const FROZEN_PATH_RETRY_AFTER_MS = 5 * 60_000;

interface FrozenPathEntry {
  readonly retryAtMs: number;
}

const frozenPaths = new Map<string, FrozenPathEntry>();

export function resetFrozenPathGuardForTests(): void {
  frozenPaths.clear();
}

/**
 * Probe `path` for accessibility. Resolves `true` when the path answered a
 * `stat` within the probe timeout (existing or cleanly missing), `false`
 * when the path is currently considered frozen (either cached, or the probe
 * just timed out and armed the cache).
 */
export const isPathResponsive = (path: string): Effect.Effect<boolean, never, never> =>
  Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const entry = frozenPaths.get(path);
    if (entry !== undefined) {
      if (nowMs < entry.retryAtMs) {
        return false;
      }
      frozenPaths.delete(path);
    }

    const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
    if (Option.isNone(fs)) {
      // No filesystem in context (tests with stub layers): stay permissive.
      return true;
    }

    const probe = yield* fs.value.stat(path).pipe(
      Effect.timeoutOption(FROZEN_PATH_PROBE_TIMEOUT_MS),
      // A fast error (ENOENT, EACCES) is still "responsive": the path is not
      // frozen, callers should proceed and surface their own domain error.
      Effect.catch(() => Effect.succeedSome(undefined)),
    );

    if (Option.isSome(probe)) {
      return true;
    }

    const tripAtMs = yield* Clock.currentTimeMillis;
    frozenPaths.set(path, { retryAtMs: tripAtMs + FROZEN_PATH_RETRY_AFTER_MS });
    yield* Effect.logWarning("[🩺 VcsBreaker] path marked frozen after stat probe timeout", {
      path,
      probeTimeoutMs: FROZEN_PATH_PROBE_TIMEOUT_MS,
      retryAfterMs: FROZEN_PATH_RETRY_AFTER_MS,
    });
    return false;
  });
