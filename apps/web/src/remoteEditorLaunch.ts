/**
 * Remote-SSH launch URLs for VS Code-family editors.
 *
 * When the browser is connected to a remote backend (e.g. the Mac mini via
 * Tailscale serve), `shell.openInEditor` over RPC would spawn the editor on
 * the backend's display — useless from a remote machine. Instead we hand the
 * browser a `cursor://vscode-remote/ssh-remote+<host>/<path>` URL so the
 * editor opens locally and connects back over SSH-remote.
 */
import type { EditorId } from "@t3tools/contracts";
import { isLoopbackHostname } from "./environments/primary";

const REMOTE_SSH_URL_SCHEMES = {
  cursor: "cursor",
  vscode: "vscode",
  "vscode-insiders": "vscode-insiders",
  vscodium: "vscodium",
} as const satisfies Partial<Record<EditorId, string>>;

export type RemoteSshEditorId = keyof typeof REMOTE_SSH_URL_SCHEMES;

export const REMOTE_SSH_EDITOR_IDS = Object.keys(
  REMOTE_SSH_URL_SCHEMES,
) as ReadonlyArray<RemoteSshEditorId>;

export function editorSupportsRemoteSshLaunch(editor: EditorId): editor is RemoteSshEditorId {
  return editor in REMOTE_SSH_URL_SCHEMES;
}

export interface ResolveRemoteSshLaunchUrlInput {
  readonly editor: EditorId;
  readonly cwd: string;
  readonly sshHost: string;
}

export function resolveRemoteSshLaunchUrl(input: ResolveRemoteSshLaunchUrlInput): string | null {
  if (!editorSupportsRemoteSshLaunch(input.editor)) return null;

  const host = input.sshHost.trim();
  if (!host) return null;
  // Bare hostnames + optional `user@host`. Reject anything that would break the URL authority.
  if (/[\s/?#]/.test(host)) return null;

  const path = input.cwd.startsWith("/") ? input.cwd : `/${input.cwd}`;
  const scheme = REMOTE_SSH_URL_SCHEMES[input.editor];
  return `${scheme}://vscode-remote/ssh-remote+${host}${encodeURI(path)}`;
}

export function shouldUseRemoteSshLaunch(
  hostname: string = typeof window === "undefined" ? "" : window.location.hostname,
): boolean {
  if (!hostname) return false;
  return !isLoopbackHostname(hostname);
}

export function resolveRemoteSshHostFromLocation(): string {
  if (typeof window === "undefined") return "";
  return window.location.hostname;
}

/**
 * Combine the browser-visible host with the backend's OS username so the
 * SSH-remote authority targets the right account.
 *
 * Without this prefix, the local SSH client falls back to the *viewer*'s
 * username (e.g. the person opening the link), which typically has no shell
 * account on the backend host — leading to a password prompt that never
 * succeeds. The username is exposed by the server via the environment
 * descriptor (`ExecutionEnvironmentDescriptor.sshUsername`).
 *
 * If the host already contains a `user@` prefix, it's left untouched.
 */
export function applySshUsernameToHost(host: string, sshUsername: string | null): string {
  if (!host) return host;
  if (host.includes("@")) return host;
  const user = sshUsername?.trim();
  if (!user) return host;
  return `${user}@${host}`;
}
