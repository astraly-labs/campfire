/**
 * Presence store — "who is looking at what right now". Holds the latest
 * snapshot the server has pushed, keyed by {@link UserId} for cheap
 * sub-selection.
 *
 * The store does NOT decide what the *current* user is doing — that's the
 * job of {@link usePresenceHeartbeat}, which keeps the server informed.
 * This store is purely the read side, applied from
 * `api.presence.subscribe`.
 */
import type {
  EnvironmentApi,
  PresenceEntry,
  PresenceSnapshotEvent,
  PresenceTypingFocus,
  SideThreadId,
  ThreadId,
  UserId,
  UserRef,
} from "@t3tools/contracts";
import { useEffect, useMemo } from "react";
import { create } from "zustand";

interface PresenceStore {
  /** Last snapshot the server emitted, indexed by userId for cheap selectors. */
  readonly entries: ReadonlyMap<UserId, PresenceEntry>;
  readonly status: "idle" | "subscribed" | "error";
  readonly errorMessage: string | null;
  readonly applySnapshot: (event: PresenceSnapshotEvent) => void;
  readonly reset: () => void;
}

export const usePresenceStore = create<PresenceStore>((set) => ({
  entries: new Map(),
  status: "idle",
  errorMessage: null,
  applySnapshot: (event) => {
    const next = new Map<UserId, PresenceEntry>();
    for (const entry of event.entries) {
      next.set(entry.user.id, entry);
    }
    set({ entries: next, status: "subscribed", errorMessage: null });
  },
  reset: () => set({ entries: new Map(), status: "idle", errorMessage: null }),
}));

/**
 * Subscribe once at the app root to the presence stream so every surface
 * that derives from this store stays live without re-subscribing.
 */
export function usePresenceLiveSync(api: EnvironmentApi | undefined): void {
  useEffect(() => {
    if (!api) return;
    const apply = usePresenceStore.getState().applySnapshot;
    const unsubscribe = api.presence.subscribe(apply);
    return () => {
      unsubscribe();
    };
  }, [api]);
}

export interface ViewerInfo {
  readonly user: UserRef;
  readonly isTyping: boolean;
  /** Where the user is typing — useful when the avatar lives outside the
   * specific surface so we can render the pulse only on the right one. */
  readonly typingIn: PresenceTypingFocus | null;
}

/**
 * Build a deduplicated list of viewers ordered by displayName. Pure to make
 * the React hooks below trivial selectors. Returns an empty array (referentially
 * fresh) on no matches — callers usually pass this through `Array.length`.
 */
export function selectViewersOfParentThread(
  entries: ReadonlyMap<UserId, PresenceEntry>,
  parentThreadId: ThreadId,
): ReadonlyArray<ViewerInfo> {
  const out: ViewerInfo[] = [];
  for (const entry of entries.values()) {
    if (entry.parentThreadId !== parentThreadId) continue;
    out.push({
      user: entry.user,
      isTyping: entry.typingIn !== null,
      typingIn: entry.typingIn,
    });
  }
  return out.toSorted((a, b) => a.user.displayName.localeCompare(b.user.displayName));
}

/**
 * Viewers focused on a specific side-thread drawer — narrower than the
 * parent-thread query because users with the drawer collapsed but the
 * parent open are NOT counted here.
 */
export function selectViewersOfSideThread(
  entries: ReadonlyMap<UserId, PresenceEntry>,
  sideThreadId: SideThreadId,
): ReadonlyArray<ViewerInfo> {
  const out: ViewerInfo[] = [];
  for (const entry of entries.values()) {
    if (entry.sideThreadId !== sideThreadId) continue;
    out.push({
      user: entry.user,
      isTyping: entry.typingIn === "side",
      typingIn: entry.typingIn,
    });
  }
  return out.toSorted((a, b) => a.user.displayName.localeCompare(b.user.displayName));
}

/**
 * Hook variants pull the *entries* Map (referentially stable across irrelevant
 * snapshots because `applySnapshot` only sets a new Map on actual changes from
 * the server) and memoise the projection. Returning the result of the pure
 * selector directly from a zustand selector would build a fresh array on every
 * render and break the equality check, retriggering downstream renders.
 */
export function useViewersOfParentThread(
  parentThreadId: ThreadId | null | undefined,
): ReadonlyArray<ViewerInfo> {
  const entries = usePresenceStore((state) => state.entries);
  return useMemo(
    () => (parentThreadId ? selectViewersOfParentThread(entries, parentThreadId) : EMPTY),
    [entries, parentThreadId],
  );
}

export function useViewersOfSideThread(
  sideThreadId: SideThreadId | null | undefined,
): ReadonlyArray<ViewerInfo> {
  const entries = usePresenceStore((state) => state.entries);
  return useMemo(
    () => (sideThreadId ? selectViewersOfSideThread(entries, sideThreadId) : EMPTY),
    [entries, sideThreadId],
  );
}

const EMPTY: ReadonlyArray<ViewerInfo> = [];
