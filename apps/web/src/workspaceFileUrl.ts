// Helpers that build URLs against the server's `/workspace-file` route.
// Using the current origin keeps things working in both local Electron and
// remote Tailscale Serve deployments (cookies/auth follow same-origin rules).

const WORKSPACE_FILE_PATH = "/workspace-file";

export interface WorkspaceFileTarget {
  readonly cwd: string;
  readonly path: string;
}

function buildUrl(target: WorkspaceFileTarget, download: boolean): string {
  const search = new URLSearchParams({ cwd: target.cwd, path: target.path });
  if (download) search.set("download", "1");
  return `${WORKSPACE_FILE_PATH}?${search.toString()}`;
}

export function buildWorkspaceFilePreviewUrl(target: WorkspaceFileTarget): string {
  return buildUrl(target, false);
}

export function buildWorkspaceFileDownloadUrl(target: WorkspaceFileTarget): string {
  return buildUrl(target, true);
}
