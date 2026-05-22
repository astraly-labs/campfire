/**
 * Derive a `{ name, email }` pair suitable for `GIT_AUTHOR_*` /
 * `GIT_COMMITTER_*` env vars from the connected user's `ResolvedIdentity`.
 *
 * Zero-config by design: we read whatever the `UserIdentityService` already
 * resolved (Tailscale whois or the `local:<os-user>` fallback) and shape it
 * into a git author. There is no Settings UI override path — the only
 * customisation is `users.display_name_override`, which already wins inside
 * `ResolvedIdentity.user.displayName`.
 *
 * @module commitIdentity
 */
import type { ResolvedIdentity } from "../sidethreads/Services/UserIdentity.ts";

export interface GitCommitAuthor {
  readonly name: string;
  readonly email: string;
}

const NOREPLY_DOMAIN = "users.noreply.github.com";
const ANONYMOUS = "anonymous";
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Slug for the local-fragment of a synthetic noreply email. Lower-cases and
 * keeps only characters that are safe inside an email local-part (RFC 5321
 * is more permissive than this, but git tooling and GitHub both prefer the
 * conservative subset).
 */
const toEmailLocalPart = (input: string): string => {
  const normalized = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : ANONYMOUS;
};

export const resolvedIdentityToGitAuthor = (identity: ResolvedIdentity): GitCommitAuthor => {
  const displayName = identity.user.displayName.trim();
  const name = displayName.length > 0 ? displayName : ANONYMOUS;
  const userId = identity.user.id as unknown as string;

  if (EMAIL_LIKE.test(userId)) {
    return { name, email: userId };
  }

  const local = toEmailLocalPart(displayName || userId.replace(/^local:/, ""));
  return { name, email: `${local}@${NOREPLY_DOMAIN}` };
};
