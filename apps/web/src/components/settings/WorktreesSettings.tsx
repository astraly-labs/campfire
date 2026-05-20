import { FolderTreeIcon, GitBranchIcon, Trash2Icon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { ensureEnvironmentApi } from "../../environmentApi";
import { invalidateGitQueries } from "../../lib/gitReactQuery";
import { readLocalApi } from "../../localApi";
import {
  selectProjectsAcrossEnvironments,
  selectThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatWorktreePathForDisplay } from "../../worktreeCleanup";
import type { Project, Thread } from "../../types";
import { Button } from "../ui/button";
import { ProjectFavicon } from "../ProjectFavicon";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

interface WorktreeAttachedThread {
  readonly threadId: Thread["id"];
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly branch: string | null;
}

interface WorktreeEntry {
  readonly key: string;
  readonly worktreePath: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threads: readonly WorktreeAttachedThread[];
}

interface ProjectWithWorktrees {
  readonly project: Project;
  readonly worktrees: readonly WorktreeEntry[];
}

function normalizeWorktreePath(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function groupWorktreesByProject(
  projects: readonly Project[],
  threads: readonly Thread[],
): ProjectWithWorktrees[] {
  const projectByKey = new Map<string, Project>();
  for (const project of projects) {
    projectByKey.set(`${project.environmentId}:${project.id}`, project);
  }

  const worktreesByKey = new Map<string, WorktreeEntry>();
  for (const thread of threads) {
    const worktreePath = normalizeWorktreePath(thread.worktreePath);
    if (!worktreePath) continue;

    const projectKey = `${thread.environmentId}:${thread.projectId}`;
    const project = projectByKey.get(projectKey);
    if (!project) continue;

    const worktreeKey = `${projectKey}:${worktreePath}`;
    const existing = worktreesByKey.get(worktreeKey);
    const attached: WorktreeAttachedThread = {
      threadId: thread.id,
      environmentId: thread.environmentId,
      title: thread.title,
      branch: thread.branch,
    };
    if (existing) {
      worktreesByKey.set(worktreeKey, {
        ...existing,
        threads: [...existing.threads, attached],
      });
    } else {
      worktreesByKey.set(worktreeKey, {
        key: worktreeKey,
        worktreePath,
        environmentId: thread.environmentId,
        projectId: thread.projectId,
        threads: [attached],
      });
    }
  }

  const groupsByProjectKey = new Map<string, WorktreeEntry[]>();
  for (const entry of worktreesByKey.values()) {
    const projectKey = `${entry.environmentId}:${entry.projectId}`;
    const list = groupsByProjectKey.get(projectKey) ?? [];
    list.push(entry);
    groupsByProjectKey.set(projectKey, list);
  }

  const groups: ProjectWithWorktrees[] = [];
  for (const [projectKey, entries] of groupsByProjectKey) {
    const project = projectByKey.get(projectKey);
    if (!project) continue;
    groups.push({
      project,
      worktrees: entries.toSorted((a, b) => a.worktreePath.localeCompare(b.worktreePath)),
    });
  }

  return groups.toSorted((a, b) => a.project.name.localeCompare(b.project.name));
}

function WorktreeAttachedThreadsList({
  threads,
}: {
  readonly threads: readonly WorktreeAttachedThread[];
}) {
  if (threads.length === 0) {
    return (
      <span className="text-xs italic text-muted-foreground/70">
        No thread attached to this worktree.
      </span>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {threads.map((thread) => (
        <li key={`${thread.environmentId}:${thread.threadId}`} className="flex items-center gap-2">
          <Link
            to="/$environmentId/$threadId"
            params={buildThreadRouteParams(
              scopeThreadRef(thread.environmentId, thread.threadId),
            )}
            className="truncate text-[13px] text-foreground hover:underline"
            title={thread.title}
          >
            {thread.title || "Untitled thread"}
          </Link>
          {thread.branch ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              <GitBranchIcon className="size-3" aria-hidden />
              <span className="truncate">{thread.branch}</span>
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function WorktreeRow({
  entry,
  project,
  isDeleting,
  onDelete,
}: {
  readonly entry: WorktreeEntry;
  readonly project: Project;
  readonly isDeleting: boolean;
  readonly onDelete: () => void;
}) {
  const friendlyName = formatWorktreePathForDisplay(entry.worktreePath);
  return (
    <SettingsRow
      title={
        <span className="inline-flex items-center gap-2">
          <FolderTreeIcon className="size-3.5 text-muted-foreground/70" aria-hidden />
          <span className="truncate" title={entry.worktreePath}>
            {friendlyName}
          </span>
        </span>
      }
      description={
        <span
          className="block break-all font-mono text-[11px] text-muted-foreground/70"
          title={entry.worktreePath}
        >
          {entry.worktreePath}
        </span>
      }
      control={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5 text-destructive hover:text-destructive"
          disabled={isDeleting}
          onClick={onDelete}
          aria-label={`Delete worktree ${friendlyName}`}
        >
          <Trash2Icon className="size-3.5" />
          <span>{isDeleting ? "Deleting…" : "Delete"}</span>
        </Button>
      }
    >
      <div className="pt-2 pb-3.5">
        <p className="pb-1.5 text-[11px] uppercase tracking-[0.06em] text-muted-foreground/60">
          {entry.threads.length === 1 ? "Attached thread" : "Attached threads"}
        </p>
        <WorktreeAttachedThreadsList threads={entry.threads} />
        <p className="pt-2 text-[11px] text-muted-foreground/60">
          Project workspace:{" "}
          <span className="break-all font-mono text-foreground/70">{project.cwd}</span>
        </p>
      </div>
    </SettingsRow>
  );
}

export function WorktreesSettingsPanel() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectThreadsAcrossEnvironments));
  const queryClient = useQueryClient();
  const [deletingKeys, setDeletingKeys] = useState<ReadonlySet<string>>(() => new Set());

  const groups = useMemo(() => groupWorktreesByProject(projects, threads), [projects, threads]);

  const handleDelete = useCallback(
    async (entry: WorktreeEntry, project: Project) => {
      const friendlyName = formatWorktreePathForDisplay(entry.worktreePath);
      const localApi = readLocalApi();

      const lines = [
        `Delete worktree "${friendlyName}"?`,
        entry.worktreePath,
        "",
        entry.threads.length === 0
          ? "No thread is currently attached."
          : entry.threads.length === 1
            ? "1 thread is currently attached. Its checked-out copy will be removed."
            : `${entry.threads.length} threads are currently attached. Their checked-out copies will be removed.`,
        "",
        "This runs `git worktree remove --force` and deletes the directory.",
      ];
      const confirmed = localApi ? await localApi.dialogs.confirm(lines.join("\n")) : true;
      if (!confirmed) return;

      setDeletingKeys((previous) => {
        if (previous.has(entry.key)) return previous;
        const next = new Set(previous);
        next.add(entry.key);
        return next;
      });

      try {
        await ensureEnvironmentApi(entry.environmentId).vcs.removeWorktree({
          cwd: project.cwd,
          path: entry.worktreePath,
          force: true,
        });
        await invalidateGitQueries(queryClient, { environmentId: entry.environmentId });
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Worktree deleted",
            description: friendlyName,
          }),
        );
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not delete worktree",
            description:
              error instanceof Error ? error.message : "Worktree removal failed.",
          }),
        );
      } finally {
        setDeletingKeys((previous) => {
          if (!previous.has(entry.key)) return previous;
          const next = new Set(previous);
          next.delete(entry.key);
          return next;
        });
      }
    },
    [queryClient],
  );

  if (groups.length === 0) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Worktrees">
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                <FolderTreeIcon className="size-3.5 text-muted-foreground" />
                No worktrees
              </span>
            }
            description="Worktrees created for threads will appear here, grouped by project."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      {groups.map(({ project, worktrees }) => (
        <SettingsSection
          key={`${project.environmentId}:${project.id}`}
          title={project.name}
          icon={<ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />}
        >
          {worktrees.map((entry) => (
            <WorktreeRow
              key={entry.key}
              entry={entry}
              project={project}
              isDeleting={deletingKeys.has(entry.key)}
              onDelete={() => void handleDelete(entry, project)}
            />
          ))}
        </SettingsSection>
      ))}
    </SettingsPageContainer>
  );
}
