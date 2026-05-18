/**
 * Inbox store — Slack-style aggregate of side-threads where the current user
 * has been @-mentioned.
 *
 * Source of truth lives server-side in `projection_side_thread_message_mentions`.
 * We hydrate from `inbox.list` on mount, then merge `inbox.subscribe` push
 * updates so badge counts stay live without polling. Unread state is derived
 * from `uiStateStore.threadLastVisitedAtById` keyed by the side-thread id —
 * which mirrors how regular threads track read state and keeps both surfaces
 * consistent if the user "marks read" by visiting.
 */
import type { EnvironmentApi, InboxItem, InboxStreamEvent } from "@t3tools/contracts";
import { useEffect } from "react";
import { create } from "zustand";

import { useUiStateStore } from "../uiStateStore";

interface InboxStore {
  readonly items: ReadonlyArray<InboxItem>;
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly errorMessage: string | null;
  readonly refresh: (api: EnvironmentApi) => Promise<void>;
  readonly applyStreamEvent: (event: InboxStreamEvent) => void;
  readonly reset: () => void;
}

export const useInboxStore = create<InboxStore>((set, get) => ({
  items: [],
  status: "idle",
  errorMessage: null,

  refresh: async (api) => {
    set({ status: "loading", errorMessage: null });
    try {
      const result = await api.inbox.list();
      set({ items: sortByLastMention(result.items), status: "ready", errorMessage: null });
    } catch (cause) {
      set({
        status: "error",
        errorMessage: cause instanceof Error ? cause.message : "Failed to load inbox",
      });
    }
  },

  applyStreamEvent: (event) => {
    if (event.kind === "snapshot") {
      set({ items: sortByLastMention(event.items), status: "ready", errorMessage: null });
      return;
    }
    const current = get().items;
    const others = current.filter((item) => item.sideThreadId !== event.item.sideThreadId);
    set({ items: sortByLastMention([event.item, ...others]) });
  },

  reset: () => set({ items: [], status: "idle", errorMessage: null }),
}));

function sortByLastMention(items: ReadonlyArray<InboxItem>): InboxItem[] {
  return [...items].sort((left, right) => {
    if (left.lastMentionAt === right.lastMentionAt) {
      return left.sideThreadId.localeCompare(right.sideThreadId);
    }
    return left.lastMentionAt < right.lastMentionAt ? 1 : -1;
  });
}

/**
 * Wires the live inbox subscription. Mount once at the app root so badge
 * updates fire even when the user is not on `/inbox`.
 */
export function useInboxLiveSync(api: EnvironmentApi | undefined): void {
  useEffect(() => {
    if (!api) return;
    const apply = useInboxStore.getState().applyStreamEvent;
    const unsubscribe = api.inbox.subscribe(apply);
    return () => {
      unsubscribe();
    };
  }, [api]);
}

/**
 * Number of unread (= mention occurred after last visit) inbox entries.
 * Drives the sidebar badge.
 */
export function useInboxUnreadCount(): number {
  const items = useInboxStore((state) => state.items);
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  let unread = 0;
  for (const item of items) {
    if (isInboxItemUnread(item, lastVisitedAtById)) unread += 1;
  }
  return unread;
}

export function isInboxItemUnread(
  item: InboxItem,
  lastVisitedAtById: Record<string, string>,
): boolean {
  const lastVisited = lastVisitedAtById[item.sideThreadId];
  if (!lastVisited) return true;
  return lastVisited < item.lastMentionAt;
}
