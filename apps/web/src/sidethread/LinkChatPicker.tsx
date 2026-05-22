/**
 * LinkChatPicker — tiny popover that lets the composer attach a {@link LinkedRef}
 * to a side-thread message. Lists the workspace-wide global chat plus the
 * 10 most recently updated agent threads; clicking an entry hands a typed
 * {@link LinkedRef} back to the parent and closes the popover.
 *
 * Kept narrow on purpose: no search, no project grouping, no recents. The
 * common case is "link the conversation I just left", which the recency
 * sort already nails. If users start scrolling past 10 we can revisit.
 */
import type { LinkedRef, ThreadId } from "@t3tools/contracts";
import { HashIcon, MessageSquareIcon } from "lucide-react";
import { useMemo } from "react";

import { usePrimaryEnvironmentId } from "../environments/primary";
import { useStore } from "../store";
import { cn } from "~/lib/utils";

export const MAX_LINK_PICKER_THREADS = 10;

interface Props {
  readonly open: boolean;
  readonly onPick: (linkedRef: LinkedRef) => void;
  readonly onClose: () => void;
  /**
   * When set, hides this thread id from the suggestions — used by the
   * per-thread side drawer to avoid offering "link the conversation you're
   * already in".
   */
  readonly excludeThreadId?: ThreadId | null;
}

export function LinkChatPicker({ open, onPick, onClose, excludeThreadId }: Props) {
  // Reading the full record + slicing in a memo is cheaper than a Zustand
  // selector that returns a freshly-sliced array (would re-render every
  // unrelated store mutation).
  const environmentId = usePrimaryEnvironmentId();
  const threadShellById = useStore((state) =>
    environmentId ? state.environmentStateById[environmentId]?.threadShellById ?? null : null,
  );
  const threadCandidates = useMemo(() => {
    if (!threadShellById) return [];
    const list = Object.values(threadShellById).filter(
      (shell) =>
        shell.archivedAt === null && (!excludeThreadId || shell.id !== excludeThreadId),
    );
    // `updatedAt` is optional on ThreadShell (shell stream sometimes omits
    // it for freshly-created rows); fall back to `createdAt` so brand-new
    // threads still sort to the top instead of being grouped together.
    const sortKey = (shell: { updatedAt?: string | undefined; createdAt: string }) =>
      shell.updatedAt ?? shell.createdAt;
    list.sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      return ka < kb ? 1 : ka > kb ? -1 : 0;
    });
    return list.slice(0, MAX_LINK_PICKER_THREADS);
  }, [threadShellById, excludeThreadId]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Link a chat"
      className="absolute bottom-[calc(100%-0.25rem)] left-3 right-3 z-10 max-h-64 overflow-y-auto rounded-md border border-border/70 bg-popover shadow-lg"
    >
      <button
        type="button"
        onMouseDown={(event) => {
          event.preventDefault();
          onPick({ kind: "global-chat" });
          onClose();
        }}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/60",
        )}
      >
        <HashIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Global chat</span>
        <span className="ml-auto text-[10px] text-muted-foreground/60">workspace</span>
      </button>
      {threadCandidates.length > 0 ? (
        <div className="border-t border-border/40 px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
          Recent threads
        </div>
      ) : null}
      {threadCandidates.map((shell) => (
        <button
          key={shell.id}
          type="button"
          onMouseDown={(event) => {
            event.preventDefault();
            onPick({ kind: "agent-thread", threadId: shell.id });
            onClose();
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent/60"
        >
          <MessageSquareIcon className="size-3.5 text-muted-foreground" />
          <span className="truncate">{shell.title}</span>
        </button>
      ))}
      {threadCandidates.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground/60">
          No other conversations yet.
        </div>
      ) : null}
    </div>
  );
}
