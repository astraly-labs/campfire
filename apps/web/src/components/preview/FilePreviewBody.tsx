import { getSharedHighlighter, type SupportedLanguages } from "@pierre/diffs";
import { useEffect, useMemo, useRef, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import {
  buildWorkspaceFileDownloadUrl,
  buildWorkspaceFilePreviewUrl,
} from "../../workspaceFileUrl";
import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { cn } from "../../lib/utils";
import {
  type FilePreviewTarget,
  useFilePreviewStore,
} from "../../preview/filePreviewStore";

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
  tf: "hcl",
  tfvars: "hcl",
  hcl: "hcl",
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
      <div className="h-full overflow-auto p-4">
        <ChatMarkdown text={state.text} cwd={target.cwd} />
      </div>
    );
  }

  const language = lang ?? "text";
  return (
    <CodePreview
      text={state.text}
      lang={language}
      targetLine={target.line}
      targetColumn={target.column}
    />
  );
}

interface CodePreviewProps {
  readonly text: string;
  readonly lang: string;
  readonly targetLine: number | undefined;
  readonly targetColumn: number | undefined;
}

interface ParsedHighlight {
  readonly background: string;
  readonly color: string;
  readonly lines: ReadonlyArray<string>;
}

const FALLBACK_LINE_HTML = "&#8203;"; // zero-width space to preserve empty row height

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function plainTextFallback(text: string): ParsedHighlight {
  const rawLines = text.split("\n");
  return {
    background: "",
    color: "",
    lines: rawLines.map((line) => (line.length === 0 ? FALLBACK_LINE_HTML : escapeHtml(line))),
  };
}

function parseShikiHtml(html: string, sourceText: string): ParsedHighlight {
  if (typeof window === "undefined" || typeof DOMParser === "undefined") {
    return plainTextFallback(sourceText);
  }
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const pre = doc.querySelector("pre");
    if (!pre) return plainTextFallback(sourceText);

    const style = pre.getAttribute("style") ?? "";
    const bgMatch = style.match(/background-color\s*:\s*([^;]+)/i);
    const fgMatch = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
    const background = bgMatch?.[1]?.trim() ?? "";
    const color = fgMatch?.[1]?.trim() ?? "";

    const code = pre.querySelector("code") ?? pre;
    const lineNodes = code.querySelectorAll(":scope > .line");
    const lines: string[] = [];
    lineNodes.forEach((node) => {
      const inner = (node as HTMLElement).innerHTML;
      lines.push(inner.length === 0 ? FALLBACK_LINE_HTML : inner);
    });

    if (lines.length === 0) return plainTextFallback(sourceText);
    return { background, color, lines };
  } catch {
    return plainTextFallback(sourceText);
  }
}

type HighlightState =
  | { kind: "loading" }
  | { kind: "ok"; parsed: ParsedHighlight }
  | { kind: "fallback"; parsed: ParsedHighlight };

function CodePreview({ text, lang, targetLine, targetColumn }: CodePreviewProps) {
  const { resolvedTheme } = useTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);
  const showLineNumbers = useFilePreviewStore((state) => state.showLineNumbers);
  const [highlightState, setHighlightState] = useState<HighlightState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setHighlightState({ kind: "loading" });
    void getSharedHighlighter({
      themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
      langs: [lang as SupportedLanguages],
      preferredHighlighter: "shiki-js",
    })
      .then((highlighter) => {
        if (cancelled) return;
        let html: string;
        try {
          html = highlighter.codeToHtml(text, { lang, theme: themeName });
        } catch {
          html = highlighter.codeToHtml(text, { lang: "text", theme: themeName });
        }
        if (cancelled) return;
        setHighlightState({ kind: "ok", parsed: parseShikiHtml(html, text) });
      })
      .catch(() => {
        if (cancelled) return;
        setHighlightState({ kind: "fallback", parsed: plainTextFallback(text) });
      });
    return () => {
      cancelled = true;
    };
  }, [lang, text, themeName]);

  const parsed = useMemo<ParsedHighlight>(() => {
    if (highlightState.kind === "loading") return plainTextFallback(text);
    return highlightState.parsed;
  }, [highlightState, text]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const targetRowRef = useRef<HTMLDivElement | null>(null);

  // Scroll the targeted line into view whenever the parsed lines or target change.
  useEffect(() => {
    if (highlightState.kind === "loading") return;
    if (targetLine === undefined || targetLine < 1) return;
    const row = targetRowRef.current;
    if (!row) return;
    // Defer to next frame so layout (esp. fonts/styles) settles first.
    const id = window.requestAnimationFrame(() => {
      row.scrollIntoView({ block: "center", behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(id);
  }, [highlightState.kind, parsed.lines.length, targetLine]);

  const lineCount = parsed.lines.length;
  const gutterWidth = `${Math.max(2, String(lineCount).length)}ch`;

  return (
    <div
      ref={containerRef}
      className="h-full overflow-auto font-mono text-[12.5px] leading-[1.55]"
      style={{
        background: parsed.background || undefined,
        color: parsed.color || undefined,
      }}
    >
      <div className="min-w-fit py-2">
        {parsed.lines.map((lineHtml, index) => {
          const lineNumber = index + 1;
          const isTarget = targetLine === lineNumber;
          return (
            <div
              key={index}
              ref={isTarget ? targetRowRef : undefined}
              data-line={lineNumber}
              className={cn(
                "group/code-line flex w-full min-w-fit items-start",
                isTarget && "bg-amber-400/15 ring-1 ring-inset ring-amber-400/35",
              )}
            >
              {showLineNumbers ? (
                <span
                  aria-hidden
                  className="sticky left-0 z-[1] shrink-0 select-none whitespace-pre pl-3 pr-3 text-right text-muted-foreground/55 tabular-nums"
                  style={{
                    minWidth: `calc(${gutterWidth} + 1.5rem)`,
                    background: parsed.background || undefined,
                  }}
                >
                  {lineNumber}
                </span>
              ) : (
                <span aria-hidden className="w-3 shrink-0" />
              )}
              <span
                className="flex-1 whitespace-pre pr-4"
                dangerouslySetInnerHTML={{ __html: lineHtml }}
              />
            </div>
          );
        })}
      </div>
      {targetColumn !== undefined && targetLine !== undefined ? (
        <span className="sr-only">
          Targeted line {targetLine}, column {targetColumn}
        </span>
      ) : null}
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
