import type { UserId, UserRef } from "@t3tools/contracts";

/**
 * Candidates shown in the TAL picker: every known teammate except the current
 * user (mentioning yourself isn't useful here). Ordering follows the input,
 * which the user directory already returns alphabetically.
 */
export function selectTakeALookCandidates(
  allUsers: ReadonlyArray<UserRef>,
  currentUserId: UserId | null,
): ReadonlyArray<UserRef> {
  if (currentUserId === null) return allUsers;
  return allUsers.filter((u) => u.id !== currentUserId);
}

/**
 * Pure toggle on the selected-id set. Returns a new Set so React state
 * updates stay referentially fresh.
 */
export function toggleSelection(current: ReadonlySet<UserId>, userId: UserId): ReadonlySet<UserId> {
  const next = new Set(current);
  if (next.has(userId)) {
    next.delete(userId);
  } else {
    next.add(userId);
  }
  return next;
}

/**
 * Materialise the picker's selection into a UserRef list. Order follows the
 * displayed candidates so the rendered `@a @b @c` reads the same way the
 * user saw them — not the order they clicked.
 */
export function selectedTargetsInOrder(
  candidates: ReadonlyArray<UserRef>,
  selectedIds: ReadonlySet<UserId>,
): ReadonlyArray<UserRef> {
  return candidates.filter((u) => selectedIds.has(u.id));
}

/**
 * Tiny formatter for the Send button label. v0 keeps it terse — bumps to
 * `Send (N)` only when there's a non-zero selection.
 */
export function sendButtonLabel(selectedCount: number): string {
  if (selectedCount === 0) return "Send";
  return `Send (${selectedCount})`;
}

/**
 * Toast title that mirrors how Slack-style pings phrase the outcome.
 */
export function pingedToastTitle(targets: ReadonlyArray<UserRef>): string {
  if (targets.length === 1) {
    const target = targets[0];
    if (target === undefined) return "Pinged 0 teammates";
    return `Pinged ${target.displayName}`;
  }
  return `Pinged ${targets.length} teammates`;
}
