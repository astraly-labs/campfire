import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { useMemo, useState } from "react";

import { PULL_REQUEST_STATE_PRESENTATION, PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { isGoogleOwnedByCurrentAccount } from "../sidebarThreadAffiliation";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useUiStateStore } from "../uiStateStore";
import { usePullRequestResolution } from "../lib/sourceControlActions";
import { CollaborationAvatar } from "./CollaborationAvatar";
import { useGoogleTeam } from "./googleTeam";

export function useCollaborationSidebarThreads(threads: ReadonlyArray<EnvironmentThreadShell>, projects: ReadonlyArray<EnvironmentProject>) {
  const environmentId = usePrimaryEnvironmentId();
  const team = useGoogleTeam(environmentId);
  const overrides = useUiStateStore((state) => state.threadAffiliationOverrideByThreadKey);
  const [filter, setFilter] = useState<"all" | "mine" | "other">("all");
  const filtered = useMemo(() => filter === "all" ? threads : threads.filter((thread) => {
    const override = overrides[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))];
    const project = projects.find((entry) => entry.environmentId === thread.environmentId && entry.id === thread.projectId);
    const mine = override !== undefined ? override === "mine" : isGoogleOwnedByCurrentAccount({
      createdBy: thread.collaborationCreatedBy, fallbackCreatedBy: project?.createdBy,
      environmentId: thread.environmentId, primaryEnvironmentId: environmentId,
      currentGoogleSubject: team.current?.subject ?? null,
    });
    return filter === "mine" ? mine : !mine;
  }), [threads, projects, filter, overrides, environmentId, team.current?.subject]);
  const controls = (
    <div className="flex gap-1 px-3 py-1" aria-label="Thread ownership">
      {([['all', 'All'], ['mine', 'Mine'], ['other', 'Others']] as const).map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={filter === value}
          className={cn(
            "rounded px-2 py-1 text-xs",
            filter === value
              ? "bg-sidebar-row-selected text-sidebar-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setFilter(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
  return { threads: filtered, controls };
}

export function CollaborationThreadOwner({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const setAffiliation = useUiStateStore((state) => state.setThreadAffiliation);
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const override = useUiStateStore((state) => state.threadAffiliationOverrideByThreadKey[key]);
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<button type="button" className="inline-flex shrink-0 align-middle" aria-label="Thread owner and grouping" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }} />}>
      {thread.collaborationCreatedBy ? <CollaborationAvatar user={thread.collaborationCreatedBy} size="xs" /> : <span className="text-3xs text-muted-foreground">{override === "other" ? "Team" : "·"}</span>}
    </PopoverTrigger>
    <PopoverPopup className="w-48" onClick={(event) => event.stopPropagation()}>
      <p className="mb-1 truncate text-xs text-muted-foreground">{thread.collaborationCreatedBy?.displayName ?? "Legacy thread"}</p>
      {([['mine', 'Show in Mine'], ['other', 'Show in Others'], [null, 'Use original ownership']] as const).map(([value, label]) => <button key={label} type="button" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent" onClick={() => { setAffiliation(key, value); setOpen(false); }}>{label}</button>)}
    </PopoverPopup>
  </Popover>;
}

export function ReviewThreadBadge({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const projects = useProjects();
  const project = projects.find((entry) => entry.environmentId === thread.environmentId && entry.id === thread.projectId);
  const result = usePullRequestResolution({ environmentId: thread.environmentId, cwd: thread.worktreePath ?? project?.workspaceRoot ?? null, reference: thread.reviewPullRequestNumber ? `#${thread.reviewPullRequestNumber}` : null });
  const pr = result.data?.pullRequest;
  const presentation = pr ? PULL_REQUEST_STATE_PRESENTATION[pr.state] : null;
  const Icon = presentation?.Icon ?? PullRequestGlyph.pullRequest;
  const label = `PR review${thread.reviewPullRequestNumber ? ` #${thread.reviewPullRequestNumber}` : ""}${pr ? ` · ${pr.state}` : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" aria-label={label} />}>
        <Icon className={cn("size-3.5", presentation?.toneClassName ?? "text-muted-foreground")} />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
