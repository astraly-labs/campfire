/**
 * `/inbox` — Slack-style inbox listing every side-thread the current user
 * has been @-mentioned in. Clicking a row deep-links into the parent thread
 * and pops the side-thread drawer on the anchor message.
 */
import { scopeThreadRef } from "@t3tools/client-runtime";
import type { InboxItem, ThreadId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AtSignIcon, InboxIcon } from "lucide-react";
import { useEffect, useMemo } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { ensureEnvironmentApi, readEnvironmentApi } from "../environmentApi";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { isInboxItemUnread, useInboxStore } from "../inbox/inboxStore";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { useUiStateStore } from "../uiStateStore";
import { useSideThreadStore } from "../sidethread/sideThreadStore";
import { cn } from "~/lib/utils";

function InboxRouteView() {
  const environmentId = usePrimaryEnvironmentId();
  const items = useInboxStore((state) => state.items);
  const status = useInboxStore((state) => state.status);
  const errorMessage = useInboxStore((state) => state.errorMessage);
  const refresh = useInboxStore((state) => state.refresh);
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const openSideThread = useSideThreadStore((state) => state.open);
  const navigate = useNavigate();

  useEffect(() => {
    if (!environmentId) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    void refresh(api);
  }, [environmentId, refresh]);

  const grouped = useMemo(() => groupItemsByParentThread(items), [items]);

  const openInboxItem = (item: InboxItem) => {
    if (!environmentId) return;
    const params = buildThreadRouteParams(
      scopeThreadRef(environmentId, item.parentThreadId as ThreadId),
    );
    openSideThread({
      parentThreadId: item.parentThreadId,
      anchorMessageId: item.anchorMessageId as unknown as Parameters<
        typeof openSideThread
      >[0]["anchorMessageId"],
    });
    void navigate({
      to: "/$environmentId/$threadId",
      params,
    });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <AtSignIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Mentions</span>
          <Badge variant="secondary" className="ml-1 rounded-md px-1.5 py-0 text-[10px]">
            {items.length}
          </Badge>
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
                      <li key={item.sideThreadId}>
                        <button
                          type="button"
                          onClick={() => openInboxItem(item)}
                          className={cn(
                            "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
