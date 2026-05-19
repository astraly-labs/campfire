import { DownloadIcon, ExternalLinkIcon, HashIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { InlineSlideDrawer } from "../ui/inline-slide-drawer";
import {
  buildWorkspaceFileDownloadUrl,
  buildWorkspaceFilePreviewUrl,
} from "../../workspaceFileUrl";
import type { TerminalContextSelection } from "../../lib/terminalContext";
import { type FilePreviewTarget, useFilePreviewStore } from "../../preview/filePreviewStore";
import { cn } from "~/lib/utils";
import { FilePreviewBody } from "./FilePreviewBody";

const DRAWER_WIDTH = 640;

export interface FilePreviewDrawerProps {
  /**
   * Invoked when the user adds a code selection from the preview to the chat
   * context (via the floating "+" button). Omitting this prop hides the
   * selection affordance.
   */
  readonly onAddSelection?: (selection: TerminalContextSelection) => void;
}

export function FilePreviewDrawer({ onAddSelection }: FilePreviewDrawerProps) {
  const current = useFilePreviewStore((state) => state.current);
  const close = useFilePreviewStore((state) => state.close);

  return (
    <InlineSlideDrawer open={current !== null} width={DRAWER_WIDTH}>
      {current ? (
        <DrawerShell
          target={current}
          onClose={close}
          {...(onAddSelection ? { onAddSelection } : {})}
        />
      ) : null}
    </InlineSlideDrawer>
  );
}

function basenameOf(filePath: string): string {
  const sepIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return sepIndex >= 0 ? filePath.slice(sepIndex + 1) : filePath;
}

function DrawerShell({
  target,
  onClose,
  onAddSelection,
}: {
  target: FilePreviewTarget;
  onClose: () => void;
  onAddSelection?: (selection: TerminalContextSelection) => void;
}) {
  const previewUrl = buildWorkspaceFilePreviewUrl({ cwd: target.cwd, path: target.filePath });
  const downloadUrl = buildWorkspaceFileDownloadUrl({ cwd: target.cwd, path: target.filePath });
  const basename = basenameOf(target.filePath);
  const showLineNumbers = useFilePreviewStore((state) => state.showLineNumbers);
  const toggleShowLineNumbers = useFilePreviewStore((state) => state.toggleShowLineNumbers);

  return (
    <div
      className={cn("flex h-full w-full min-h-0 flex-col border-l border-border/70 bg-card/50")}
      role="complementary"
      aria-label="File preview"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <span
          className="flex-1 truncate font-mono text-xs text-foreground/80"
          title={target.filePath}
        >
          {basename}
          {target.line !== undefined ? (
            <span className="ml-1 text-muted-foreground/70">
              :{target.line}
              {target.column !== undefined ? `:${target.column}` : ""}
            </span>
          ) : null}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={toggleShowLineNumbers}
          aria-label={showLineNumbers ? "Hide line numbers" : "Show line numbers"}
          aria-pressed={showLineNumbers}
          title={showLineNumbers ? "Hide line numbers" : "Show line numbers"}
          className={cn(
            "text-muted-foreground/60 hover:text-foreground",
            showLineNumbers && "text-foreground",
          )}
        >
          <HashIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          render={
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in new tab"
              aria-label="Open in new tab"
              className="text-muted-foreground/60 hover:text-foreground"
            >
              <ExternalLinkIcon className="size-3.5" />
            </a>
          }
        />
        <Button
          variant="ghost"
          size="icon-xs"
          render={
            <a
              href={downloadUrl}
              download={basename}
              title="Download"
              aria-label="Download"
              className="text-muted-foreground/60 hover:text-foreground"
            >
              <DownloadIcon className="size-3.5" />
            </a>
          }
        />
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label="Close preview"
          title="Close"
          className="text-muted-foreground/60 hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <FilePreviewBody target={target} {...(onAddSelection ? { onAddSelection } : {})} />
      </div>
    </div>
  );
}
