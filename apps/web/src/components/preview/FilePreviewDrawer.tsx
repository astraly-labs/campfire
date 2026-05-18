import { DownloadIcon, ExternalLinkIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { InlineSlideDrawer } from "../ui/inline-slide-drawer";
import {
  buildWorkspaceFileDownloadUrl,
  buildWorkspaceFilePreviewUrl,
} from "../../workspaceFileUrl";
import {
  type FilePreviewTarget,
  useFilePreviewStore,
} from "../../preview/filePreviewStore";
import { cn } from "~/lib/utils";
import { FilePreviewBody } from "./FilePreviewBody";

const DRAWER_WIDTH = 640;

export function FilePreviewDrawer() {
  const current = useFilePreviewStore((state) => state.current);
  const close = useFilePreviewStore((state) => state.close);

  return (
    <InlineSlideDrawer open={current !== null} width={DRAWER_WIDTH}>
      {current ? <DrawerShell target={current} onClose={close} /> : null}
    </InlineSlideDrawer>
  );
}

function basenameOf(filePath: string): string {
  const sepIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return sepIndex >= 0 ? filePath.slice(sepIndex + 1) : filePath;
}

function DrawerShell({ target, onClose }: { target: FilePreviewTarget; onClose: () => void }) {
  const previewUrl = buildWorkspaceFilePreviewUrl({ cwd: target.cwd, path: target.filePath });
  const downloadUrl = buildWorkspaceFileDownloadUrl({ cwd: target.cwd, path: target.filePath });
  const basename = basenameOf(target.filePath);

  return (
    <div
      className={cn(
        "flex h-full w-full min-h-0 flex-col border-l border-border/70 bg-card/50",
      )}
      role="complementary"
      aria-label="File preview"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <span
          className="flex-1 truncate font-mono text-xs text-foreground/80"
          title={target.filePath}
        >
          {basename}
        </span>
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
        <FilePreviewBody target={target} />
      </div>
    </div>
  );
}
