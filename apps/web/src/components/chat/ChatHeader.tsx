import {
  type EnvironmentId,
  type EditorId,
  type ModelSelection,
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
  type UserRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { DiffIcon, MoreHorizontalIcon, TerminalSquareIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger } from "../ui/sidebar";
import { ForkThreadButton } from "./ForkThreadButton";
import { OpenInPicker } from "./OpenInPicker";
import { WorkspaceFilesButton } from "./WorkspaceFilesButton";
import { WorkspaceFileTreeButton } from "./WorkspaceFileTreeButton";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  AvatarStack,
  SOFT_PALETTE,
  colorIndexForUserId,
  initialsFor,
} from "../../presence/AvatarStack";
import { useViewersOfParentThread } from "../../presence/presenceStore";
import { ChatHeaderSideThreadToggle } from "../../sidethread/ChatHeaderSideThreadToggle";
import { cn } from "~/lib/utils";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  gitCwd: string | null;
  diffOpen: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
  /**
   * Creator of the thread, surfaced as an "assigned to" avatar. Null for
   * threads created before per-thread attribution shipped or for local
   * drafts that have not yet been dispatched server-side.
   */
  assignee: UserRef | null;
  /**
   * Source-thread metadata for the "fork to another project" button. Null
   * for drafts (no transcript to summarise yet); when null, the button is
   * not rendered.
   */
  forkSource: {
    readonly projectId: ProjectId;
    readonly modelSelection: ModelSelection;
  } | null;
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
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  gitCwd,
  diffOpen,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleTerminal,
  onToggleDiff,
  assignee,
  forkSource,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  const viewers = useViewersOfParentThread(activeThreadId);

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <h2
          className="min-w-0 shrink truncate text-sm font-medium text-foreground"
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
        {activeProjectName && (
          <Badge variant="outline" className="min-w-0 shrink overflow-hidden">
            <span className="min-w-0 truncate">{activeProjectName}</span>
          </Badge>
        )}
        {activeProjectName && !isGitRepo && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
        {assignee !== null && <AssigneeAvatar assignee={assignee} />}
        {viewers.length > 0 && (
          <AvatarStack viewers={viewers} maxVisible={3} size="md" className="ml-1" />
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
        <ChatHeaderSideThreadToggle threadId={activeThreadId} />
        {/* Below md the action row gets crammed into 9+ buttons we can't fit
            in ~340px. Secondary actions hide; Terminal/Diff move into the
            kebab so they stay reachable. The components that are themselves
            dropdowns (scripts, open-in, git actions, files, fork) hide too —
            reusing them as MenuItems would mean reworking each one, so for
            now they stay desktop-only. */}
        {activeProjectScripts && (
          <div className="contents max-md:hidden">
            <ProjectScriptsControl
              scripts={activeProjectScripts}
              keybindings={keybindings}
              preferredScriptId={preferredScriptId}
              onRunScript={onRunProjectScript}
              onAddScript={onAddProjectScript}
              onUpdateScript={onUpdateProjectScript}
              onDeleteScript={onDeleteProjectScript}
            />
          </div>
        )}
        {showOpenInPicker && (
          <div className="contents max-md:hidden">
            <OpenInPicker
              keybindings={keybindings}
              availableEditors={availableEditors}
              openInCwd={openInCwd}
            />
          </div>
        )}
        {activeProjectName && (
          <div className="contents max-md:hidden">
            <GitActionsControl
              gitCwd={gitCwd}
              activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
              {...(draftId ? { draftId } : {})}
            />
          </div>
        )}
        <div className="contents max-md:hidden">
          <WorkspaceFileTreeButton
            environmentId={activeThreadEnvironmentId}
            threadId={activeThreadId}
          />
        </div>
        <div className="contents max-md:hidden">
          <WorkspaceFilesButton
            environmentId={activeThreadEnvironmentId}
            threadId={activeThreadId}
          />
        </div>
        {forkSource && (
          <div className="contents max-md:hidden">
            <ForkThreadButton
              sourceEnvironmentId={activeThreadEnvironmentId}
              sourceThreadId={activeThreadId}
              sourceProjectId={forkSource.projectId}
              sourceModelSelection={forkSource.modelSelection}
            />
          </div>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0 max-md:hidden"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label="Toggle terminal drawer"
                variant="outline"
                size="xs"
                disabled={!terminalAvailable}
              >
                <TerminalSquareIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!terminalAvailable
              ? "Terminal is unavailable until this thread has an active project."
              : terminalToggleShortcutLabel
                ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
                : "Toggle terminal drawer"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0 max-md:hidden"
                pressed={diffOpen}
                onPressedChange={onToggleDiff}
                aria-label="Toggle diff panel"
                variant="outline"
                size="xs"
                disabled={!isGitRepo && !diffOpen}
              >
                <DiffIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!isGitRepo && !diffOpen
              ? "Diff panel is unavailable because this project is not a git repository."
              : diffToggleShortcutLabel
                ? `Toggle diff panel (${diffToggleShortcutLabel})`
                : "Toggle diff panel"}
          </TooltipPopup>
        </Tooltip>
        <ChatHeaderMobileActions
          terminalOpen={terminalOpen}
          terminalAvailable={terminalAvailable}
          onToggleTerminal={onToggleTerminal}
          diffOpen={diffOpen}
          isGitRepo={isGitRepo}
          onToggleDiff={onToggleDiff}
        />
      </div>
    </div>
  );
});

interface ChatHeaderMobileActionsProps {
  readonly terminalOpen: boolean;
  readonly terminalAvailable: boolean;
  readonly onToggleTerminal: () => void;
  readonly diffOpen: boolean;
  readonly isGitRepo: boolean;
  readonly onToggleDiff: () => void;
}

// Kebab that surfaces the two simple toggles (Terminal, Diff) on mobile,
// where the full action row doesn't fit. Components that own their own
// dropdown (ProjectScripts, OpenInPicker, GitActions, Workspace*, Fork)
// stay desktop-only until we teach each one to render as a MenuItem.
function ChatHeaderMobileActions({
  terminalOpen,
  terminalAvailable,
  onToggleTerminal,
  diffOpen,
  isGitRepo,
  onToggleDiff,
}: ChatHeaderMobileActionsProps) {
  const diffDisabled = !isGitRepo && !diffOpen;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="outline"
            aria-label="More actions"
            className="shrink-0 md:hidden"
          >
            <MoreHorizontalIcon className="size-3.5" />
          </Button>
        }
      />
      <MenuPopup align="end">
        <MenuCheckboxItem
          checked={terminalOpen}
          onCheckedChange={() => onToggleTerminal()}
          disabled={!terminalAvailable}
        >
          <TerminalSquareIcon />
          Terminal
        </MenuCheckboxItem>
        <MenuCheckboxItem
          checked={diffOpen}
          onCheckedChange={() => onToggleDiff()}
          disabled={diffDisabled}
        >
          <DiffIcon />
          Diff
        </MenuCheckboxItem>
      </MenuPopup>
    </Menu>
  );
}

function AssigneeAvatar({ assignee }: { readonly assignee: UserRef }) {
  const palette = SOFT_PALETTE[colorIndexForUserId(assignee.id)]!;
  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <span
            {...props}
            aria-label={`Assigned to ${assignee.displayName}`}
            className={cn(
              "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-medium ring-2 ring-background ml-1",
              palette.bg,
              palette.text,
            )}
          >
            {initialsFor(assignee.displayName)}
          </span>
        )}
      />
      <TooltipPopup side="bottom">Assigned to {assignee.displayName}</TooltipPopup>
    </Tooltip>
  );
}
