import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRightIcon,
  FolderClosedIcon,
  FolderIcon,
  PanelRightCloseIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { InlineSlideDrawer } from "../ui/inline-slide-drawer";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { useFilePreviewStore } from "../../preview/filePreviewStore";
import {
  type TreeDirectoryNode,
  type TreeNode,
  filterPaths,
} from "../../preview/workspaceFileTree";
import { useWorkspaceFileTreeStore } from "../../preview/workspaceFileTreeStore";
import { useTheme } from "../../hooks/useTheme";
import { cn } from "~/lib/utils";

const DRAWER_WIDTH = 320;

export function WorkspaceFileTreeDrawer() {
  const open = useWorkspaceFileTreeStore((s) => s.open);
  return (
    <InlineSlideDrawer open={open} width={DRAWER_WIDTH}>
      <DrawerShell />
    </InlineSlideDrawer>
  );
}

function DrawerShell() {
  const cwd = useWorkspaceFileTreeStore((s) => s.cwd);
  const status = useWorkspaceFileTreeStore((s) => s.status);
  const error = useWorkspaceFileTreeStore((s) => s.error);
  const snapshot = useWorkspaceFileTreeStore((s) => s.snapshot);
  const closeDrawer = useWorkspaceFileTreeStore((s) => s.closeDrawer);
  const refresh = useWorkspaceFileTreeStore((s) => s.refresh);
  const openPreview = useFilePreviewStore((s) => s.open);
  const { resolvedTheme } = useTheme();

  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const inSearchMode = trimmedQuery.length > 0;

  // Reset the search field whenever we switch projects so it doesn't carry
  // stale filters across cwds.
  useEffect(() => {
    setQuery("");
  }, [cwd]);

  const filteredPaths = useMemo(
    () => (inSearchMode && snapshot ? filterPaths(snapshot.paths, trimmedQuery) : []),
    [inSearchMode, snapshot, trimmedQuery],
  );

  const handleOpenFile = useCallback(
    (filePath: string) => {
      if (!cwd) return;
      openPreview({ cwd, filePath });
    },
    [cwd, openPreview],
  );

  return (
    <div className="flex h-full w-full min-h-0 flex-col border-l border-border/70 bg-card/50">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground/80 uppercase">
          Files
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => void refresh()}
            aria-label="Refresh file list"
            title="Refresh"
            disabled={status === "loading" || !cwd}
            className="text-muted-foreground/60 hover:text-foreground/80"
          >
            <RefreshCwIcon className={cn("size-3.5", status === "loading" && "animate-spin")} />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={closeDrawer}
            aria-label="Close files panel"
            title="Close"
            className="text-muted-foreground/60 hover:text-foreground/80"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="shrink-0 border-b border-border/60 px-2 py-2">
        <div className="relative">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/60"
          />
          <Input
            type="search"
            placeholder="Filter files…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 pl-7 text-xs"
            aria-label="Filter files"
          />
        </div>
        {snapshot?.truncated ? (
          <p className="mt-1.5 px-1 text-[10px] text-amber-500/80">
            File list truncated — narrow your search.
          </p>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-1 py-1.5">
          {!cwd ? (
            <EmptyState>No active project.</EmptyState>
          ) : status === "loading" && !snapshot ? (
            <EmptyState>Loading files…</EmptyState>
          ) : status === "error" ? (
            <EmptyState tone="error">{error ?? "Failed to load files."}</EmptyState>
          ) : !snapshot ? (
            <EmptyState>No files to display.</EmptyState>
          ) : !snapshot.supported ? (
            <EmptyState>This workspace is not a git repository.</EmptyState>
          ) : snapshot.paths.length === 0 ? (
            <EmptyState>No tracked files in this workspace.</EmptyState>
          ) : inSearchMode ? (
            <FilteredList
              paths={filteredPaths}
              query={trimmedQuery}
              resolvedTheme={resolvedTheme}
              onOpen={handleOpenFile}
            />
          ) : (
            <TreeView root={snapshot.tree} resolvedTheme={resolvedTheme} onOpen={handleOpenFile} />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function EmptyState({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "error";
}) {
  return (
    <div
      className={cn(
        "px-2 py-3 text-xs",
        tone === "error" ? "text-destructive-foreground" : "text-muted-foreground/70",
      )}
    >
      {children}
    </div>
  );
}

const TreeView = memo(function TreeView(props: {
  root: TreeDirectoryNode;
  resolvedTheme: "light" | "dark";
  onOpen: (filePath: string) => void;
}) {
  const { root, resolvedTheme, onOpen } = props;
  // Top-level directories start expanded so users see structure right away;
  // everything deeper stays collapsed until clicked.
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const child of root.children) {
      if (child.kind === "directory") initial[child.path] = true;
    }
    return initial;
  });

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => ({ ...prev, [path]: !prev[path] }));
  }, []);

  return (
    <div className="space-y-0.5">
      {root.children.map((child) => (
        <TreeRow
          key={`${child.kind}:${child.path}`}
          node={child}
          depth={0}
          expanded={expanded}
          onToggle={toggle}
          resolvedTheme={resolvedTheme}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
});

function TreeRow(props: {
  node: TreeNode;
  depth: number;
  expanded: Record<string, boolean>;
  onToggle: (path: string) => void;
  resolvedTheme: "light" | "dark";
  onOpen: (filePath: string) => void;
}) {
  const { node, depth, expanded, onToggle, resolvedTheme, onOpen } = props;
  const leftPadding = 6 + depth * 12;

  if (node.kind === "directory") {
    const isOpen = expanded[node.path] === true;
    return (
      <div>
        <button
          type="button"
          className="group flex w-full items-center gap-1 rounded-md py-0.5 pr-2 text-left hover:bg-accent/40"
          style={{ paddingLeft: `${leftPadding}px` }}
          onClick={() => onToggle(node.path)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3 shrink-0 text-muted-foreground/60 transition-transform",
              isOpen && "rotate-90",
            )}
          />
          {isOpen ? (
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
          ) : (
            <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
          )}
          <span className="truncate font-mono text-[11px] text-muted-foreground/90 group-hover:text-foreground/90">
            {node.name}
          </span>
        </button>
        {isOpen && node.children.length > 0 ? (
          <div className="space-y-0.5">
            {node.children.map((child) => (
              <TreeRow
                key={`${child.kind}:${child.path}`}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                resolvedTheme={resolvedTheme}
                onOpen={onOpen}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="group flex w-full items-center gap-1 rounded-md py-0.5 pr-2 text-left hover:bg-accent/40"
      style={{ paddingLeft: `${leftPadding}px` }}
      onClick={() => onOpen(node.path)}
      title={node.path}
    >
      <span aria-hidden="true" className="size-3 shrink-0" />
      <VscodeEntryIcon
        pathValue={node.path}
        kind="file"
        theme={resolvedTheme}
        className="size-3.5"
      />
      <span className="truncate font-mono text-[11px] text-muted-foreground/90 group-hover:text-foreground">
        {node.name}
      </span>
    </button>
  );
}

const FilteredList = memo(function FilteredList(props: {
  paths: readonly string[];
  query: string;
  resolvedTheme: "light" | "dark";
  onOpen: (filePath: string) => void;
}) {
  const { paths, resolvedTheme, onOpen } = props;
  if (paths.length === 0) {
    return <EmptyState>No matches.</EmptyState>;
  }
  return (
    <ul className="space-y-0.5">
      {paths.map((filePath) => {
        const basename = basenameOf(filePath);
        return (
          <li key={filePath}>
            <button
              type="button"
              className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent/40"
              onClick={() => onOpen(filePath)}
              title={filePath}
            >
              <VscodeEntryIcon
                pathValue={filePath}
                kind="file"
                theme={resolvedTheme}
                className="size-3.5 shrink-0"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[11px] font-medium text-foreground">{basename}</span>
                <span className="truncate font-mono text-[10px] text-muted-foreground/70">
                  {filePath}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
});

function basenameOf(filePath: string): string {
  const sepIndex = filePath.lastIndexOf("/");
  return sepIndex >= 0 ? filePath.slice(sepIndex + 1) : filePath;
}
