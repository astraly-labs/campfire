import type { PresenceEntry } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

const PALETTE = [
  "bg-amber-200 text-amber-900",
  "bg-emerald-200 text-emerald-900",
  "bg-sky-200 text-sky-900",
  "bg-violet-200 text-violet-900",
  "bg-rose-200 text-rose-900",
] as const;

export function presenceColorIndex(subject: string): number {
  let hash = 2166136261;
  for (let index = 0; index < subject.length; index += 1) {
    hash ^= subject.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % PALETTE.length;
}

export function presenceInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return `${parts[0]!.slice(0, 1)}${parts.at(-1)!.slice(0, 1)}`.toUpperCase();
}

export function PresenceAvatarStack({ viewers }: { viewers: ReadonlyArray<PresenceEntry> }) {
  if (viewers.length === 0) return null;
  const visible = viewers.slice(0, 5);
  return (
    <div className="flex shrink-0 items-center" aria-label="People viewing this task">
      {visible.map((viewer) => (
        <Tooltip key={viewer.sessionId}>
          <TooltipTrigger
            render={
              <span
                className={cn(
                  "-ml-1.5 inline-flex size-5 first:ml-0 items-center justify-center rounded-full text-[9px] font-semibold ring-2 ring-background",
                  PALETTE[presenceColorIndex(viewer.user.subject)],
                  viewer.typing && "animate-pulse ring-amber-400 motion-reduce:animate-none",
                )}
              >
                {presenceInitials(viewer.user.displayName)}
              </span>
            }
          />
          <TooltipPopup side="bottom">
            {viewer.user.displayName}
            {viewer.typing ? " — typing…" : ""}
          </TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}
