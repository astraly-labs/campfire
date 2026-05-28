/**
 * `/inbox` — Slack-style unified inbox. One chronological feed shows everything
 * that needs the user's attention (mentions + activity), grouped by calendar
 * day. A filter bar narrows the feed to Unread / Mentions / Activity without
 * leaving the page. Clicking a row deep-links into the parent thread and pops
 * the side-thread drawer on the anchor message.
 */
import { scopeThreadRef } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { InboxItem, ThreadId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AtSignIcon, CheckCheckIcon, InboxIcon, MessagesSquareIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { toastManager } from "../components/ui/toast";
import { ensureEnvironmentApi, readEnvironmentApi } from "../environmentApi";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { retainThreadDetailSubscription } from "../environments/runtime/service";
import { useCurrentUser } from "../identity/identityStore";
import {
  type InboxFilter,
  type InboxRow,
  useActivityUnreadCount,
  useInboxRows,
  useInboxStore,
  useInboxUnreadCount,
  useMentionUnreadCount,
} from "../inbox/inboxStore";
import { selectThreadExistsByRef, selectThreadMissingByRef, useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatDayGroupLabel, formatRelativeTimeLabel, startOfDay } from "../timestampFormat";
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

const INBOX_FILTERS: ReadonlyArray<{ readonly value: InboxFilter; readonly label: string }> = [
  { value: "all", label: "Tout" },
  { value: "unread", label: "Non lus" },
  { value: "mention", label: "Mentions" },
  { value: "activity", label: "Activité" },
];

const EMPTY_COPY: Record<InboxFilter, { readonly title: string; readonly description: string }> = {
  all: {
    title: "Boîte de réception vide",
    description: "Les mentions et les nouveaux messages de vos fils apparaîtront ici.",
  },
  unread: {
    title: "Tout est lu",
    description: "Aucun élément non lu pour le moment.",
  },
  mention: {
    title: "Aucune mention",
    description: "Quand un coéquipier vous tague @vous dans un fil, le message apparaît ici.",
  },
  activity: {
    title: "Aucune nouvelle activité",
    description: "Les nouveaux messages dans les fils où vous participez apparaissent ici.",
  },
};

function isInboxFilter(value: string | undefined): value is InboxFilter {
  return value === "all" || value === "unread" || value === "mention" || value === "activity";
}

function InboxRouteView() {
  const environmentId = usePrimaryEnvironmentId();
  const status = useInboxStore((state) => state.status);
  const errorMessage = useInboxStore((state) => state.errorMessage);
  const refresh = useInboxStore((state) => state.refresh);
  const dismiss = useInboxStore((state) => state.dismiss);
  const markThreadsVisited = useUiStateStore((state) => state.markThreadsVisited);
  const currentUser = useCurrentUser();
  const openSideThread = useSideThreadStore((state) => state.open);
  const navigate = useNavigate();

  const [filter, setFilter] = useState<InboxFilter>("all");
  const rows = useInboxRows(filter);
  const allUnread = useInboxUnreadCount();
  const mentionUnread = useMentionUnreadCount();
  const activityUnread = useActivityUnreadCount();

  const dayGroups = useMemo(() => groupRowsByDay(rows), [rows]);
  const visibleUnread = useMemo(
    () => rows.reduce((total, row) => total + (row.unread ? 1 : 0), 0),
    [rows],
  );

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

  const markAllVisibleRead = () => {
    markThreadsVisited(
      rows.map((row) => ({ threadId: row.item.sideThreadId, visitedAt: row.item.lastActivityAt })),
    );
  };

  const onDismiss = (item: InboxItem) => {
    if (!environmentId || !currentUser) return;
    void dismiss(ensureEnvironmentApi(environmentId), item.sideThreadId, currentUser.id);
  };

  const tabBadge = (value: InboxFilter): number => {
    if (value === "all") return allUnread;
    if (value === "mention") return mentionUnread;
    if (value === "activity") return activityUnread;
    return 0;
  };

  const empty = EMPTY_COPY[filter];

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

        <div className="flex items-center gap-2 border-b border-border px-3 py-2 sm:px-5">
          <ToggleGroup
            variant="outline"
            size="xs"
            value={[filter]}
            onValueChange={(value) => {
              const next = value[0];
              if (isInboxFilter(next)) setFilter(next);
            }}
          >
            {INBOX_FILTERS.map((tab) => {
              const badge = tabBadge(tab.value);
              return (
                <Toggle key={tab.value} value={tab.value} aria-label={tab.label}>
                  {tab.value === "mention" ? <AtSignIcon className="size-3.5" /> : null}
                  {tab.value === "activity" ? <MessagesSquareIcon className="size-3.5" /> : null}
                  {tab.label}
                  {badge > 0 ? (
                    <Badge
                      variant="secondary"
                      className="ml-0.5 rounded-md px-1 py-0 text-[10px] tabular-nums"
                    >
                      {badge}
                    </Badge>
                  ) : null}
                </Toggle>
              );
            })}
          </ToggleGroup>
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={visibleUnread === 0}
            onClick={markAllVisibleRead}
          >
            <CheckCheckIcon className="size-3.5" />
            Tout marquer comme lu
          </Button>
        </div>

        {errorMessage ? (
          <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
            {errorMessage}
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto">
          {status === "loading" && rows.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground/60">Chargement…</div>
          ) : rows.length === 0 ? (
            <Empty className="py-12">
              <EmptyHeader className="max-w-md">
                <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                  <InboxIcon className="size-5" />
                </div>
                <EmptyTitle className="text-foreground text-lg">{empty.title}</EmptyTitle>
                <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                  {empty.description}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div>
              {dayGroups.map((group) => (
                <section key={group.key}>
                  <div className="sticky top-0 z-10 border-b border-border/40 bg-background/95 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70 backdrop-blur">
                    {group.label}
                  </div>
                  <ul className="divide-y divide-border/30">
                    {group.rows.map((row) => (
                      <InboxRowItem
                        key={row.item.sideThreadId}
                        row={row}
                        onOpen={openInboxItem}
                        onDismiss={onDismiss}
                        dismissDisabled={!environmentId || !currentUser}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

interface InboxRowItemProps {
  readonly row: InboxRow;
  readonly onOpen: (item: InboxItem) => void | Promise<void>;
  readonly onDismiss: (item: InboxItem) => void;
  readonly dismissDisabled: boolean;
}

function InboxRowItem({ row, onOpen, onDismiss, dismissDisabled }: InboxRowItemProps) {
  const { item, isMention, dismissable, unread } = row;
  const TypeIcon = isMention ? AtSignIcon : MessagesSquareIcon;

  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => {
          void onOpen(item);
        }}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          dismissable && "pr-12",
          unread && "bg-amber-500/5",
        )}
      >
        <span
          className={cn(
            "mt-1.5 size-2 shrink-0 rounded-full",
            unread ? "bg-amber-500" : "bg-transparent",
          )}
          aria-label={unread ? "non lu" : "lu"}
        />
        <TypeIcon
          className={cn(
            "mt-0.5 size-4 shrink-0",
            isMention ? "text-amber-500/80" : "text-muted-foreground/70",
          )}
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-foreground">
              {item.lastAuthor.displayName}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground/60">
              {formatRelativeTimeLabel(item.lastActivityAt)}
            </span>
          </div>
          <p className="line-clamp-2 text-sm text-foreground/75">{item.lastPreview}</p>
          {item.count > 1 ? (
            <span className="text-[10px] text-muted-foreground/60">
              {isMention
                ? `${item.count} mentions dans ce fil`
                : `${item.count} messages dans ce fil`}
            </span>
          ) : null}
        </div>
      </button>
      {dismissable ? (
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

interface InboxDayGroup {
  /** Local start-of-day epoch ms — the grouping key. */
  readonly key: number;
  /** Human label for the date separator ("Aujourd'hui", "Hier", "vendredi", "22 mai"). */
  readonly label: string;
  readonly rows: InboxRow[];
}

/**
 * Bucket the (already most-recent-first) rows by calendar day so the feed gets
 * Slack-style date separators. Consecutive same-day rows fall into one group.
 */
function groupRowsByDay(rows: ReadonlyArray<InboxRow>): InboxDayGroup[] {
  const groups: InboxDayGroup[] = [];
  let current: InboxDayGroup | null = null;
  for (const row of rows) {
    const key = startOfDay(new Date(row.item.lastActivityAt));
    if (!current || current.key !== key) {
      current = {
        key,
        label: formatDayGroupLabel(row.item.lastActivityAt, {
          locale: "fr",
          todayLabel: "Aujourd'hui",
          yesterdayLabel: "Hier",
        }),
        rows: [],
      };
      groups.push(current);
    }
    current.rows.push(row);
  }
  return groups;
}

export const Route = createFileRoute("/_chat/inbox")({
  component: InboxRouteView,
});
