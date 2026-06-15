import type { RepositoryIdentity } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@t3tools/shared/git";

import * as ProcessRunner from "../../processRunner.ts";
import {
  RepositoryIdentityResolver,
  type RepositoryIdentityResolverShape,
} from "../Services/RepositoryIdentityResolver.ts";
import { isPathResponsive } from "../../vcs/FrozenPathGuard.ts";

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  for (const preferredRemoteName of ["upstream", "origin"] as const) {
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] =
    [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly rootPath: string;
}): RepositoryIdentity {
  const canonicalKey = normalizeGitRemoteUrl(input.remoteUrl);
  const sourceControlProvider = detectSourceControlProviderFromGitRemoteUrl(input.remoteUrl);
  const repositoryPath = canonicalKey.split("/").slice(1).join("/");
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
  };
}

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(1);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);
/**
 * Per-call ceiling on the two git probes. A git *worktree* of a repo whose
 * main checkout is on a frozen filesystem (signed-out iCloud Drive) stats
 * fine on its own dir — so {@link isPathResponsive} can't catch it — but
 * `git -C <worktree> rev-parse` then hangs reading the worktree's `.git`
 * pointer back into the dead main repo. This deadline interrupts that hang
 * (the interruption closes the process scope and kills the lingering git),
 * and a timeout trips the slow-cwd breaker below so subsequent snapshots
 * skip the probe entirely.
 *
 * Kept comfortably below the snapshot-level aggregate deadline (~2s) so a
 * frozen probe trips THIS breaker before the outer deadline interrupts it —
 * otherwise the breaker never arms and every snapshot pays the full
 * aggregate cost. A healthy `git rev-parse` + `remote -v` is single-digit
 * milliseconds, so 1s leaves enormous headroom for legitimately slow disks.
 */
const DEFAULT_PROBE_TIMEOUT = Duration.seconds(1);
const DEFAULT_SLOW_CWD_RETRY_AFTER = Duration.minutes(5);

interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
  readonly probeTimeout?: Duration.Input;
  readonly slowCwdRetryAfter?: Duration.Input;
}

const resolveRepositoryIdentityCacheKey = Effect.fn("resolveRepositoryIdentityCacheKey")(function* (
  cwd: string,
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  let cacheKey = cwd;

  const topLevelResult = yield* processRunner
    .run({
      command: "git",
      args: ["-C", cwd, "rev-parse", "--show-toplevel"],
      timeoutBehavior: "timedOutResult",
      shell: process.platform === "win32",
    })
    .pipe(Effect.option);
  if (topLevelResult._tag === "None" || topLevelResult.value.code !== 0) {
    return cacheKey;
  }

  const candidate = topLevelResult.value.stdout.trim();
  if (candidate.length > 0) {
    cacheKey = candidate;
  }

  return cacheKey;
});

const resolveRepositoryIdentityFromCacheKey = Effect.fn("resolveRepositoryIdentityFromCacheKey")(
  function* (
    cacheKey: string,
  ): Effect.fn.Return<RepositoryIdentity | null, never, ProcessRunner.ProcessRunner> {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const remoteResult = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cacheKey, "remote", "-v"],
        timeoutBehavior: "timedOutResult",
        shell: process.platform === "win32",
      })
      .pipe(Effect.option);
    if (remoteResult._tag === "None" || remoteResult.value.code !== 0) {
      return null;
    }

    const remote = pickPrimaryRemote(parseRemoteFetchUrls(remoteResult.value.stdout));
    return remote ? buildRepositoryIdentity({ ...remote, rootPath: cacheKey }) : null;
  },
);

export const makeRepositoryIdentityResolver = Effect.fn("makeRepositoryIdentityResolver")(
  function* (options: RepositoryIdentityResolverOptions = {}) {
    const processRunner = yield* ProcessRunner.ProcessRunner;

    const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
      (cacheKey) =>
        resolveRepositoryIdentityFromCacheKey(cacheKey).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        ),
      {
        capacity: options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY,
        timeToLive: Exit.match({
          onSuccess: (value) =>
            value === null
              ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
              : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
          onFailure: () => Duration.zero,
        }),
      },
    );

    const probeTimeout = Duration.fromInputUnsafe(options.probeTimeout ?? DEFAULT_PROBE_TIMEOUT);
    const slowCwdRetryAfter = Duration.toMillis(
      Duration.fromInputUnsafe(options.slowCwdRetryAfter ?? DEFAULT_SLOW_CWD_RETRY_AFTER),
    );
    // Breaker for cwds whose git probes time out (frozen worktrees). Keyed on
    // the original cwd, not the resolved toplevel, because the toplevel probe
    // is itself what hangs.
    const slowCwdRetryAtMs = new Map<string, number>();

    const resolve: RepositoryIdentityResolverShape["resolve"] = Effect.fn(
      "RepositoryIdentityResolver.resolve",
    )(function* (cwd) {
      // This resolver spawns two git commands against the workspace root
      // and is called for EVERY project on EVERY shell snapshot. On a
      // frozen filesystem (signed-out iCloud Drive, dead mount) each git
      // call eats a full subprocess timeout, which multiplied across
      // poisoned projects held shell snapshots for 40+ seconds — the
      // sidebar rendered "No projects yet" meanwhile. Skip straight to
      // "identity unknown" while the root is marked frozen.
      if (!(yield* isPathResponsive(cwd))) {
        return null;
      }

      const nowMs = yield* Clock.currentTimeMillis;
      const retryAtMs = slowCwdRetryAtMs.get(cwd);
      if (retryAtMs !== undefined) {
        if (nowMs < retryAtMs) {
          return null;
        }
        slowCwdRetryAtMs.delete(cwd);
      }

      const resolved = yield* Effect.gen(function* () {
        const cacheKey = yield* resolveRepositoryIdentityCacheKey(cwd).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        );
        return yield* Cache.get(repositoryIdentityCache, cacheKey);
      }).pipe(Effect.timeoutOption(probeTimeout));

      if (Option.isNone(resolved)) {
        const trippedAtMs = yield* Clock.currentTimeMillis;
        slowCwdRetryAtMs.set(cwd, trippedAtMs + slowCwdRetryAfter);
        yield* Effect.logWarning("[🩺 VcsBreaker] repository-identity probe timed out", {
          cwd,
          probeTimeoutMs: Duration.toMillis(probeTimeout),
          retryAfterMs: slowCwdRetryAfter,
        });
        return null;
      }

      return resolved.value;
    });

    return {
      resolve,
    } satisfies RepositoryIdentityResolverShape;
  },
);

export const RepositoryIdentityResolverLive = Layer.effect(
  RepositoryIdentityResolver,
  makeRepositoryIdentityResolver(),
).pipe(Layer.provide(ProcessRunner.layer));
