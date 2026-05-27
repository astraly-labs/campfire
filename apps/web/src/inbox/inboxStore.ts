/**
 * Inbox store — Slack-style aggregate of side-threads that need the current
 * user's attention. Two kinds of items live in one list (discriminated by
 * `kind`):
 *   - `"mention"` — the user was @-mentioned (source:
 *     `projection_side_thread_message_mentions`). Dismissable.
 *   - `"activity"` — a new message landed in a side-thread the user
 *     participates in, authored by someone else (source:
 *     `projection_side_thread_participants`). Clears by visiting.
 *
 * We hydrate from `inbox.list` on mount, then merge `inbox.subscribe` push
 * updates so badge counts stay live without polling. Unread state is derived
 * from `uiStateStore.threadLastVisitedAtById` keyed by the side-thread id —
 * which mirrors how regular threads track read state and keeps both surfaces
 * consistent if the user "marks read" by visiting.
 *
 * Items are keyed by `(kind, sideThreadId)`: one side-thread can be both a
 * mention and an activity row, and they live in separate UI sections.
 */
import type {
  EnvironmentApi,
  InboxItem,
  InboxItemKind,
  InboxStreamEvent,
  SideThreadId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { newCommandId } from "../lib/utils";
import {
  ensureNotificationPermission,
  notifyInboxItem,
} from "../notifications/desktopNotifications";
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
   * Optimistic: removes the mention row locally first, then dispatches the
   * command. Only mention rows are dismissable — the activity row (if any) for
   * the same side-thread stays. The server echoes a `removed` stream event so
   * other tabs of the same user drop it too. On failure, restore the snapshot.
   */
  readonly dismiss: (
    api: EnvironmentApi,
    sideThreadId: SideThreadId,
    userId: UserId,
  ) => Promise<void>;
  readonly reset: () => void;
}

const sameRow = (item: InboxItem, kind: InboxItemKind, sideThreadId: SideThreadId): boolean =>
  item.kind === kind && item.sideThreadId === sideThreadId;

export const useInboxStore = create<InboxStore>((set, get) => ({
  items: [],
  status: "idle",
  errorMessage: null,

  refresh: async (api) => {
    set({ status: "loading", errorMessage: null });
    try {
      const result = await api.inbox.list();
      set({ items: sortByLastActivity(result.items), status: "ready", errorMessage: null });
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
      set({ items: sortByLastActivity(event.items), status: "ready", errorMessage: null });
      return;
    }
    if (event.kind === "removed") {
      realtimeLog("inbox", "event.removed", {
        itemKind: event.itemKind,
        sideThreadId: event.sideThreadId,
      });
      const current = get().items;
      set({
        items: current.filter((item) => !sameRow(item, event.itemKind, event.sideThreadId)),
      });
      return;
    }
    realtimeLog("inbox", "event.upserted", {
      itemKind: event.item.kind,
      sideThreadId: event.item.sideThreadId,
    });
    const current = get().items;
    const others = current.filter(
      (item) => !sameRow(item, event.item.kind, event.item.sideThreadId),
    );
    set({ items: sortByLastActivity([event.item, ...others]) });
  },

  dismiss: async (api, sideThreadId, userId) => {
    const previous = get().items;
    set({ items: previous.filter((item) => !sameRow(item, "mention", sideThreadId)) });
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

function sortByLastActivity(items: ReadonlyArray<InboxItem>): InboxItem[] {
  return [...items].sort((left, right) => {
    if (left.lastActivityAt === right.lastActivityAt) {
      return left.sideThreadId.localeCompare(right.sideThreadId);
    }
    return left.lastActivityAt < right.lastActivityAt ? 1 : -1;
  });
}

/**
 * Fire an OS notification for a freshly-arrived upserted item. Kept out of the
 * pure reducer so unit tests don't touch the Notification API. Skips re-emits
 * of the same head message and items the user has already caught up on.
 */
function maybeNotify(event: InboxStreamEvent): void {
  if (event.kind !== "upserted") return;
  const previous = useInboxStore
    .getState()
    .items.find((item) => sameRow(item, event.item.kind, event.item.sideThreadId));
  if (previous && previous.lastMessageId === event.item.lastMessageId) return;
  const visited = useUiStateStore.getState().threadLastVisitedAtById;
  if (!isInboxItemUnread(event.item, visited)) return;
  notifyInboxItem(event.item);
}

/**
 * Wires the live inbox subscription. Mount once under the auth-gated chat
 * layout so badge updates and OS notifications fire even when the user is not
 * on `/inbox`.
 */
export function useInboxLiveSync(api: EnvironmentApi | undefined): void {
  // Ask for OS-notification permission once the session is live. Idempotent;
  // resolves silently if the user already decided.
  useEffect(() => {
    if (!api) return;
    void ensureNotificationPermission();
  }, [api]);

  useLiveChannel(() => {
    if (!api) return null;
    return {
      channelKey: "inbox",
      subscribe: (listener, options) => api.inbox.subscribe(listener, options),
      applyEvent: (event: InboxStreamEvent) => {
        maybeNotify(event);
        useInboxStore.getState().applyStreamEvent(event);
      },
      // Belt-and-suspenders: on every reconnect, re-fetch the whole list via
      // `api.inbox.list()`. The stream itself promises to re-emit a snapshot,
      // but in remote/Tailscale mode the WS can flap silently and miss it.
      onResubscribe: () => useInboxStore.getState().refresh(api),
    };
  }, [api]);
}

function countUnread(
  items: ReadonlyArray<InboxItem>,
  lastVisitedAtById: Record<string, string>,
  kind?: InboxItemKind,
): number {
  let unread = 0;
  for (const item of items) {
    if (kind && item.kind !== kind) continue;
    if (isInboxItemUnread(item, lastVisitedAtById)) unread += 1;
  }
  return unread;
}

/**
 * Total number of unread inbox entries (mentions + activity). Drives the
 * sidebar badge.
 */
export function useInboxUnreadCount(): number {
  const items = useInboxStore((state) => state.items);
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  return countUnread(items, lastVisitedAtById);
}

/** Unread mention rows — drives the "Mentions" section badge. */
export function useMentionUnreadCount(): number {
  const items = useInboxStore((state) => state.items);
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  return countUnread(items, lastVisitedAtById, "mention");
}

/** Unread activity rows — drives the "Activité" section badge. */
export function useActivityUnreadCount(): number {
  const items = useInboxStore((state) => state.items);
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  return countUnread(items, lastVisitedAtById, "activity");
}

/** Mention rows only, already sorted most-recent-first. */
export function useMentionItems(): ReadonlyArray<InboxItem> {
  return useInboxStore(
    useShallow((state) => state.items.filter((item) => item.kind === "mention")),
  );
}

/** Activity rows only, already sorted most-recent-first. */
export function useActivityItems(): ReadonlyArray<InboxItem> {
  return useInboxStore(
    useShallow((state) => state.items.filter((item) => item.kind === "activity")),
  );
}

export function isInboxItemUnread(
  item: InboxItem,
  lastVisitedAtById: Record<string, string>,
): boolean {
  const lastVisited = lastVisitedAtById[item.sideThreadId];
  if (!lastVisited) return true;
  return lastVisited < item.lastActivityAt;
}

/**
 * Set of parent thread ids that currently carry @-mentions for this user.
 * Drives the sidebar's "auto-promote to My projects on mention" rule — the
 * consumer maps these thread ids to logical project keys via the regular
 * sidebar threads → projects machinery. Only mention rows count (activity
 * alone should not auto-promote a thread).
 */
export function useMentionedParentThreadIds(): ReadonlySet<ThreadId> {
  const parentThreadIds = useInboxStore(
    useShallow((state) =>
      state.items
        .filter((item) => item.kind === "mention")
        .map((item) => item.parentThreadId)
        .filter((id): id is ThreadId => id !== null),
    ),
  );
  return useMemo(() => new Set(parentThreadIds), [parentThreadIds]);
}
