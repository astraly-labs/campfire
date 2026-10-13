import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AtSignIcon, BellIcon, CheckCheckIcon, InboxIcon, MessageCircleIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { CollaborationAvatar } from "../collaboration/CollaborationAvatar";
import { useGoogleTeam } from "../collaboration/googleTeam";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { deriveTeamInboxItems } from "../inbox/teamInbox";
import { useSideThreadUiStore } from "../sidethread/sideThreadUiStore";
import { useThreadShells } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  requestTeamNotificationPermission,
  teamNotificationPermission,
} from "../notifications/teamInboxNotifications";

function TeamInboxRouteView() {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const team = useGoogleTeam(environmentId);
  const threads = useThreadShells();
  const requestOpen = useSideThreadUiStore((state) => state.requestOpen);
  const markRead = useAtomCommand(threadEnvironment.markSideThreadRead, {
    reportDefect: false,
    reportFailure: false,
  });
  const [markingAll, setMarkingAll] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState(() =>
    teamNotificationPermission(),
  );
  const items = useMemo(
    () =>
      deriveTeamInboxItems({
        threads,
        environmentId,
        currentSubject: team.current?.subject ?? null,
      }),
    [environmentId, team.current?.subject, threads],
  );
  const unreadItems = items.filter((item) => item.unread);

  const openItem = (item: (typeof items)[number]) => {
    const threadRef = scopeThreadRef(item.thread.environmentId, item.thread.id);
    requestOpen(threadRef);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };

  const markAllRead = async () => {
    if (markingAll) return;
    setMarkingAll(true);
    await Promise.all(
      unreadItems.map((item) =>
        markRead({
          environmentId: item.thread.environmentId,
          input: {
            threadId: item.thread.id,
            sideThreadId: item.discussion.id,
            lastReadAt: item.discussion.latestMessage!.createdAt,
          },
        }),
      ),
    );
    setMarkingAll(false);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b px-3 py-2 sm:px-5 sm:py-3">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <InboxIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Inbox</span>
          <span className="text-xs text-muted-foreground">{unreadItems.length} unread</span>
          {notificationPermission === "default" ? (
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto"
              onClick={() =>
                void requestTeamNotificationPermission().then(setNotificationPermission)
              }
            >
              <BellIcon className="size-3.5" />
              Enable notifications
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            className={notificationPermission === "default" ? undefined : "ml-auto"}
            disabled={unreadItems.length === 0 || markingAll}
            onClick={() => void markAllRead()}
          >
            <CheckCheckIcon className="size-3.5" />
            Mark all read
          </Button>
        </header>

        {items.length === 0 ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>No team messages yet</EmptyTitle>
              <EmptyDescription>
                Mentions and activity from discussions you participate in will appear here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
            <div className="mx-auto flex max-w-3xl flex-col gap-2">
              {items.map((item) => (
                <button
                  key={`${item.thread.environmentId}:${item.thread.id}`}
                  type="button"
                  onClick={() => openItem(item)}
                  className="group flex w-full items-start gap-3 rounded-xl border bg-card/50 p-3 text-left transition-colors hover:bg-accent/60"
                >
                  <CollaborationAvatar user={item.preview.author} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{item.thread.title}</span>
                      {item.isMention ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                          <AtSignIcon className="size-3" /> mention
                        </span>
                      ) : (
                        <MessageCircleIcon className="size-3.5 text-muted-foreground" />
                      )}
                      {item.unread ? (
                        <span className="ml-auto size-2 shrink-0 rounded-full bg-primary" />
                      ) : null}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground/80">
                        {item.preview.author.displayName}
                      </span>
                      <span>{formatRelativeTimeLabel(item.preview.createdAt)}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-muted-foreground">
                      {item.preview.text ||
                        (item.preview.hasAttachments ? "Attachment" : "Message")}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/inbox")({
  component: TeamInboxRouteView,
});
