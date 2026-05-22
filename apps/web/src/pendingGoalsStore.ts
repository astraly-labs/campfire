/**
 * Zustand store for pending thread goals — i.e. goals the user has set via
 * the /goal dialog on a thread that does not yet have an active Codex session
 * (typically a freshly created draft thread before its first turn).
 *
 * The flow is:
 *   1. User picks /goal in the composer palette on a thread with no session.
 *   2. ThreadGoalDialog writes the objective here instead of calling the
 *      Codex `thread/goal/set` RPC (which would fail with "thread not found"
 *      because the draft has no projection row yet, or with "no active
 *      Codex session" for server threads that never started a turn).
 *   3. ThreadGoalBar renders a "pending" variant reading from this store so
 *      the user sees their goal tracked immediately.
 *   4. ChatView watches for the thread's session to become active and then
 *      flushes the pending goal via codexSetThreadGoal. Once Codex emits
 *      thread/goal/updated, the projector populates thread.goal and the bar
 *      switches over to the authoritative server snapshot. The pending entry
 *      is cleared on success.
 *
 * Persistence: localStorage so the goal survives a page refresh between the
 * user setting it and sending their first message.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import { createMemoryStorage } from "./lib/storage";

export interface PendingGoalEntry {
  readonly objective: string;
  /**
   * "pending" = waiting for a Codex session to flush against.
   * "syncing" = a codexSetThreadGoal RPC is in flight; do not redispatch.
   * The store does not auto-transition "syncing" → "pending"; the caller
   * resets it manually if the sync fails so a retry can happen.
   */
  readonly status: "pending" | "syncing";
}

interface PendingGoalsState {
  /** Pending goals keyed by `scopedThreadKey` so multiple environments stay isolated. */
  readonly pendingGoals: Readonly<Record<string, PendingGoalEntry>>;
}

interface PendingGoalsStore extends PendingGoalsState {
  /** Save a pending goal for a thread. Overwrites any existing entry. */
  readonly setPendingGoal: (threadKey: string, objective: string) => void;
  /** Mark the pending goal as currently syncing to Codex. */
  readonly markSyncing: (threadKey: string) => void;
  /** Reset a syncing entry back to pending so the next session window retries. */
  readonly markPending: (threadKey: string) => void;
  /** Remove the pending entry (after a successful flush or explicit clear). */
  readonly clearPendingGoal: (threadKey: string) => void;
}

const PENDING_GOALS_STORAGE_KEY = "t3code:pending-goals:v1";

export const usePendingGoalsStore = create<PendingGoalsStore>()(
  persist(
    (set) => ({
      pendingGoals: {},
      setPendingGoal: (threadKey, objective) =>
        set((state) => ({
          pendingGoals: {
            ...state.pendingGoals,
            [threadKey]: { objective, status: "pending" },
          },
        })),
      markSyncing: (threadKey) =>
        set((state) => {
          const entry = state.pendingGoals[threadKey];
          if (!entry || entry.status === "syncing") return state;
          return {
            pendingGoals: {
              ...state.pendingGoals,
              [threadKey]: { ...entry, status: "syncing" },
            },
          };
        }),
      markPending: (threadKey) =>
        set((state) => {
          const entry = state.pendingGoals[threadKey];
          if (!entry || entry.status === "pending") return state;
          return {
            pendingGoals: {
              ...state.pendingGoals,
              [threadKey]: { ...entry, status: "pending" },
            },
          };
        }),
      clearPendingGoal: (threadKey) =>
        set((state) => {
          if (!(threadKey in state.pendingGoals)) return state;
          const next = { ...state.pendingGoals };
          delete next[threadKey];
          return { pendingGoals: next };
        }),
    }),
    {
      name: PENDING_GOALS_STORAGE_KEY,
      storage: createJSONStorage(() =>
        typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
      ),
      partialize: (state) => ({ pendingGoals: state.pendingGoals }),
    },
  ),
);

/** Subscribe to the pending goal for a specific thread, or undefined. */
export const usePendingGoal = (threadKey: string | null): PendingGoalEntry | undefined =>
  usePendingGoalsStore(
    useShallow((state) => (threadKey ? state.pendingGoals[threadKey] : undefined)),
  );
