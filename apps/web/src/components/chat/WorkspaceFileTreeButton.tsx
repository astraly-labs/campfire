import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { FolderTreeIcon } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { selectProjectByRef, selectThreadByRef, useStore } from "../../store";
import { useWorkspaceFileTreeStore } from "../../preview/workspaceFileTreeStore";

interface Props {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export function WorkspaceFileTreeButton({ environmentId, threadId }: Props) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const projectCwd = useStore(
    useShallow((state) => {
      const thread = selectThreadByRef(state, threadRef);
      if (!thread) return undefined;
      const project = selectProjectByRef(state, {
        environmentId: thread.environmentId,
        projectId: thread.projectId,
      });
      return project?.cwd;
    }),
  );
  const open = useWorkspaceFileTreeStore((s) => s.open);
  const currentCwd = useWorkspaceFileTreeStore((s) => s.cwd);
  const openDrawer = useWorkspaceFileTreeStore((s) => s.openDrawer);
  const closeDrawer = useWorkspaceFileTreeStore((s) => s.closeDrawer);

  const pressed = open && currentCwd === projectCwd;
  const disabled = !projectCwd;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0"
            aria-label="Browse workspace files"
            variant="outline"
            size="xs"
            pressed={pressed}
            disabled={disabled}
            onPressedChange={(next) => {
              if (!projectCwd) return;
              if (next) openDrawer(projectCwd);
              else closeDrawer();
            }}
          >
            <FolderTreeIcon className="size-3" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {disabled ? "Files panel is unavailable without an active project." : "Browse files"}
      </TooltipPopup>
    </Tooltip>
  );
}
