import type { ScopedThreadRef } from "@t3tools/contracts";
import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";

export type CodexInlineVisualizationSegment =
  | { readonly kind: "markdown"; readonly text: string; readonly offset: number }
  | { readonly kind: "visualization"; readonly fileName: string; readonly offset: number };

const DIRECTIVE_PATTERN = /^::codex-inline-vis\{file="([^"\\/]+\.html)"\}[ \t]*(?:\r?\n|$)/gim;

export function splitCodexInlineVisualizations(
  text: string,
): ReadonlyArray<CodexInlineVisualizationSegment> {
  const segments: Array<CodexInlineVisualizationSegment> = [];
  let offset = 0;
  for (const match of text.matchAll(DIRECTIVE_PATTERN)) {
    const index = match.index;
    const fileName = match[1];
    if (index === undefined || fileName === undefined) continue;
    if (index > offset) {
      segments.push({ kind: "markdown", text: text.slice(offset, index), offset });
    }
    segments.push({ kind: "visualization", fileName, offset: index });
    offset = index + match[0].length;
  }
  if (offset < text.length) {
    segments.push({ kind: "markdown", text: text.slice(offset), offset });
  }
  return segments.length > 0 ? segments : [{ kind: "markdown", text, offset: 0 }];
}

const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

export function CodexInlineVisualization(props: {
  readonly threadRef: ScopedThreadRef;
  readonly fileName: string;
}) {
  const resource = useMemo(() => ({
    _tag: "codex-visualization" as const,
    threadId: props.threadRef.threadId,
    fileName: props.fileName,
  }), [props.threadRef.threadId, props.fileName]);
  const assetUrl = useAssetUrlState(props.threadRef.environmentId, resource);
  const refresh = useAssetUrlRefresh(props.threadRef.environmentId, resource);
  const [retryAttempt, setRetryAttempt] = useState(0);
  useEffect(() => setRetryAttempt(0), [props.threadRef.environmentId, resource]);
  useEffect(() => {
    if (assetUrl._tag === "Success") setRetryAttempt(0);
  }, [assetUrl._tag]);
  useEffect(() => {
    // A streamed directive can precede the generated file becoming visible on disk.
    if (assetUrl._tag !== "Failure") return;
    const delay = RETRY_DELAYS_MS[retryAttempt];
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      setRetryAttempt((attempt) => attempt + 1);
      void refresh().catch(() => undefined);
    }, delay);
    return () => clearTimeout(timer);
  }, [assetUrl._tag, refresh, retryAttempt]);

  return (
    <div className="my-3 flex h-[28rem] max-h-[70vh] min-h-80 w-full overflow-hidden rounded-lg border border-border bg-background">
      {assetUrl._tag === "Failure" ? (
        <div className="m-auto px-6 text-center text-xs text-destructive">
          This visualization is unavailable.
        </div>
      ) : assetUrl._tag === "Success" ? (
        <iframe
          title={props.fileName}
          src={assetUrl.url}
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"
          referrerPolicy="no-referrer"
          className="size-full border-0 bg-background"
        />
      ) : (
        <LoaderCircle className="m-auto size-5 animate-spin text-muted-foreground" />
      )}
    </div>
  );
}
