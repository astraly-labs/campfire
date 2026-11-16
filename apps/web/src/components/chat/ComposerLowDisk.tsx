import type { EnvironmentId, ServerLowDiskVolume } from "@t3tools/contracts";
import { lowDiskNotice } from "@t3tools/client-runtime/low-disk-notice";
import { HardDriveIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function lowDiskBannerItem(
  environmentId: EnvironmentId,
  volumes: ReadonlyArray<ServerLowDiskVolume> | undefined,
  onOpenStorageSettings: () => void,
): ComposerBannerStackItem | null {
  const notice = lowDiskNotice(volumes);
  if (!notice) return null;
  return {
    id: `low-disk:${environmentId}`,
    variant: "warning",
    icon: <HardDriveIcon />,
    title: (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="block max-w-full cursor-help truncate rounded-sm text-left"
            >
              {notice.title}
            </button>
          }
        />
        <TooltipPopup side="top">{notice.paths.join(", ")}</TooltipPopup>
      </Tooltip>
    ),
    description: notice.description,
    actions: (
      <Button size="xs" variant="ghost" onClick={onOpenStorageSettings}>
        Storage settings
      </Button>
    ),
  };
}
