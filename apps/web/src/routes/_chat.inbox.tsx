/**
 * `/inbox` — Slack-style inbox split into two sections:
 *   - "Mentions": side-threads where the current user was @-mentioned.
 *   - "Activité": side-threads the user participates in that got a new message
 *     from someone else.
 * Clicking a row deep-links into the parent thread and pops the side-thread
 * drawer on the anchor message.
 */
import { scopeThreadRef } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { InboxItem, ThreadId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AtSignIcon, CheckCheckIcon, InboxIcon, MessagesSquareIcon, XIcon } from "lucide-react";
import { useEffect, useMemo } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { ensureEnvironmentApi, readEnvironmentApi } from "../environmentApi";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { retainThreadDetailSubscription } from "../environments/runtime/service";
import { useCurrentUser } from "../identity/identityStore";
import {
  isInboxItemUnread,
  useActivityItems,
  useActivityUnreadCount,
  useInboxStore,
  useMentionItems,
  useMentionUnreadCount,
} from "../inbox/inboxStore";
import { selectThreadExistsByRef, selectThreadMissingByRef, useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { useUiStateStore } from "../uiStateStore";
import { useSideThreadStore } from "../sidethread/sideThreadStore";
import { cn } from "~/lib/utils";

/**
 * How long we wait for `subscribeThread` to either deliver a snapshot or
 * fail with "not found" before letting the navigation proceed anyway. If
 * the snapshot is just slow (good network, just not yet hydrated), the
 * thread route's own 2.5s grace will catch the gap. If it's truly missing,
 * the user sees the toast within this window and stays on /inbox.
 */
const MISSING_THREAD_DETECTION_TIMEOUT_MS = 1_500;

function InboxRouteView() {
  const environmentId = usePrimaryEnvironmentId();
  const status = useInboxStore((state) => state.status);
  const errorMessage = useInboxStore((state) => state.errorMessage);
  const refresh = useInboxStore((state) => state.refresh);
  const dismiss = useInboxStore((state) => state.dismiss);
  const mentionItems = useMentionItems();
  const activityItems = useActivityItems();
  const mentionUnread = useMentionUnreadCount();
  const activityUnread = useActivityUnreadCount();
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const markThreadsVisited = useUiStateStore((state) => state.markThreadsVisited);
  const currentUser = useCurrentUser();
  const openSideThread = useSideThreadStore((state) => state.open);
  const navigate = useNavigate();

  useEffect(() => {
    if (!environmentId) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    void refresh(api);
  }, [environmentId, refresh]);

  const openInboxItem = async (item: InboxItem) => {
    if (!environmentId) return;

    // Workspace-wide global chat — no parent thread to deep-link to. Just
    // navigate to /global; the route mounts the global SideThread directly.
    if (item.parentThreadId === null) {
      void navigate({ to: "/global" });
      return;
    }

    // Older mentions were created when `SideThreadAnchorButton` was passed
    // `routeThreadKey` (the scoped `<env>:<thread>` form) as its ThreadId
    // prop. That string then leaked into the side thread's `parentThreadId`
    // and back into the inbox row. Strip it so the URL stays unscoped.
    const unscopedParentThreadId = stripEnvironmentPrefix(
      item.parentThreadId,
      environmentId,
    ) as ThreadId;
    const threadRef = scopeThreadRef(environmentId, unscopedParentThreadId);
    const params = buildThreadRouteParams(threadRef);

    const proceed = () => {
      openSideThread(unscopedParentThreadId);
      void navigate({
        to: "/$environmentId/$threadId",
        params,
      });
    };

    const showMissingToast = () => {
      toastManager.add({
        type: "error",
        title: "Conversation introuvable",
        description:
          "Le thread mentionné a été supprimé. Cette mention pointe vers une conversation qui n'existe plus.",
      });
    };

    const currentState = useStore.getState();
    if (selectThreadMissingByRef(currentState, threadRef)) {
      showMissingToast();
      return;
    }
    if (selectThreadExistsByRef(currentState, threadRef)) {
      proceed();
      return;
    }

    // Thread not yet hydrated — race subscribe-snapshot vs missing-flag vs
    // a short timeout. Retain the subscription here so it survives the
    // navigation; the route's own retain call will reuse the same entry.
    const release = retainThreadDetailSubscription(environmentId, unscopedParentThreadId);
    try {
      const outcome = await waitForThreadResolution(threadRef);
      if (outcome === "missing") {
        showMissingToast();
        return;
      }
      // "exists" or "timeout" — proceed (the route fallback handles late
      // arrivals of either signal).
      proceed();
    } finally {
      release();
    }
  };

  const markAllRead = (items: ReadonlyArray<InboxItem>) => {
    markThreadsVisited(
      items.map((item) => ({ threadId: item.sideThreadId, visitedAt: item.lastActivityAt })),
    );
  };

  const onDismiss = (item: InboxItem) => {
    if (!environmentId || !currentUser) return;
    void dismiss(ensureEnvironmentApi(environmentId), item.sideThreadId, currentUser.id);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <InboxIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Inbox</span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={!environmentId || status === "loading"}
              onClick={() => {
                if (!environmentId) return;
                void refresh(ensureEnvironmentApi(environmentId));
              }}
            >
              Refresh
            </Button>
          </div>
        </header>

        {errorMessage ? (
          <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
            {errorMessage}
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto">
          <InboxSection
            title="Mentions"
            icon={<AtSignIcon className="size-4 text-muted-foreground" />}
            items={mentionItems}
            unreadCount={mentionUnread}
            canDismiss
            loading={status === "loading"}
            emptyTitle="Aucune mention"
            emptyDescription="Quand un coéquipier vous tague @vous dans un fil, le message apparaît ici."
            lastVisitedAtById={lastVisitedAtById}
            onOpen={openInboxItem}
            onDismiss={onDismiss}
            onMarkAllRead={() => markAllRead(mentionItems)}
            dismissDisabled={!environmentId || !currentUser}
          />
          <InboxSection
            title="Activité"
            icon={<MessagesSquareIcon className="size-4 text-muted-foreground" />}
            items={activityItems}
            unreadCount={activityUnread}
            canDismiss={false}
            loading={status === "loading"}
            emptyTitle="Aucune nouvelle activité"
            emptyDescription="Les nouveaux messages dans les fils où vous participez apparaissent ici."
            lastVisitedAtById={lastVisitedAtById}
            onOpen={openInboxItem}
            onMarkAllRead={() => markAllRead(activityItems)}
          />
        </div>
      </div>
    </SidebarInset>
  );
}

interface InboxSectionProps {
  readonly title: string;
  readonly icon: React.ReactNode;
  readonly items: ReadonlyArray<InboxItem>;
  readonly unreadCount: number;
  readonly canDismiss: boolean;
  readonly loading: boolean;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly lastVisitedAtById: Record<string, string>;
  readonly onOpen: (item: InboxItem) => void | Promise<void>;
  readonly onMarkAllRead: () => void;
  readonly onDismiss?: (item: InboxItem) => void;
  readonly dismissDisabled?: boolean;
}

function InboxSection({
  title,
  icon,
  items,
  unreadCount,
  canDismiss,
  loading,
  emptyTitle,
  emptyDescription,
  lastVisitedAtById,
  onOpen,
  onMarkAllRead,
  onDismiss,
  dismissDisabled,
}: InboxSectionProps) {
  const grouped = useMemo(() => groupItemsByParentThread(items), [items]);

  return (
    <section className="border-b border-border/60 last:border-b-0">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/40 bg-background/95 px-4 py-2 backdrop-blur">
        {icon}
        <span className="text-sm font-medium text-foreground">{title}</span>
        <Badge variant="secondary" className="ml-1 rounded-md px-1.5 py-0 text-[10px]">
          {unreadCount}
        </Badge>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          disabled={unreadCount === 0}
          onClick={onMarkAllRead}
        >
          <CheckCheckIcon className="size-3.5" />
          Tout marquer comme lu
        </Button>
      </header>

      {loading && items.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground/60">Chargement…</div>
      ) : items.length === 0 ? (
        <Empty className="py-8">
          <EmptyHeader className="max-w-md">
            <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
              <InboxIcon className="size-5" />
            </div>
            <EmptyTitle className="text-foreground text-lg">{emptyTitle}</EmptyTitle>
            <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
              {emptyDescription}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="divide-y divide-border/40">
          {grouped.map((group) => (
            <li key={group.parentThreadId ?? "__global__"}>
              <div className="bg-muted/30 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                {group.parentThreadId === null
                  ? "Global chat"
                  : `Conversation ${group.parentThreadId.slice(0, 8)}`}
              </div>
              <ul className="divide-y divide-border/30">
                {group.items.map((item) => {
                  const unread = isInboxItemUnread(item, lastVisitedAtById);
                  return (
                    <li key={item.sideThreadId} className="group relative">
                      <button
                        type="button"
                        onClick={() => {
                          void onOpen(item);
                        }}
                        className={cn(
                          "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          canDismiss && "pr-12",
                          unread && "bg-amber-500/5",
                        )}
                      >
                        <span
                          className={cn(
                            "mt-1 size-2 shrink-0 rounded-full",
                            unread ? "bg-amber-500" : "bg-transparent",
                          )}
                          aria-label={unread ? "non lu" : "lu"}
                        />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-sm font-medium text-foreground">
                              {item.lastAuthor.displayName}
                            </span>
                            <span className="text-[10px] text-muted-foreground/60">
                              {formatRelativeTimeLabel(item.lastActivityAt)}
                            </span>
                          </div>
                          <p className="line-clamp-2 text-sm text-foreground/75">
                            {item.lastPreview}
                          </p>
                          {item.count > 1 ? (
                            <span className="text-[10px] text-muted-foreground/60">
                              {item.kind === "mention"
                                ? `${item.count} mentions dans ce fil`
                                : `${item.count} messages dans ce fil`}
                            </span>
                          ) : null}
                        </div>
                      </button>
                      {canDismiss && onDismiss ? (
                        <button
                          type="button"
                          aria-label="Ignorer la mention"
                          title="Ignorer la mention"
                          disabled={dismissDisabled}
                          onClick={(event) => {
                            event.stopPropagation();
                            onDismiss(item);
                          }}
                          className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <XIcon className="size-4" />
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * `<env>:<thread>` strings leaked into older side-thread `parentThreadId`s
 * because `SideThreadAnchorButton` was given `routeThreadKey` (the scoped
 * key) cast as `ThreadId`. Trim the env prefix so navigation finds the row
 * in `threadShellById`, which is keyed by the unscoped id.
 */
function stripEnvironmentPrefix(threadId: ThreadId, environmentId: string): ThreadId {
  const prefix = `${environmentId}:`;
  return (threadId.startsWith(prefix) ? threadId.slice(prefix.length) : threadId) as ThreadId;
}

type ThreadResolution = "exists" | "missing" | "timeout";

/**
 * Resolves when the store transitions the given thread to either "exists"
 * (snapshot arrived) or "missing" (subscribeThread returned not-found), or
 * when the short detection window elapses. The caller is responsible for
 * retaining the underlying subscription for the duration of the wait.
 */
function waitForThreadResolution(threadRef: ScopedThreadRef): Promise<ThreadResolution> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: ThreadResolution) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      unsubscribe();
      resolve(outcome);
    };

    const unsubscribe = useStore.subscribe((state) => {
      if (selectThreadMissingByRef(state, threadRef)) {
        settle("missing");
        return;
      }
      if (selectThreadExistsByRef(state, threadRef)) {
        settle("exists");
      }
    });

    const timeoutId = window.setTimeout(() => {
      settle("timeout");
    }, MISSING_THREAD_DETECTION_TIMEOUT_MS);
  });
}

interface ParentThreadGroup {
  /** `null` for the workspace-wide global chat group. */
  readonly parentThreadId: ThreadId | null;
  readonly items: ReadonlyArray<InboxItem>;
}

/**
 * Group inbox items by their parent agent thread so the UI surfaces "this
 * is the same conversation" affordance — keeps the list visually scannable
 * when one thread accumulates many items over time. Items belonging to the
 * workspace-wide global chat (parentThreadId === null) collapse into a single
 * dedicated group keyed by `null`.
 */
function groupItemsByParentThread(
  items: ReadonlyArray<InboxItem>,
): ReadonlyArray<ParentThreadGroup> {
  const order: Array<ThreadId | null> = [];
  const byParent = new Map<ThreadId | null, InboxItem[]>();
  for (const item of items) {
    const key = item.parentThreadId;
    const list = byParent.get(key);
    if (list) {
      list.push(item);
    } else {
      byParent.set(key, [item]);
      order.push(key);
    }
  }
  return order.map((parentThreadId) => ({
    parentThreadId,
    items: byParent.get(parentThreadId)!,
  }));
}

export const Route = createFileRoute("/_chat/inbox")({
  component: InboxRouteView,
});
