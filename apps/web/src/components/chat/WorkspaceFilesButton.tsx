import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { DownloadIcon, FileIcon } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VscodeEntryIcon } from "./VscodeEntryIcon";
import { selectProjectByRef, selectThreadByRef, useStore } from "../../store";
import { collectFileMentions } from "../../markdownFileMentions";
import { useFilePreviewStore } from "../../preview/filePreviewStore";
import { buildWorkspaceFileDownloadUrl } from "../../workspaceFileUrl";
import { useTheme } from "../../hooks/useTheme";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";

interface Props {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export function WorkspaceFilesButton({ environmentId, threadId }: Props) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  // Subscribe to the stable `messages` array reference. The store reuses the
  // same array when nothing changes; mapping/transforming inside the selector
  // would create a fresh reference each render and Zustand would re-render in
  // a loop. We do the map() in a memo outside the selector instead.
  const messages = useStore((state) => selectThreadByRef(state, threadRef)?.messages);
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
  const { resolvedTheme } = useTheme();

  const mentions = useMemo(() => {
    if (!messages) return null;
    return collectFileMentions(
      messages.map((message) => message.text),
      projectCwd,
    );
  }, [messages, projectCwd]);

  const count = mentions?.orderedFilePaths.length ?? 0;
  const disabled = !projectCwd || count === 0;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Toggle
                  className="shrink-0"
                  aria-label="Files mentioned in this thread"
                  variant="outline"
                  size="xs"
                  disabled={disabled}
                >
                  <FileIcon className="size-3" />
                  {count > 0 ? (
                    <span className="ml-1 text-[10px] tabular-nums">{count}</span>
                  ) : null}
                </Toggle>
              }
            />
          }
        />
        <TooltipPopup side="bottom">
          {!projectCwd
            ? "Files panel is unavailable without an active project."
            : count === 0
              ? "No files mentioned yet in this thread."
              : `${count} file${count === 1 ? "" : "s"} mentioned in this thread`}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup className="min-w-72 max-w-[28rem]" side="bottom" align="end">
        {!mentions || mentions.orderedFilePaths.length === 0 ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">No files mentioned yet.</div>
        ) : (
          <ul className="-mx-2 -my-2 max-h-72 overflow-y-auto">
            {mentions.orderedFilePaths.map((filePath) => {
              const meta = mentions.metaByFilePath.get(filePath);
              if (!meta) return null;
              return (
                <FileMentionRow
                  key={filePath}
                  cwd={projectCwd as string}
                  filePath={meta.filePath}
                  displayPath={formatWorkspaceRelativePath(meta.targetPath, projectCwd)}
                  basename={meta.basename}
                  theme={resolvedTheme}
                />
              );
            })}
          </ul>
        )}
      </PopoverPopup>
    </Popover>
  );
}

function FileMentionRow({
  cwd,
  filePath,
  displayPath,
  basename,
  theme,
}: {
  cwd: string;
  filePath: string;
  displayPath: string;
  basename: string;
  theme: "light" | "dark";
}) {
  const openPreview = useFilePreviewStore((state) => state.open);
  const downloadUrl = buildWorkspaceFileDownloadUrl({ cwd, path: filePath });

  return (
    <li className="group flex items-center gap-2 px-2 py-1.5 hover:bg-accent/40">
      <button
        type="button"
        onClick={() => openPreview({ cwd, filePath })}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        title={`Preview ${displayPath}`}
      >
        <VscodeEntryIcon
          pathValue={filePath}
          kind="file"
          theme={theme}
          className="size-3.5 shrink-0"
        />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-medium text-foreground">{basename}</span>
          <span className="truncate font-mono text-[10px] text-muted-foreground/70">
            {displayPath}
          </span>
        </span>
      </button>
      <a
        href={downloadUrl}
        download={basename}
        onClick={(event) => event.stopPropagation()}
        title="Download"
        aria-label="Download"
        className="shrink-0 rounded p-1 text-muted-foreground/60 opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
      >
        <DownloadIcon className="size-3.5" />
      </a>
    </li>
  );
}
