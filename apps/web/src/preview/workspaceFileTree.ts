// Pure helpers for the workspace file tree drawer.
//
// The server returns a flat list of POSIX-normalized relative paths (output of
// `git ls-files --cached --others --exclude-standard`). We turn it into a tree
// once per fetch and reuse it for rendering. Filtering by query is a separate
// linear pass over the flat list — no need to rebuild the tree on every
// keystroke.

import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary";

const WORKSPACE_FILES_TREE_PATH = "/workspace-files-tree";

export interface TreeFileNode {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
}

export interface TreeDirectoryNode {
  readonly kind: "directory";
  readonly name: string;
  readonly path: string;
  readonly children: TreeNode[];
}

export type TreeNode = TreeFileNode | TreeDirectoryNode;

export interface WorkspaceFilesTreeResponse {
  readonly paths: readonly string[];
  readonly truncated: boolean;
  readonly supported: boolean;
}

export async function fetchWorkspaceFilesTree(
  cwd: string,
  signal?: AbortSignal,
): Promise<WorkspaceFilesTreeResponse> {
  const url = (() => {
    try {
      return resolvePrimaryEnvironmentHttpUrl(WORKSPACE_FILES_TREE_PATH, { cwd });
    } catch {
      const search = new URLSearchParams({ cwd }).toString();
      return `${WORKSPACE_FILES_TREE_PATH}?${search}`;
    }
  })();

  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch workspace files tree (${response.status})`);
  }
  const json = (await response.json()) as Partial<WorkspaceFilesTreeResponse>;
  return {
    paths: Array.isArray(json.paths) ? json.paths : [],
    truncated: Boolean(json.truncated),
    supported: json.supported !== false,
  };
}

// Builds a sorted tree from a flat list of relative paths. Directories come
// before files at every level, then each group is sorted alphabetically.
export function buildFileTree(paths: readonly string[]): TreeDirectoryNode {
  const root: TreeDirectoryNode = { kind: "directory", name: "", path: "", children: [] };
  // Index of in-progress directory nodes for O(1) lookup while inserting.
  const dirIndex = new Map<string, TreeDirectoryNode>();
  dirIndex.set("", root);

  for (const path of paths) {
    if (!path) continue;
    const segments = path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) continue;

    let parent = root;
    let parentPath = "";
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i]!;
      const childPath = parentPath ? `${parentPath}/${segment}` : segment;
      let dir = dirIndex.get(childPath);
      if (!dir) {
        dir = { kind: "directory", name: segment, path: childPath, children: [] };
        dirIndex.set(childPath, dir);
        parent.children.push(dir);
      }
      parent = dir;
      parentPath = childPath;
    }
    const leaf = segments[segments.length - 1]!;
    parent.children.push({ kind: "file", name: leaf, path });
  }

  sortTree(root);
  return root;
}

function sortTree(node: TreeDirectoryNode): void {
  node.children.sort(compareNodes);
  for (const child of node.children) {
    if (child.kind === "directory") sortTree(child);
  }
}

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

// Returns the subset of paths whose path contains `query` (case-insensitive).
// Used by the search field — we keep the result flat to give the user a tight
// list rather than a tree with mostly-empty branches.
export function filterPaths(paths: readonly string[], query: string): string[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];
  const result: string[] = [];
  for (const path of paths) {
    if (path.toLowerCase().includes(trimmed)) result.push(path);
    if (result.length >= 500) break;
  }
  return result;
}
