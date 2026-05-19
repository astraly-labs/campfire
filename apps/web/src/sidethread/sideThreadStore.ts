import type { MessageId, SideThreadSummary, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

export interface SideThreadAnchor {
  readonly parentThreadId: ThreadId;
  readonly anchorMessageId: MessageId;
}

interface SideThreadStore {
  readonly anchor: SideThreadAnchor | null;
  readonly open: (anchor: SideThreadAnchor) => void;
  readonly close: () => void;

  /**
   * Parent index — the in-memory mirror of the server's
   * `subscribeParentSideThreads` stream for the currently visible
   * conversation. Reset whenever we switch parent threads so anchor
   * buttons never display stale counts from a previous thread.
   */
  readonly parentIndexThreadId: ThreadId | null;
  readonly summariesByAnchorMessageId: ReadonlyMap<MessageId, SideThreadSummary>;
  readonly resetParentIndex: (
    parentThreadId: ThreadId,
    summaries: ReadonlyArray<SideThreadSummary>,
  ) => void;
  readonly upsertParentSummary: (summary: SideThreadSummary) => void;
  readonly clearParentIndex: () => void;
}

export const useSideThreadStore = create<SideThreadStore>((set) => ({
  anchor: null,
  open: (anchor) => set({ anchor }),
  close: () => set({ anchor: null }),

  parentIndexThreadId: null,
  summariesByAnchorMessageId: new Map(),
  resetParentIndex: (parentThreadId, summaries) =>
    set({
      parentIndexThreadId: parentThreadId,
      summariesByAnchorMessageId: indexByAnchor(summaries),
    }),
  upsertParentSummary: (summary) =>
    set((state) => {
      if (state.parentIndexThreadId !== summary.parentThreadId) return state;
      if (summary.anchor.kind !== "message") return state;
      const next = new Map(state.summariesByAnchorMessageId);
      next.set(summary.anchor.messageId, summary);
      return { summariesByAnchorMessageId: next };
    }),
  clearParentIndex: () => set({ parentIndexThreadId: null, summariesByAnchorMessageId: new Map() }),
}));

function indexByAnchor(
  summaries: ReadonlyArray<SideThreadSummary>,
): ReadonlyMap<MessageId, SideThreadSummary> {
  const map = new Map<MessageId, SideThreadSummary>();
  for (const summary of summaries) {
    if (summary.anchor.kind === "message") {
      map.set(summary.anchor.messageId, summary);
    }
  }
  return map;
}

/**
 * Public hook for the anchor button — returns the existing side thread
 * summary attached to a parent-thread message, or `null` when none exists
 * yet (so the button can switch between "create" and "open" affordances).
 */
export function useSideThreadSummaryFor(messageId: MessageId): SideThreadSummary | null {
  return useSideThreadStore(
    useShallow((state) => state.summariesByAnchorMessageId.get(messageId) ?? null),
  );
}

/**
 * Stable prefix on every derived side-thread id. Other stores (notably
 * `uiStateStore`) rely on this to distinguish side-thread keys from regular
 * agent-thread keys when pruning/persisting per-thread UI state.
 */
export const SIDE_THREAD_KEY_PREFIX = "st-";

/**
 * Deterministic side-thread id derived from the anchor. v0 enforces a single
 * side-thread per (parentThread, message) so both ends compute the same id
 * and converge on the same aggregate without server-side discovery.
 */
export function deriveSideThreadId(anchor: SideThreadAnchor): string {
  return `${SIDE_THREAD_KEY_PREFIX}${anchor.parentThreadId}-${anchor.anchorMessageId}`;
}

/**
 * True for any string id produced by {@link deriveSideThreadId}. Useful to
 * decide whether a `threadLastVisitedAtById` entry belongs to the regular
 * thread namespace (re-seeded from snapshot) or the side-thread namespace
 * (owned by the side-thread drawer + inbox, persisted locally).
 */
export function isSideThreadKey(threadId: string): boolean {
  return threadId.startsWith(SIDE_THREAD_KEY_PREFIX);
}
