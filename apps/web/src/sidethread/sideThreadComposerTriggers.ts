import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { detectComposerTrigger } from "@t3tools/shared/composerTrigger";

import type { ComposerCommandItem } from "../components/chat/ComposerCommandMenu";
import { formatRelativeTimeLabel } from "../timestampFormat";

const SIDE_THREAD_SUGGESTION_LIMIT = 8;

/** `@` mentions a teammate, `#` links another agent thread. */
export interface SideThreadTrigger {
  readonly kind: "mention" | "thread";
  readonly query: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
}

export type SideThreadSuggestionItem = Extract<ComposerCommandItem, { type: "thread" }>;

/** A `#` link the user picked; it is sent only while its token is still in the text. */
export interface PickedThreadLink {
  readonly threadId: ThreadId;
  readonly title: string;
}

export interface ThreadLinkCandidate {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
}

/** Reuses the agent composer's token rules, where `@` is a path and `#` a pull request. */
export function detectSideThreadTrigger(text: string, caret: number): SideThreadTrigger | null {
  const trigger = detectComposerTrigger(text, caret);
  if (trigger?.kind === "path") return { ...trigger, kind: "mention" };
  if (trigger?.kind === "pull-request") return { ...trigger, kind: "thread" };
  return null;
}

/** Agent threads worth linking: same environment, not this one, not archived or settled. */
export function matchThreadLinkItems(input: {
  readonly threads: ReadonlyArray<ThreadLinkCandidate>;
  readonly environmentId: EnvironmentId;
  readonly excludeThreadId: ThreadId;
  readonly query: string;
}): SideThreadSuggestionItem[] {
  const query = input.query.toLocaleLowerCase();
  return input.threads
    .filter(
      (thread) =>
        thread.environmentId === input.environmentId &&
        thread.id !== input.excludeThreadId &&
        thread.archivedAt === null &&
        thread.settledOverride !== "settled" &&
        thread.title.toLocaleLowerCase().includes(query),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, SIDE_THREAD_SUGGESTION_LIMIT)
    .map((thread) => ({
      id: `thread:${thread.environmentId}:${thread.id}`,
      type: "thread",
      thread: { environmentId: thread.environmentId, threadId: thread.id },
      label: thread.title,
      description: formatRelativeTimeLabel(thread.updatedAt),
    }));
}

/** Text that replaces the typed trigger when the user picks a suggestion. */
export function suggestionToken(item: SideThreadSuggestionItem): string {
  return `#${item.label} `;
}

/** The message carries one linked thread: the earliest picked link whose token survived editing. */
export function linkedThreadForText(
  text: string,
  picked: ReadonlyArray<PickedThreadLink>,
): ThreadId | null {
  let earliest: { readonly threadId: ThreadId; readonly index: number } | null = null;
  for (const link of picked) {
    const index = text.indexOf(`#${link.title}`);
    if (index >= 0 && (earliest === null || index < earliest.index)) {
      earliest = { threadId: link.threadId, index };
    }
  }
  return earliest?.threadId ?? null;
}
