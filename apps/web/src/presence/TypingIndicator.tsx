import type { UserRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { cn } from "~/lib/utils";

interface Props {
  /** Users currently typing in the surface this indicator is attached to.
   * The caller is responsible for filtering out the current user and for
   * narrowing to the right typing focus ("parent" vs "side"). */
  readonly users: ReadonlyArray<UserRef>;
  /** Override the wrapper className — useful when the surrounding layout
   * needs different padding than the default. */
  readonly className?: string;
}

/**
 * Compact "Alice is typing…" row, sized to a fixed height so the parent
 * layout doesn't jump when the indicator appears or disappears mid-frame.
 *
 * Driven by the existing presence/typing pipeline:
 *   composer.onChange → notifyTyping(focus) → heartbeat (~4s) →
 *   server TTL (3.5s, auto-clears stale flags) → presence snapshot →
 *   useViewersOfParentThread / useViewersOfSideThread → here.
 *
 * Phrasing follows Slack/Discord conventions, capped at 2 explicit names
 * before falling back to a count.
 */
export function TypingIndicator({ users, className }: Props) {
  const label = useMemo(() => buildLabel(users), [users]);

  return (
    <div
      aria-live="polite"
      className={cn(
        "flex h-4 shrink-0 items-center gap-1.5 px-3 text-[11px] text-muted-foreground/70",
        className,
      )}
    >
      {label ? (
        <>
          <span className="inline-flex items-center gap-[3px]" aria-hidden>
            <span className="h-1 w-1 rounded-full bg-muted-foreground/40 animate-pulse" />
            <span className="h-1 w-1 rounded-full bg-muted-foreground/40 animate-pulse [animation-delay:200ms]" />
            <span className="h-1 w-1 rounded-full bg-muted-foreground/40 animate-pulse [animation-delay:400ms]" />
          </span>
          <span className="truncate">{label}</span>
        </>
      ) : null}
    </div>
  );
}

function buildLabel(users: ReadonlyArray<UserRef>): string | null {
  if (users.length === 0) return null;
  if (users.length === 1) return `${users[0]!.displayName} is typing…`;
  if (users.length === 2) {
    return `${users[0]!.displayName} and ${users[1]!.displayName} are typing…`;
  }
  const rest = users.length - 2;
  return `${users[0]!.displayName}, ${users[1]!.displayName} and ${rest} other${rest === 1 ? "" : "s"} are typing…`;
}
