/**
 * Pure helpers for the side-thread `@`-mention autocomplete.
 *
 * Split out from the React component so unit tests can cover the cursor →
 * query → range mapping without rendering.
 */
import type { UserRef } from "@t3tools/contracts";

/**
 * Token currently being typed at the caret. Returns `null` when the caret
 * is not inside an `@<word>` token (e.g. between two words). The token
 * starts after a whitespace boundary so we don't trigger autocomplete in
 * the middle of an email address or path fragment.
 */
export interface ActiveMentionToken {
  /** Lowercase query, no leading `@`. May be empty (just typed `@`). */
  readonly query: string;
  /** Inclusive start (the `@` character) and exclusive end (caret). */
  readonly start: number;
  readonly end: number;
}

export function findActiveMentionToken(text: string, caret: number): ActiveMentionToken | null {
  if (caret < 0 || caret > text.length) return null;
  // Walk back from the caret to find the most recent `@` that isn't broken
  // by a whitespace. If we hit whitespace first, there's no active token.
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i]!;
    if (ch === "@") {
      const before = i === 0 ? undefined : text[i - 1];
      // Only fire the popover when `@` follows the start of input or a
      // whitespace boundary — avoids spurious matches inside `foo@bar`.
      if (before === undefined || /\s/.test(before)) {
        return {
          query: text.slice(i + 1, caret),
          start: i,
          end: caret,
        };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  return null;
}

/**
 * Replace the active mention token in `text` with `@<slug>` (using the
 * user's displayName as a human-readable handle) and return the new text +
 * caret position. The mention's actual identity is tracked separately by
 * the composer's selectedMentions array; the inline `@text` is only a
 * visual cue for humans reading the message.
 */
export function applyMentionSelection(
  text: string,
  token: ActiveMentionToken,
  user: UserRef,
): { readonly nextText: string; readonly nextCaret: number } {
  const handle = mentionHandleForUser(user);
  const replacement = `@${handle} `;
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  const nextText = `${before}${replacement}${after}`;
  const nextCaret = before.length + replacement.length;
  return { nextText, nextCaret };
}

/**
 * Stable slug derived from `displayName`. Lowercase, hyphenated, ASCII-only
 * so the rendered `@matthias` token survives copy/paste and search.
 */
export function mentionHandleForUser(user: UserRef): string {
  return (
    user.displayName
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "user"
  );
}

/**
 * Slice a message body into alternating plain-text and `@mention` segments
 * for rendering. A segment is flagged as a mention only when its handle
 * matches one of the `mentions` stored on the message — we trust the
 * server-pinned UserRef list, not the visible text, to resolve identity.
 *
 * Returning serialisable segments (no JSX) keeps this testable.
 */
export type MentionRenderSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "mention"; readonly user: UserRef; readonly handle: string };

const MENTION_TOKEN_REGEX = /(^|\s)@([a-z0-9][a-z0-9-]*)/g;

export function renderTextWithMentions(
  text: string,
  mentions: ReadonlyArray<UserRef>,
): ReadonlyArray<MentionRenderSegment> {
  if (mentions.length === 0) return [{ kind: "text", text }];
  // Index mentions by their slug so we can match the visible `@handle` token
  // back to the resolved UserRef in O(1).
  const byHandle = new Map<string, UserRef>();
  for (const user of mentions) byHandle.set(mentionHandleForUser(user), user);

  const segments: MentionRenderSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const leading = match[1] ?? "";
    const handle = match[2] ?? "";
    const matchIndex = match.index ?? 0;
    const user = byHandle.get(handle);
    if (!user) continue;

    const mentionStart = matchIndex + leading.length;
    if (mentionStart > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, mentionStart) });
    }
    segments.push({ kind: "mention", user, handle });
    cursor = matchIndex + fullMatch.length;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  return segments;
}
