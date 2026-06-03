/**
 * WorktreeArtifactRetention - Background sweeper that deletes regenerable
 * build/dependency artifacts (`target/`, `.venv/`, `node_modules/`, …)
 * from worktree directories that have been idle past the retention window.
 *
 * Each campfire thread that touches a project gets its own git worktree
 * under `~/.t3/worktrees/<projectSlug>/<worktreeName>/`. Build artifacts
 * inside those worktrees (Rust `target/`, Python `.venv/`, etc.) compound
 * fast: on the team mac mini we observed 96 worktrees of one Rust repo
 * holding **558 GB** of `target/` alone. Those artifacts are gitignored
 * and trivially regenerated; deleting them in worktrees nobody has
 * touched in a week reclaims most of the disk without losing any work.
 *
 * @module WorktreeArtifactRetention
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface WorktreeArtifactRetentionShape {
  /**
   * Fork a long-running fiber into the provided scope that sweeps stale
   * worktree artifacts on the configured cadence. Resolves immediately;
   * the first sweep runs on start.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class WorktreeArtifactRetention extends Context.Service<
  WorktreeArtifactRetention,
  WorktreeArtifactRetentionShape
>()("t3/worktree/Services/WorktreeArtifactRetention") {}
