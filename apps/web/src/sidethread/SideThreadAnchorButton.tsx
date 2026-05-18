import type { MessageId, SideThreadId, ThreadId } from "@t3tools/contracts";
import { MessageCircleIcon, MessageCirclePlusIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { isInboxItemUnread, useInboxStore } from "../inbox/inboxStore";
import { AvatarStack } from "../presence/AvatarStack";
import { useViewersOfSideThread } from "../presence/presenceStore";
import { useUiStateStore } from "../uiStateStore";
import { deriveSideThreadId, useSideThreadStore, useSideThreadSummaryFor } from "./sideThreadStore";

interface Props {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

/**
 * Inline anchor attached to each agent message. Renders one of two
 * affordances based on whether a side thread already exists on that
 * message:
 *
 *  - **Create** — `MessageCirclePlus`, hover-revealed and muted. The
 *    parent timeline groups itself as `group/assistant`, so the button
 *    stays out of the way until the user hovers the message.
 *  - **Open** — `MessageCircle` with the live message count, always
 *    visible so unread/active discussions are surfaced.
 *
 * The button always calls `open(anchor)` — the drawer is responsible for
 * idempotently creating the aggregate on first activation (server enforces
 * uniqueness by deterministic id).
 */
export function SideThreadAnchorButton({ threadId, messageId }: Props) {
  const open = useSideThreadStore((state) => state.open);
  const summary = useSideThreadSummaryFor(messageId);
  const exists = summary !== null && summary.archivedAt === null;
  const messageCount = summary?.messageCount ?? 0;

  const sideThreadId = deriveSideThreadId({ parentThreadId: threadId, anchorMessageId: messageId });
  // Show a red dot when the inbox knows about a mention on this side thread
  // that the current user has not yet seen (visited timestamp older than the
  // last mention). The inbox stream keeps this live without polling.
  const inboxItem = useInboxStore((state) =>
    state.items.find((it) => it.sideThreadId === sideThreadId),
  );
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const hasUnreadMention = inboxItem ? isInboxItemUnread(inboxItem, lastVisitedAtById) : false;
  const viewers = useViewersOfSideThread(sideThreadId as SideThreadId);

  return (
    <button
      type="button"
      title={
        exists
          ? `View thread (${messageCount} message${messageCount > 1 ? "s" : ""})${
              hasUnreadMention ? " — you have an unread mention" : ""
            }`
          : "Start a thread"
      }
      aria-label={exists ? "Open side thread" : "Start a side thread"}
      onClick={() => open({ parentThreadId: threadId, anchorMessageId: messageId })}
      className={cn(
        "relative inline-flex items-center gap-1 rounded p-1 text-[10px] transition-opacity duration-200",
        "hover:bg-muted hover:text-foreground",
        exists
          ? "text-muted-foreground/70 opacity-100"
          : "text-muted-foreground/45 opacity-0 group-hover/assistant:opacity-100 focus-visible:opacity-100",
      )}
    >
      {exists ? (
        <>
          <MessageCircleIcon className="size-3.5" aria-hidden />
          {messageCount > 0 ? (
            <span className="font-medium tabular-nums">{messageCount}</span>
          ) : null}
        </>
      ) : (
        <MessageCirclePlusIcon className="size-3.5" aria-hidden />
      )}
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
