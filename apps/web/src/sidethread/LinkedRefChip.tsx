/**
 * LinkedRefChip — inline clickable card that renders a {@link LinkedRef}
 * (the "link a chat" affordance) inside a side-thread message. The chip
 * resolves the target title from the store and navigates on click; the
 * variant prop lets composer previews ("you're about to link this") use the
 * same primitive without the navigation behaviour.
 */
import { useNavigate } from "@tanstack/react-router";
import type { LinkedRef } from "@t3tools/contracts";
import { HashIcon, MessageSquareIcon, XIcon } from "lucide-react";

import { scopeThreadRef } from "@t3tools/client-runtime";

import { usePrimaryEnvironmentId } from "../environments/primary";
import { useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { cn } from "~/lib/utils";

interface Props {
  readonly linkedRef: LinkedRef;
  /** When set, renders a small "remove" button calling this on click. */
  readonly onRemove?: () => void;
}

export function LinkedRefChip({ linkedRef, onRemove }: Props) {
  const environmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const threadTitle = useStore((state) => {
    if (linkedRef.kind !== "agent-thread") return null;
    if (!environmentId) return null;
    return state.environmentStateById[environmentId]?.threadShellById[linkedRef.threadId]?.title
      ?? null;
  });

  const handleClick = () => {
    if (linkedRef.kind === "global-chat") {
      void navigate({ to: "/global" });
      return;
    }
    if (!environmentId) return;
    const threadRef = scopeThreadRef(environmentId, linkedRef.threadId);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };

  const label =
    linkedRef.kind === "global-chat"
      ? "Global chat"
      : threadTitle ?? `Thread ${linkedRef.threadId.slice(0, 8)}`;
  const Icon = linkedRef.kind === "global-chat" ? HashIcon : MessageSquareIcon;

  return (
    <div
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2 py-1 text-xs",
        "hover:border-border hover:bg-background",
      )}
    >
      <button
        type="button"
        onClick={handleClick}
        className="flex min-w-0 items-center gap-1.5 text-left text-foreground/80 hover:text-foreground"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
      </button>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove link"
          className="text-muted-foreground/60 hover:text-foreground"
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </div>
  );
}
