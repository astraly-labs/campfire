import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { GitForkIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useForkThreadToProject } from "../../hooks/useForkThreadToProject";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectFavicon } from "../ProjectFavicon";

interface ForkThreadButtonProps {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceProjectId: ProjectId;
  readonly sourceModelSelection: ModelSelection;
}

/**
 * Header-level entry point for the "fork conversation to another project"
 * flow. Same-environment only — cross-environment handoff is unsupported
 * because the source transcript only lives on the source-side WS connection.
 *
 * Rendered as a small outline button with a dropdown listing target projects.
 * The button hides itself when there is no other project the user could fork
 * into (single-project setups don't need it); avoids the rarely-used dead
 * icon problem.
 */
export const ForkThreadButton = memo(function ForkThreadButton({
  sourceEnvironmentId,
  sourceThreadId,
  sourceProjectId,
  sourceModelSelection,
}: ForkThreadButtonProps) {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const { forkThread, isForking } = useForkThreadToProject();

  const targetProjects = useMemo(
    () =>
      projects.filter(
        (project) =>
          project.environmentId === sourceEnvironmentId && project.id !== sourceProjectId,
      ),
    [projects, sourceEnvironmentId, sourceProjectId],
  );

  if (targetProjects.length === 0) {
    return null;
  }

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="outline"
                  aria-label="Fork this thread to another project"
                  disabled={isForking}
                />
              }
            >
              <GitForkIcon aria-hidden="true" className="size-3" />
            </MenuTrigger>
          }
        />
        <TooltipPopup side="bottom">
          {isForking ? "Generating handoff…" : "Fork this thread to another project"}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end">
        {targetProjects.map((project) => (
          <MenuItem
            key={`${project.environmentId}:${project.id}`}
            onClick={() => {
              void forkThread({
                sourceEnvironmentId,
                sourceThreadId,
                targetEnvironmentId: project.environmentId,
                targetProjectId: project.id,
                targetProjectName: project.name,
                modelSelection: sourceModelSelection,
              });
            }}
          >
            <ProjectFavicon
              environmentId={project.environmentId}
              cwd={project.cwd}
              className="size-4 text-muted-foreground"
            />
            {project.name}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
});
