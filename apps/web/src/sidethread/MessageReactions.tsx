import type { SideThreadMessageReaction, UserRef } from "@t3tools/contracts";
import { SmilePlusIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { ReactionPicker } from "./ReactionPicker";

interface Props {
  readonly reactions: ReadonlyArray<SideThreadMessageReaction>;
  readonly currentUserId: UserRef["id"] | undefined;
  readonly onToggle: (emoji: string) => void;
}

/**
 * Inline reaction row rendered under every side-thread message. Empty
 * messages render only the discreet "add" button — it materialises on row
 * hover so quiet messages stay quiet.
 *
 * A chip lights up amber when the current user has reacted with that
 * emoji; clicking it toggles, mirroring Slack's affordance.
 */
export function MessageReactions({ reactions, currentUserId, onToggle }: Props) {
  const hasAny = reactions.length > 0;
  return (
    <div
      className={cn(
        "mt-0.5 flex flex-wrap items-center gap-1",
        // Keep the bottom-row "+" affordance from creating dead vertical
        // space on quiet messages — the row stays 0-height until the
        // parent message-row hovers.
        !hasAny && "h-0 overflow-hidden opacity-0 transition-opacity group-hover/msg:h-auto group-hover/msg:opacity-100",
      )}
    >
      {reactions.map((bucket) => {
        const userReacted =
          currentUserId !== undefined && bucket.users.some((u) => u.id === currentUserId);
        const title = bucket.users.map((u) => u.displayName).join(", ");
        return (
          <button
            key={bucket.emoji}
            type="button"
            title={title}
            onClick={() => onToggle(bucket.emoji)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] leading-none transition-colors",
              userReacted
                ? "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                : "border-border/50 bg-background/40 text-foreground/70 hover:bg-background/70",
            )}
          >
            <span className="text-[13px] leading-none">{bucket.emoji}</span>
            <span className="font-medium tabular-nums">{bucket.users.length}</span>
          </button>
        );
      })}
      <ReactionPicker
        onPick={onToggle}
        trigger={
          <button
            type="button"
            aria-label="Add reaction"
            className={cn(
              "inline-flex size-5 items-center justify-center rounded-full border border-border/50 bg-background/40 text-muted-foreground/70 hover:text-foreground",
              // When there are no chips, only show on row hover (handled by
              // the wrapper above). When chips exist, also fade in on
              // message hover so it doesn't compete with the existing
              // emojis at rest.
              hasAny && "opacity-0 transition-opacity group-hover/msg:opacity-100",
            )}
          >
            <SmilePlusIcon className="size-3" />
          </button>
        }
      />
    </div>
  );
}
