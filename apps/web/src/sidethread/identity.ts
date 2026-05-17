import type { UserRef } from "@t3tools/contracts";

const STORAGE_KEY = "campfire.sidethread.userRef.v1";

/**
 * Returns the locally-cached `UserRef`, prompting the user once for their
 * display name. v0 — pre-auth identity. Replaced later by a server-side
 * resolution via `tailscale whois` plumbed through ws.ts.
 */
export function getOrPromptUserRef(): UserRef | null {
  if (typeof window === "undefined") return null;

  const cached = window.localStorage.getItem(STORAGE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached) as UserRef;
    } catch {
      // fall through to re-prompt
    }
  }

  const displayName = window.prompt("Quel nom afficher à ton coéquipier ?", "")?.trim();
  if (!displayName) return null;

  const id = `client:${slugify(displayName)}:${randomSuffix()}`;
  const ref: UserRef = { id: id as UserRef["id"], displayName };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ref));
  return ref;
}

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "user";

const randomSuffix = () => Math.random().toString(36).slice(2, 8);
