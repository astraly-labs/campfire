import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Download, LoaderCircle } from "lucide-react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { Button } from "~/components/ui/button";

export default function ArtifactPreviewPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
}) {
  const fileName = props.absolutePath.split(/[\\/]/).at(-1) ?? "artifact";
  const assetUrl = useAssetUrlState(props.environmentId, {
    _tag: "workspace-file",
    threadId: props.threadRef.threadId,
    path: props.absolutePath,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="surface-subheader gap-2 px-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={props.absolutePath}>
          {fileName}
        </span>
        {assetUrl._tag === "Success" ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Download ${fileName}`}
            onClick={() => {
              const anchor = document.createElement("a");
              anchor.href = assetUrl.url;
              anchor.download = fileName;
              anchor.click();
            }}
          >
            <Download className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {assetUrl._tag === "Failure" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
          This artifact is unavailable or is outside an allowed temporary directory.
        </div>
      ) : assetUrl._tag === "Success" ? (
        <iframe
          title={fileName}
          src={assetUrl.url}
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"
          referrerPolicy="no-referrer"
          className="min-h-0 flex-1 border-0 bg-white"
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
          <LoaderCircle className="size-5 animate-spin" />
        </div>
      )}
    </div>
  );
}
