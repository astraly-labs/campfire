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

/** Most-recent-first, with a stable tiebreak so re-sorts don't jitter. */
function compareByLastActivity(left: InboxItem, right: InboxItem): number {
  if (left.lastActivityAt === right.lastActivityAt) {
    return left.sideThreadId.localeCompare(right.sideThreadId);
  }
  return left.lastActivityAt < right.lastActivityAt ? 1 : -1;
}

function sortByLastActivity(items: ReadonlyArray<InboxItem>): InboxItem[] {
  return items.toSorted(compareByLastActivity);
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

/**
 * The four ways the unified inbox can be sliced. `all` and `unread` collapse a
 * side-thread's mention + activity rows into one; `mention` / `activity` show a
 * single kind verbatim.
 */
export type InboxFilter = "all" | "unread" | "mention" | "activity";

/**
 * A presentation row, decoupled from the raw `InboxItem` so the unified "all"
 * view can collapse a thread's two underlying rows into one without losing the
 * mention affordances.
 */
export interface InboxRow {
  /** Item whose preview / author / timestamp are rendered (the most recent one). */
  readonly item: InboxItem;
  /** Render the @-mention treatment (icon) — true when a mention exists for the thread. */
  readonly isMention: boolean;
  /** Expose the "dismiss mention" action — only mentions are dismissable. */
  readonly dismissable: boolean;
  /** Whether the thread is unread relative to the last visit. */
  readonly unread: boolean;
}

function newerItem(left: InboxItem, right: InboxItem): InboxItem {
  return left.lastActivityAt >= right.lastActivityAt ? left : right;
}

/**
 * Project the raw item list into display rows for a given filter.
 *
 * `mention` / `activity` map each row of that kind straight through. `all` and
 * `unread` group by `sideThreadId`: a thread that is both a mention and an
 * activity collapses into a single row that keeps the mention affordances
 * (icon + dismiss) but shows the *newer* of the two for preview and unread
 * state — so the same conversation never appears twice and the row reflects the
 * latest event. Result is sorted most-recent-first.
 */
export function buildInboxRows(
  items: ReadonlyArray<InboxItem>,
  lastVisitedAtById: Record<string, string>,
  filter: InboxFilter,
): InboxRow[] {
  if (filter === "mention" || filter === "activity") {
    const rows = items
      .filter((item) => item.kind === filter)
      .map((item) => ({
        item,
        isMention: filter === "mention",
        dismissable: filter === "mention",
        unread: isInboxItemUnread(item, lastVisitedAtById),
      }));
    return rows.toSorted((left, right) => compareByLastActivity(left.item, right.item));
  }

  const byThread = new Map<SideThreadId, { mention?: InboxItem; activity?: InboxItem }>();
  for (const item of items) {
    const entry = byThread.get(item.sideThreadId) ?? {};
    if (item.kind === "mention") entry.mention = item;
    else entry.activity = item;
    byThread.set(item.sideThreadId, entry);
  }

  const rows: InboxRow[] = [];
  for (const { mention, activity } of byThread.values()) {
    const item = mention && activity ? newerItem(mention, activity) : (mention ?? activity)!;
    const row: InboxRow = {
      item,
      isMention: mention !== undefined,
      dismissable: mention !== undefined,
      unread: isInboxItemUnread(item, lastVisitedAtById),
    };
    if (filter === "unread" && !row.unread) continue;
    rows.push(row);
  }
  return rows.toSorted((left, right) => compareByLastActivity(left.item, right.item));
}

function countUnread(
  items: ReadonlyArray<InboxItem>,
  lastVisitedAtById: Record<string, string>,
  kind: InboxItemKind,
): number {
  let unread = 0;
  for (const item of items) {
    if (item.kind !== kind) continue;
    if (isInboxItemUnread(item, lastVisitedAtById)) unread += 1;
  }
  return unread;
}

/**
 * Total unread conversations (mentions + activity), deduped by side-thread so a
 * thread that is both an unread mention and unread activity counts once — keeps
 * the sidebar badge consistent with the unified inbox's "Tout" tab. Drives the
 * sidebar badge.
 */
export function useInboxUnreadCount(): number {
  const items = useInboxStore((state) => state.items);
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  return useMemo(
    () => buildInboxRows(items, lastVisitedAtById, "unread").length,
    [items, lastVisitedAtById],
  );
}

/** Unread mention rows — drives the "Mentions" tab badge. */
export function useMentionUnreadCount(): number {
  const items = useInboxStore((state) => state.items);
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  return countUnread(items, lastVisitedAtById, "mention");
}

/** Unread activity rows — drives the "Activité" tab badge. */
export function useActivityUnreadCount(): number {
  const items = useInboxStore((state) => state.items);
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  return countUnread(items, lastVisitedAtById, "activity");
}

/** Display rows for the inbox under `filter`, recomputed when inputs change. */
export function useInboxRows(filter: InboxFilter): InboxRow[] {
  const items = useInboxStore((state) => state.items);
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  return useMemo(
    () => buildInboxRows(items, lastVisitedAtById, filter),
    [items, lastVisitedAtById, filter],
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
