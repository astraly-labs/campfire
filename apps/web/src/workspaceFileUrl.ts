// Helpers that build URLs against the server's `/workspace-file` route.
//
// In local Electron mode web + backend are on the same origin so a relative
// `/workspace-file?...` path would work. In remote Tailscale Serve mode the
// web app (Vite) and the backend listen on different ports — a relative path
// gets caught by Vite's static fallback and we end up serving Campfire's
// index.html instead of the file. We resolve through
// `resolvePrimaryEnvironmentHttpUrl` so the URL always points at the backend
// origin (driven by VITE_HTTP_URL when set, falling back to window origin).

import { resolvePrimaryEnvironmentHttpUrl } from "./environments/primary";

const WORKSPACE_FILE_PATH = "/workspace-file";

export interface WorkspaceFileTarget {
  readonly cwd: string;
  readonly path: string;
}

function buildUrl(target: WorkspaceFileTarget, download: boolean): string {
  const searchParams: Record<string, string> = { cwd: target.cwd, path: target.path };
  if (download) searchParams.download = "1";
  try {
    return resolvePrimaryEnvironmentHttpUrl(WORKSPACE_FILE_PATH, searchParams);
  } catch {
    // Fall back to a relative URL if we somehow render before the primary
    // environment is resolved (e.g. early bootstrap). The relative form
    // works in single-origin local mode.
    const search = new URLSearchParams(searchParams).toString();
    return `${WORKSPACE_FILE_PATH}?${search}`;
  }
}

export function buildWorkspaceFilePreviewUrl(target: WorkspaceFileTarget): string {
  return buildUrl(target, false);
}

export function buildWorkspaceFileDownloadUrl(target: WorkspaceFileTarget): string {
  return buildUrl(target, true);
}
