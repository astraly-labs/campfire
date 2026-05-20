import type { SideThreadId, SideThreadStreamItem, ThreadId } from "@t3tools/contracts";
import { MessageCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ensureEnvironmentApi } from "../environmentApi";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { useCurrentUser } from "../identity/identityStore";
import { isInboxItemUnread, useInboxStore } from "../inbox/inboxStore";
import { AvatarStack } from "../presence/AvatarStack";
import { useViewersOfSideThread } from "../presence/presenceStore";
import { useUiStateStore } from "../uiStateStore";
import { cn } from "~/lib/utils";
import { deriveSideThreadId, useSideThreadStore } from "./sideThreadStore";

interface Props {
  readonly threadId: ThreadId;
}

/**
 * Header toggle for the (single) side thread of the active parent
 * conversation. Subscribes directly to `subscribeSideThread` to surface a
 * live message count + viewer avatars; the inbox store provides the
 * unread-mention dot.
 *
 * Subscribing here is cheap — the engine already keeps the snapshot in
 * memory and the WS layer multiplexes the stream so a second subscriber
 * (e.g. the drawer) hits the same source.
 */
export function ChatHeaderSideThreadToggle({ threadId }: Props) {
  const environmentId = usePrimaryEnvironmentId();
  const currentUser = useCurrentUser();
  const sideThreadId = deriveSideThreadId(threadId);
  const openParentThreadId = useSideThreadStore((state) => state.openParentThreadId);
  const open = useSideThreadStore((state) => state.open);
  const close = useSideThreadStore((state) => state.close);

  const [messageCount, setMessageCount] = useState(0);

  useEffect(() => {
    if (!environmentId || !currentUser) {
      setMessageCount(0);
      return;
    }
    setMessageCount(0);
    let cancelled = false;
    const api = ensureEnvironmentApi(environmentId);
    const unsubscribe = api.sideThread.subscribe(
      { sideThreadId },
      (item: SideThreadStreamItem) => {
        if (cancelled) return;
        if (item.kind === "snapshot") {
          setMessageCount(item.snapshot.sideThread.messages.length);
        } else if (item.event.type === "sidethread.message-posted") {
          setMessageCount((current) => current + 1);
        }
      },
      {
        // The aggregate may not exist yet (no human has opened the drawer
        // on this conversation). The stream errors with "not found" in that
        // case — swallow it and keep the count at 0 until someone creates
        // the side thread by opening the drawer.
      },
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [environmentId, currentUser, sideThreadId]);

  const inboxItem = useInboxStore((state) =>
    state.items.find((it) => it.sideThreadId === sideThreadId),
  );
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const hasUnreadMention = inboxItem ? isInboxItemUnread(inboxItem, lastVisitedAtById) : false;

  const viewers = useViewersOfSideThread(sideThreadId as SideThreadId);

  const isOpen = openParentThreadId === threadId;

  return (
    <button
      type="button"
      onClick={() => (isOpen ? close() : open(threadId))}
      title={isOpen ? "Close side thread" : "Open side thread"}
      aria-label={isOpen ? "Close side thread" : "Open side thread"}
      aria-pressed={isOpen}
      className={cn(
        "relative inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2 py-1 text-[11px] transition-colors",
        isOpen
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <MessageCircleIcon className="size-3.5" aria-hidden />
      <span className="font-medium tabular-nums">{messageCount}</span>
      {viewers.length > 0 ? (
        <AvatarStack viewers={viewers} maxVisible={3} size="sm" className="ml-0.5" />
      ) : null}
      {hasUnreadMention ? (
        <span
          aria-hidden
          className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-red-500 ring-2 ring-background"
        />
      ) : null}
    </button>
  );
}
