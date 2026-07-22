import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";

import { useGoogleTeam } from "../collaboration/googleTeam";
import { deriveTeamInboxItems, type TeamInboxItem } from "../inbox/teamInbox";
import { useSideThreadUiStore } from "../sidethread/sideThreadUiStore";
import { useThreadShells } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { buildThreadRouteParams } from "../threadRoutes";

function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function teamNotificationPermission(): NotificationPermission | "unsupported" {
  return notificationsSupported() ? Notification.permission : "unsupported";
}

export async function requestTeamNotificationPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (!notificationsSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

function messageKey(item: TeamInboxItem): string {
  return `${item.thread.environmentId}:${item.thread.id}:${item.preview.id}`;
}

export function newUnreadTeamInboxItems(
  previousKeys: ReadonlySet<string>,
  items: ReadonlyArray<TeamInboxItem>,
): ReadonlyArray<TeamInboxItem> {
  return items.filter((item) => item.unread && !previousKeys.has(messageKey(item)));
}

function appIsBackgrounded(): boolean {
  return document.hidden || (typeof document.hasFocus === "function" && !document.hasFocus());
}

export function useTeamInboxNotifications() {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const team = useGoogleTeam(environmentId);
  const threads = useThreadShells();
  const requestOpen = useSideThreadUiStore((state) => state.requestOpen);
  const items = useMemo(
    () =>
      deriveTeamInboxItems({
        threads,
        environmentId,
        currentSubject: team.current?.subject ?? null,
      }),
    [environmentId, team.current?.subject, threads],
  );
  const previousKeysRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    const nextKeys = new Set(items.map(messageKey));
    const previousKeys = previousKeysRef.current;
    previousKeysRef.current = nextKeys;
    if (
      previousKeys === null ||
      teamNotificationPermission() !== "granted" ||
      !appIsBackgrounded()
    ) {
      return;
    }

    for (const item of newUnreadTeamInboxItems(previousKeys, items)) {
      let notification: Notification;
      try {
        notification = new Notification(
          item.isMention
            ? `${item.preview.author.displayName} mentioned you`
            : `New message from ${item.preview.author.displayName}`,
          {
            body: item.preview.text || (item.preview.hasAttachments ? "Attachment" : "Message"),
            tag: `campfire:${item.thread.environmentId}:${item.thread.id}`,
          },
        );
      } catch {
        continue;
      }
      notification.addEventListener(
        "click",
        () => {
          try {
            window.focus();
          } catch {
            // Best-effort on platforms that do not expose window focus.
          }
          const threadRef = scopeThreadRef(item.thread.environmentId, item.thread.id);
          requestOpen(threadRef);
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          });
          notification.close();
        },
        { once: true },
      );
    }
  }, [items, navigate, requestOpen]);
}
