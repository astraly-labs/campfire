import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { memo } from "react";
import { LockKeyholeIcon, MessageCircleIcon } from "lucide-react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import { ProjectFavicon } from "../ProjectFavicon";
import { cn } from "~/lib/utils";
import { PresenceAvatarStack } from "../../presence/PresenceAvatarStack";
import { useThreadPresence } from "../../presence/presence";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  view: "conversation" | "briefing";
  briefingAvailable: boolean;
  onViewChange: (view: "conversation" | "briefing") => void;
  sideThreadOpen: boolean;
  sideThreadMessageCount: number;
  sideThreadUnread: boolean;
  onToggleSideThread: () => void;
  gitCwd: string | null;
  onNewThreadInProject: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  activeProjectCwd,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  view,
  briefingAvailable,
  onViewChange,
  sideThreadOpen,
  sideThreadMessageCount,
  sideThreadUnread,
  onToggleSideThread,
  gitCwd,
  onNewThreadInProject,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const fileScripts = useT3ProjectFileScripts(
    activeThreadEnvironmentId,
    activeProjectScripts ? activeProjectCwd : null,
  );
  const viewers = useThreadPresence(activeThreadEnvironmentId, activeThreadId);
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        {/* The project always leads the header: knowing which project a
            thread lives in is priority zero, and the thread title alone
            doesn't answer it. */}
        {activeProjectName ? (
          <span className="inline-flex shrink-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`New thread in ${activeProjectName}`}
                    onClick={onNewThreadInProject}
                    className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <ProjectFavicon
                  environmentId={activeThreadEnvironmentId}
                  cwd={activeProjectCwd ?? ""}
                  className="size-3.5"
                />
                <span className="max-w-40 truncate text-sm font-medium">{activeProjectName}</span>
              </TooltipTrigger>
              <TooltipPopup side="top">New thread in {activeProjectName}</TooltipPopup>
            </Tooltip>
            <span aria-hidden className="text-muted-foreground/40">
              /
            </span>
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
      </div>
      {briefingAvailable ? (
        <div
          role="tablist"
          aria-label="Thread view"
          className="no-drag flex shrink-0 items-center rounded-lg border border-border bg-muted/35 p-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === "conversation"}
            onClick={() => onViewChange("conversation")}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              view === "conversation"
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Conversation
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "briefing"}
            onClick={() => onViewChange("briefing")}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              view === "briefing"
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <LockKeyholeIcon className="size-3" />
            Briefing
          </button>
        </div>
      ) : null}
      <div
        data-chat-header-actions
        className={cn(
          "flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
          rightPanelOpen ? "pr-0" : "pr-16",
        )}
      >
        {view === "briefing" ? (
          <span className="hidden items-center gap-1.5 text-xs text-muted-foreground @4xl/header-actions:flex">
            <LockKeyholeIcon className="size-3" />
            Private · temporary
          </span>
        ) : (
          <>
            <PresenceAvatarStack viewers={viewers} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="sm"
                    variant={sideThreadOpen ? "secondary" : "ghost"}
                    aria-label={sideThreadOpen ? "Close side thread" : "Open side thread"}
                    aria-pressed={sideThreadOpen}
                    onClick={onToggleSideThread}
                    className="relative"
                  />
                }
              >
                <MessageCircleIcon className="size-4" />
                {sideThreadMessageCount > 0 ? (
                  <span className="min-w-4 rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground">
                    {sideThreadMessageCount > 99 ? "99+" : sideThreadMessageCount}
                  </span>
                ) : null}
                {sideThreadUnread ? (
                  <span
                    aria-label="Unread team discussion"
                    className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-red-500 ring-2 ring-background"
                  />
                ) : null}
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {sideThreadOpen ? "Close side thread" : "Open side thread"}
              </TooltipPopup>
            </Tooltip>
            {activeProjectScripts && (
              <ProjectScriptsControl
                scripts={activeProjectScripts}
                fileScripts={fileScripts}
                keybindings={keybindings}
                preferredScriptId={preferredScriptId}
                onRunScript={onRunProjectScript}
                onAddScript={onAddProjectScript}
                onUpdateScript={onUpdateProjectScript}
                onDeleteScript={onDeleteProjectScript}
              />
            )}
            {showOpenInPicker && (
              <OpenInPicker
                environmentId={activeThreadEnvironmentId}
                keybindings={keybindings}
                availableEditors={availableEditors}
                openInCwd={openInCwd}
              />
            )}
            {activeProjectName && (
              <GitActionsControl
                gitCwd={gitCwd}
                activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
                {...(draftId ? { draftId } : {})}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
});
