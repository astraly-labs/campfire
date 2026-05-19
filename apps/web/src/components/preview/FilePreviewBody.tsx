import { useEffect, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import {
  buildWorkspaceFileDownloadUrl,
  buildWorkspaceFilePreviewUrl,
} from "../../workspaceFileUrl";
import type { FilePreviewTarget } from "../../preview/filePreviewStore";

const HTML_EXTENSIONS = new Set(["html", "htm"]);
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);
const PDF_EXTENSIONS = new Set(["pdf"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);
const TEXT_EXTENSIONS_TO_LANG: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  json: "json",
  jsonc: "json",
  json5: "json",
  css: "css",
  scss: "scss",
  less: "less",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  lua: "lua",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  dockerfile: "dockerfile",
  ini: "ini",
  env: "ini",
  conf: "ini",
  log: "text",
  txt: "text",
  csv: "text",
  tsv: "text",
};

function extensionOf(filePath: string): string {
  const sepIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const basename = sepIndex >= 0 ? filePath.slice(sepIndex + 1) : filePath;
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return "";
  return basename.slice(dot + 1).toLowerCase();
}

export function FilePreviewBody({ target }: { target: FilePreviewTarget }) {
  const ext = extensionOf(target.filePath);
  const previewUrl = buildWorkspaceFilePreviewUrl({ cwd: target.cwd, path: target.filePath });

  if (HTML_EXTENSIONS.has(ext)) {
    return (
      <iframe
        src={previewUrl}
        title={target.filePath}
        sandbox="allow-scripts allow-forms allow-popups"
        className="h-full w-full border-0 bg-white"
      />
    );
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    return (
      <div className="flex h-full w-full items-center justify-center overflow-auto bg-muted/20 p-3">
        <img
          src={previewUrl}
          alt={target.filePath}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }

  if (PDF_EXTENSIONS.has(ext)) {
    return (
      <iframe
        src={previewUrl}
        title={target.filePath}
        className="h-full w-full border-0 bg-white"
      />
    );
  }

  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return <FetchedTextPreview target={target} mode="markdown" />;
  }

  if (ext in TEXT_EXTENSIONS_TO_LANG) {
    const lang = TEXT_EXTENSIONS_TO_LANG[ext] ?? "text";
    return <FetchedTextPreview target={target} mode="code" lang={lang} />;
  }

  return <BinaryPlaceholder target={target} />;
}

interface FetchedTextProps {
  readonly target: FilePreviewTarget;
  readonly mode: "markdown" | "code";
  readonly lang?: string;
}

type FetchState =
  | { kind: "loading" }
  | { kind: "ok"; text: string }
  | { kind: "error"; message: string };

const MAX_TEXT_PREVIEW_BYTES = 2_000_000;

function FetchedTextPreview({ target, mode, lang }: FetchedTextProps) {
  const previewUrl = buildWorkspaceFilePreviewUrl({ cwd: target.cwd, path: target.filePath });
  const [state, setState] = useState<FetchState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetch(previewUrl, { credentials: "include" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setState({ kind: "error", message: `HTTP ${res.status}` });
          return;
        }
        const blob = await res.blob();
        const slice =
          blob.size > MAX_TEXT_PREVIEW_BYTES ? blob.slice(0, MAX_TEXT_PREVIEW_BYTES) : blob;
        const text = await slice.text();
        if (cancelled) return;
        const suffix = blob.size > MAX_TEXT_PREVIEW_BYTES ? "\n\n… (truncated)" : "";
        setState({ kind: "ok", text: text + suffix });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [previewUrl]);

  if (state.kind === "loading") {
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  }
  if (state.kind === "error") {
    return (
      <div className="p-4 text-sm text-destructive">Failed to load preview: {state.message}</div>
    );
  }

  if (mode === "markdown") {
    return (
      <div className="overflow-auto p-4">
        <ChatMarkdown text={state.text} cwd={target.cwd} />
      </div>
    );
  }

  const language = lang ?? "text";
  const fenced = "```" + language + "\n" + state.text + "\n```";
  return (
    <div className="overflow-auto p-4">
      <ChatMarkdown text={fenced} cwd={target.cwd} />
    </div>
  );
}

function BinaryPlaceholder({ target }: { target: FilePreviewTarget }) {
  const downloadUrl = buildWorkspaceFileDownloadUrl({ cwd: target.cwd, path: target.filePath });
  const sepIndex = Math.max(target.filePath.lastIndexOf("/"), target.filePath.lastIndexOf("\\"));
  const basename = sepIndex >= 0 ? target.filePath.slice(sepIndex + 1) : target.filePath;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
      <p>No inline preview available for this file type.</p>
      <a
        href={downloadUrl}
        download={basename}
        className="rounded border border-border/70 bg-background px-3 py-1.5 text-foreground hover:bg-accent"
      >
        Download {basename}
      </a>
    </div>
  );
}
