import type { HelixPathMapping } from "@t3tools/contracts";

function normalizePrefix(prefix: string): string {
  return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
}

function matchesPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  return path.startsWith(`${prefix}/`);
}

// Translates a remote workspace path to its local sshfs-mount equivalent by
// finding the longest matching `remotePrefix` and rewriting it to the
// corresponding `localPrefix`. Returns null when no mapping applies so the
// caller can surface a user-actionable error instead of silently opening the
// wrong file.
export function translateHelixPath(
  remotePath: string,
  mappings: ReadonlyArray<HelixPathMapping>,
): string | null {
  let best: { remote: string; local: string } | null = null;
  for (const mapping of mappings) {
    const remote = normalizePrefix(mapping.remotePrefix);
    const local = normalizePrefix(mapping.localPrefix);
    if (!matchesPrefix(remotePath, remote)) continue;
    if (best && best.remote.length >= remote.length) continue;
    best = { remote, local };
  }
  if (!best) return null;
  const suffix = remotePath.slice(best.remote.length);
  return `${best.local}${suffix}`;
}

// Builds the `helix://` URL the renderer hands off to the OS. The path
// segment is URI-encoded as a single path component so `?`, `#`, and spaces
// survive the round-trip to the user's scheme handler.
export function buildHelixUrl(localPath: string): string {
  const encoded = localPath.split("/").map(encodeURIComponent).join("/");
  return `helix://${encoded}`;
}
