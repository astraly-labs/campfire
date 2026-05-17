import type { MessageId, ThreadId } from "@t3tools/contracts";

import { useSideThreadStore } from "./sideThreadStore";

interface Props {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

/**
 * Small inline action attached to an agent message. Opens (or focuses)
 * the side-thread anchored on that message.
 */
export function SideThreadAnchorButton({ threadId, messageId }: Props) {
  const open = useSideThreadStore((state) => state.open);
  return (
    <button
      type="button"
      title="Discuter (side thread)"
      onClick={() => open({ parentThreadId: threadId, anchorMessageId: messageId })}
      className="rounded p-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800"
    >
      💬
    </button>
  );
}
