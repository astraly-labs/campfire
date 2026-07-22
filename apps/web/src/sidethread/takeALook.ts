import type { SideThreadAuthor } from "@t3tools/contracts";

export function mentionHandleForGoogleUser(user: SideThreadAuthor): string {
  const normalized = user.displayName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ".")
    .replace(/^\.+|\.+$/gu, "");
  return normalized || user.subject.slice("google:".length, "google:".length + 12);
}

export function buildTakeALookText(targets: ReadonlyArray<SideThreadAuthor>): string {
  const handles = targets.map((user) => `@${mentionHandleForGoogleUser(user)}`).join(" ");
  return `${handles} please take a look!`;
}

export function toggleTakeALookSelection(
  current: ReadonlySet<string>,
  subject: string,
): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(subject)) next.delete(subject);
  else next.add(subject);
  return next;
}
