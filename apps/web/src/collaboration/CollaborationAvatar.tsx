import type { CollaborationUser } from "@t3tools/contracts";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { presenceColorIndex, presenceInitials } from "../presence/PresenceAvatarStack";

const COLOR_CLASSES = [
  "bg-amber-200 text-amber-900",
  "bg-emerald-200 text-emerald-900",
  "bg-sky-200 text-sky-900",
  "bg-violet-200 text-violet-900",
  "bg-rose-200 text-rose-900",
] as const;

export function CollaborationAvatar(props: {
  readonly user: CollaborationUser;
  readonly size?: "xs" | "sm";
  readonly labelPrefix?: string;
  readonly className?: string;
}) {
  const { user, size = "sm", labelPrefix = "Created by", className } = props;
  const label = `${labelPrefix} ${user.displayName}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            className={cn(
              "inline-flex shrink-0 items-center justify-center rounded-full font-semibold ring-1 ring-background",
              size === "xs" ? "size-4 text-[8px]" : "size-6 text-[10px]",
              COLOR_CLASSES[presenceColorIndex(user.subject)],
              className,
            )}
          />
        }
      >
        {presenceInitials(user.displayName)}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
