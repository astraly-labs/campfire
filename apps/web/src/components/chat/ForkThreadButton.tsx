import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { GitForkIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useBranchThreadToProject } from "../../hooks/useBranchThreadToProject";
import { useForkThreadToProject } from "../../hooks/useForkThreadToProject";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectFavicon } from "../ProjectFavicon";

interface ForkThreadButtonProps {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceProjectId: ProjectId;
  readonly sourceModelSelection: ModelSelection;
}

/**
 * Header-level entry point for the two "carry this conversation forward"
 * flows. Same-environment only — cross-environment is unsupported because
 * the source transcript only lives on the source-side WS connection.
 *
 * The dropdown groups two distinct actions:
 *
 * - **Branch (copy transcript)**: pure client-side. Pastes the source
 *   transcript verbatim into a new draft's composer. No LLM round-trip.
 *   Use when wording matters (debug findings, exact paths).
 * - **Fork (handoff summary)**: LLM-summarised handoff. Better for cross-
 *   project context dumps where the next agent only needs the gist.
 *
 * Both lists include the source project itself (forking/branching back into
 * the same project is intentional — useful for restarting from a clean
 * context). The source project is sorted first in each group.
 */
export const ForkThreadButton = memo(function ForkThreadButton({
  sourceEnvironmentId,
  sourceThreadId,
  sourceProjectId,
  sourceModelSelection,
}: ForkThreadButtonProps) {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const { forkThread, isForking } = useForkThreadToProject();
  const { branchThread } = useBranchThreadToProject();

  // Surface the source project first in both groups so the "into this
  // project" entries don't get buried.
  const targetProjects = useMemo(() => {
    const sameEnv = projects.filter((project) => project.environmentId === sourceEnvironmentId);
    const current = sameEnv.find((project) => project.id === sourceProjectId);
    const others = sameEnv.filter((project) => project.id !== sourceProjectId);
    return current ? [current, ...others] : others;
  }, [projects, sourceEnvironmentId, sourceProjectId]);

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
                  aria-label="Fork or branch this thread"
                  disabled={isForking}
                />
              }
            >
              <GitForkIcon aria-hidden="true" className="size-3" />
            </MenuTrigger>
          }
        />
        <TooltipPopup side="bottom">
          {isForking ? "Generating handoff…" : "Fork or branch this thread"}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Branch (copy transcript)</MenuGroupLabel>
          {targetProjects.map((project) => {
            const isCurrent = project.id === sourceProjectId;
            return (
              <MenuItem
                key={`branch:${project.environmentId}:${project.id}`}
                onClick={() => {
                  void branchThread({
                    sourceEnvironmentId,
                    sourceThreadId,
                    targetEnvironmentId: project.environmentId,
                    targetProjectId: project.id,
                    targetProjectName: project.name,
                  });
                }}
              >
                <ProjectFavicon
                  environmentId={project.environmentId}
                  cwd={project.cwd}
                  className="size-4 text-muted-foreground"
                />
                <span>{project.name}</span>
                {isCurrent ? (
                  <span className="ml-auto text-xs text-muted-foreground">this project</span>
                ) : null}
              </MenuItem>
            );
          })}
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Fork (handoff summary)</MenuGroupLabel>
          {targetProjects.map((project) => {
            const isCurrent = project.id === sourceProjectId;
            return (
              <MenuItem
                key={`fork:${project.environmentId}:${project.id}`}
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
                <span>{project.name}</span>
                {isCurrent ? (
                  <span className="ml-auto text-xs text-muted-foreground">this project</span>
                ) : null}
              </MenuItem>
            );
          })}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});
