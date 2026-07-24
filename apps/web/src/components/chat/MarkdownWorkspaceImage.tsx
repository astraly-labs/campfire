import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ComponentPropsWithoutRef } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { resolveMarkdownFileLinkMeta } from "~/markdown-links";

type MarkdownWorkspaceImageProps = ComponentPropsWithoutRef<"img"> & {
  readonly cwd?: string | undefined;
  readonly threadRef?: ScopedThreadRef | undefined;
};

function ResolvedWorkspaceImage(
  props: Omit<MarkdownWorkspaceImageProps, "cwd" | "src" | "threadRef"> & {
    readonly filePath: string;
    readonly threadRef: ScopedThreadRef;
  },
) {
  const { filePath, threadRef, alt, className, ...imageProps } = props;
  const assetUrl = useAssetUrlState(threadRef.environmentId, {
    _tag: "workspace-file",
    threadId: threadRef.threadId,
    path: filePath,
  });

  if (assetUrl._tag === "Loading") {
    return <span className="block h-40 w-full animate-pulse rounded-lg bg-muted" />;
  }
  if (assetUrl._tag === "Failure") {
    return <span className="text-sm text-muted-foreground">{alt ?? "Image unavailable"}</span>;
  }

  return (
    <a href={assetUrl.url} target="_blank" rel="noopener noreferrer">
      <img
        {...imageProps}
        src={assetUrl.url}
        alt={alt}
        loading="lazy"
        className={cn("max-h-[70vh] max-w-full rounded-lg object-contain", className)}
      />
    </a>
  );
}

export function MarkdownWorkspaceImage({
  cwd,
  threadRef,
  src,
  ...imageProps
}: MarkdownWorkspaceImageProps) {
  const filePath = resolveMarkdownFileLinkMeta(src, cwd)?.filePath;
  return threadRef && filePath ? (
    <ResolvedWorkspaceImage {...imageProps} filePath={filePath} threadRef={threadRef} />
  ) : (
    <img {...imageProps} src={src} />
  );
}
