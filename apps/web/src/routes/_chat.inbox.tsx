/**
 * `/inbox` — Slack-style inbox listing every side-thread the current user
 * has been @-mentioned in. Clicking a row deep-links into the parent thread
 * and pops the side-thread drawer on the anchor message.
 */
import { scopeThreadRef } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { InboxItem, ThreadId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AtSignIcon, CheckCheckIcon, InboxIcon, XIcon } from "lucide-react";
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
import { isInboxItemUnread, useInboxStore, useInboxUnreadCount } from "../inbox/inboxStore";
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
  const items = useInboxStore((state) => state.items);
  const status = useInboxStore((state) => state.status);
  const errorMessage = useInboxStore((state) => state.errorMessage);
  const refresh = useInboxStore((state) => state.refresh);
  const dismiss = useInboxStore((state) => state.dismiss);
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const markThreadsVisited = useUiStateStore((state) => state.markThreadsVisited);
  const unreadCount = useInboxUnreadCount();
  const currentUser = useCurrentUser();
  const openSideThread = useSideThreadStore((state) => state.open);
  const navigate = useNavigate();

  useEffect(() => {
    if (!environmentId) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    void refresh(api);
  }, [environmentId, refresh]);

  const grouped = useMemo(() => groupItemsByParentThread(items), [items]);

  const openInboxItem = async (item: InboxItem) => {
    if (!environmentId) return;
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
      openSideThread({
        parentThreadId: unscopedParentThreadId,
        anchorMessageId: item.anchorMessageId as unknown as Parameters<
          typeof openSideThread
        >[0]["anchorMessageId"],
      });
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

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <AtSignIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Mentions</span>
          <Badge variant="secondary" className="ml-1 rounded-md px-1.5 py-0 text-[10px]">
            {unreadCount}
          </Badge>
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={unreadCount === 0}
              onClick={() => {
                markThreadsVisited(
                  items.map((item) => ({
                    threadId: item.sideThreadId,
                    visitedAt: item.lastMentionAt,
                  })),
                );
              }}
            >
              <CheckCheckIcon className="size-3.5" />
              Mark all read
            </Button>
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

        {status === "loading" && items.length === 0 ? (
          <div className="flex-1 px-4 py-8 text-center text-sm text-muted-foreground/60">
            Loading…
          </div>
        ) : items.length === 0 ? (
          <Empty className="flex-1">
            <EmptyHeader className="max-w-md">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <InboxIcon className="size-5" />
              </div>
              <EmptyTitle className="text-foreground text-xl">No mentions yet</EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                When a teammate tags <code className="px-1 text-foreground/80">@you</code> in a side
                thread, the message will appear here with a direct link to the conversation.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex-1 overflow-y-auto divide-y divide-border/40">
            {grouped.map((group) => (
              <li key={group.parentThreadId}>
                <div className="bg-muted/30 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  Conversation {group.parentThreadId.slice(0, 8)}
                </div>
                <ul className="divide-y divide-border/30">
                  {group.items.map((item) => {
                    const unread = isInboxItemUnread(item, lastVisitedAtById);
                    return (
                      <li key={item.sideThreadId} className="group relative">
                        <button
                          type="button"
                          onClick={() => {
                            void openInboxItem(item);
                          }}
                          className={cn(
                            "flex w-full items-start gap-3 px-4 py-3 pr-12 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            unread && "bg-amber-500/5",
                          )}
                        >
                          <span
                            className={cn(
                              "mt-1 size-2 shrink-0 rounded-full",
                              unread ? "bg-amber-500" : "bg-transparent",
                            )}
                            aria-label={unread ? "unread" : "read"}
                          />
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-sm font-medium text-foreground">
                                {item.lastMentionAuthor.displayName}
                              </span>
                              <span className="text-[10px] text-muted-foreground/60">
                                {formatRelativeTimeLabel(item.lastMentionAt)}
                              </span>
                            </div>
                            <p className="line-clamp-2 text-sm text-foreground/75">
                              {item.lastMentionPreview}
                            </p>
                            {item.mentionsCount > 1 ? (
                              <span className="text-[10px] text-muted-foreground/60">
                                {item.mentionsCount} mentions in this side thread
                              </span>
                            ) : null}
                          </div>
                        </button>
                        <button
                          type="button"
                          aria-label="Dismiss mention"
                          title="Dismiss mention"
                          disabled={!environmentId || !currentUser}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!environmentId || !currentUser) return;
                            void dismiss(
                              ensureEnvironmentApi(environmentId),
                              item.sideThreadId,
                              currentUser.id,
                            );
                          }}
                          className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <XIcon className="size-4" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SidebarInset>
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
  readonly parentThreadId: ThreadId;
  readonly items: ReadonlyArray<InboxItem>;
}

/**
 * Group inbox items by their parent agent thread so the UI surfaces "this
 * is the same conversation" affordance — keeps the list visually scannable
 * when one thread accumulates many mentions over time.
 */
function groupItemsByParentThread(
  items: ReadonlyArray<InboxItem>,
): ReadonlyArray<ParentThreadGroup> {
  const order: ThreadId[] = [];
  const byParent = new Map<ThreadId, InboxItem[]>();
  for (const item of items) {
    const list = byParent.get(item.parentThreadId);
    if (list) {
      list.push(item);
    } else {
      byParent.set(item.parentThreadId, [item]);
      order.push(item.parentThreadId);
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
