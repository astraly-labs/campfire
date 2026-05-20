/**
 * CodexAdapter — shape type for the Codex provider adapter.
 *
 * Historically this module exposed a `Context.Service` tag so consumers
 * could inject the adapter through the Effect layer graph. The driver
 * model ({@link ../Drivers/CodexDriver}) bundles one adapter per
 * instance as a captured closure instead, so the tag is gone — we only
 * retain the shape interface as a naming anchor for the driver bundle.
 *
 * @module CodexAdapter
 */
import type { ThreadId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * Codex-specific adapter methods that aren't part of the common
 * `ProviderAdapterShape`. These wrap Codex app-server RPCs that have no
 * cross-provider analog (e.g. `thread/compact/start`, `review/start`) and
 * are reached via a `driverKind === "codex"` branch in the WS layer.
 */
export interface CodexAdapterCommandsShape {
  /**
   * Trigger `thread/compact/start` on the codex app-server for the given
   * thread. Async fire-and-forget; completion is observed via the existing
   * `thread/compacted` notification path.
   */
  readonly compactThread: (threadId: ThreadId) => Effect.Effect<void, ProviderAdapterError>;
  /**
   * Trigger `review/start` on the codex app-server for the given thread,
   * targeting the working tree's uncommitted changes by default.
   */
  readonly startReview: (threadId: ThreadId) => Effect.Effect<void, ProviderAdapterError>;
  /**
   * Trigger `thread/goal/set` on the codex app-server. Either creates a new
   * goal (when `objective` is provided) or mutates an existing one (status,
   * tokenBudget). The fresh goal state lands back via the
   * `thread/goal/updated` notification path.
   */
  readonly setThreadGoal: (input: {
    readonly threadId: ThreadId;
    readonly objective?: string | undefined;
    readonly status?: "active" | "paused" | "budgetLimited" | "complete" | undefined;
    readonly tokenBudget?: number | null | undefined;
  }) => Effect.Effect<void, ProviderAdapterError>;
  /**
   * Trigger `thread/goal/clear` on the codex app-server. The cleared state
   * lands back via the `thread/goal/cleared` notification path.
   */
  readonly clearThreadGoal: (threadId: ThreadId) => Effect.Effect<void, ProviderAdapterError>;
}

/**
 * CodexAdapterShape — per-instance Codex adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 */
export interface CodexAdapterShape
  extends ProviderAdapterShape<ProviderAdapterError>, CodexAdapterCommandsShape {}
