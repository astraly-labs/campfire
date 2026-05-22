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
import type {
  EnvironmentApi,
  InboxItem,
  InboxStreamEvent,
  SideThreadId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import { useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { newCommandId } from "../lib/utils";
import { useLiveChannel } from "../realtime/liveChannel";
import { realtimeLog } from "../rpc/realtimeLog";
import { useUiStateStore } from "../uiStateStore";

interface InboxStore {
  readonly items: ReadonlyArray<InboxItem>;
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly errorMessage: string | null;
  readonly refresh: (api: EnvironmentApi) => Promise<void>;
  readonly applyStreamEvent: (event: InboxStreamEvent) => void;
  /**
   * Soft-dismiss every current mention of `sideThreadId` for `userId`.
   * Optimistic: removes the row locally first, then dispatches the command.
   * The server echoes a `removed` stream event back so other tabs of the
   * same user drop the row too. On failure, refresh to restore truth.
   */
  readonly dismiss: (
    api: EnvironmentApi,
    sideThreadId: SideThreadId,
    userId: UserId,
  ) => Promise<void>;
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
      realtimeLog("inbox", "snapshot.applied", { itemCount: event.items.length });
      set({ items: sortByLastMention(event.items), status: "ready", errorMessage: null });
      return;
    }
    if (event.kind === "removed") {
      realtimeLog("inbox", "event.removed", { sideThreadId: event.sideThreadId });
      const current = get().items;
      set({ items: current.filter((item) => item.sideThreadId !== event.sideThreadId) });
      return;
    }
    realtimeLog("inbox", "event.upserted", { sideThreadId: event.item.sideThreadId });
    const current = get().items;
    const others = current.filter((item) => item.sideThreadId !== event.item.sideThreadId);
    set({ items: sortByLastMention([event.item, ...others]) });
  },

  dismiss: async (api, sideThreadId, userId) => {
    const previous = get().items;
    set({ items: previous.filter((item) => item.sideThreadId !== sideThreadId) });
    try {
      await api.sideThread.dispatchCommand({
        type: "sidethread.inbox.dismiss",
        commandId: newCommandId(),
        sideThreadId,
        userId,
      });
    } catch (cause) {
      // Rollback to the previous state — the server rejected so our local
      // truth is still the snapshot we had before the optimistic remove.
      set({
        items: previous,
        errorMessage: cause instanceof Error ? cause.message : "Failed to dismiss mention",
      });
    }
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
  useLiveChannel(() => {
    if (!api) return null;
    return {
      channelKey: "inbox",
      subscribe: (listener, options) => api.inbox.subscribe(listener, options),
      applyEvent: useInboxStore.getState().applyStreamEvent,
      // Belt-and-suspenders: on every reconnect, re-fetch the whole list via
      // `api.inbox.list()`. The stream itself promises to re-emit a snapshot,
      // but in remote/Tailscale mode the WS can flap silently and miss it.
      onResubscribe: () => useInboxStore.getState().refresh(api),
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

/**
 * Set of parent thread ids that currently carry @-mentions for this user.
 * Drives the sidebar's "auto-promote to My projects on mention" rule —
 * the consumer is responsible for mapping these thread ids to logical
 * project keys via the regular sidebar threads → projects machinery.
 */
export function useMentionedParentThreadIds(): ReadonlySet<ThreadId> {
  const parentThreadIds = useInboxStore(
    useShallow((state) =>
      state.items
        .map((item) => item.parentThreadId)
        .filter((id): id is ThreadId => id !== null),
    ),
  );
  return useMemo(() => new Set(parentThreadIds), [parentThreadIds]);
}
