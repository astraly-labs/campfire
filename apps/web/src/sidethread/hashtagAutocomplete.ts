/**
 * Pure helpers for the side-thread `#`-hashtag autocomplete — the quick
 * affordance that lets a user link an agent thread (or the workspace-wide
 * global chat) into their message by typing `#<query>`.
 *
 * Modeled exactly after {@link mentionAutocomplete}: caret-aware token
 * detection, whitespace-bounded so `foo#bar` doesn't trigger, and
 * resolution by display title (case-insensitive).
 *
 * Picking a candidate does NOT splice a literal `#token` into the text:
 * unlike `@user` (which renders as a visible handle), a link is a one-off
 * attachment — we attach the {@link LinkedRef} to the composer's pending
 * state and strip the `#` token from the draft. The bubble then shows a
 * single chip below the text, same as button-picker linking.
 */
import type { LinkedRef, ThreadId } from "@t3tools/contracts";

export interface ActiveHashtagToken {
  /** Lowercase query, no leading `#`. May be empty (just typed `#`). */
  readonly query: string;
  /** Inclusive start (the `#` character) and exclusive end (caret). */
  readonly start: number;
  readonly end: number;
}

export function findActiveHashtagToken(text: string, caret: number): ActiveHashtagToken | null {
  if (caret < 0 || caret > text.length) return null;
  // Walk back from the caret looking for `#`. Bail on whitespace — a
  // `#` must follow input-start or a whitespace boundary to count.
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i]!;
    if (ch === "#") {
      const before = i === 0 ? undefined : text[i - 1];
      if (before === undefined || /\s/.test(before)) {
        return {
          query: text.slice(i + 1, caret).toLowerCase(),
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
 * Strip the `#<query>` token from `text` once the user has picked a
 * candidate. Returns the new text + caret offset where the token used
 * to start (so a trailing space inserted by the caller lands at the
 * right spot).
 */
export function dropHashtagToken(
  text: string,
  token: ActiveHashtagToken,
): { readonly nextText: string; readonly nextCaret: number } {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  // Collapse double spaces if the # token was sandwiched between two
  // word boundaries — feels nicer than leaving a stray gap.
  const collapsed = before.endsWith(" ") && after.startsWith(" ")
    ? `${before}${after.slice(1)}`
    : `${before}${after}`;
  return { nextText: collapsed, nextCaret: before.length };
}

export interface HashtagCandidate {
  readonly linkedRef: LinkedRef;
  readonly title: string;
  /** Optional secondary line (project name, etc.). */
  readonly subtitle?: string;
  /** Used by the caller to skip self-links (the conversation you're already in). */
  readonly threadId?: ThreadId;
}

/**
 * Substring filter against the candidate title — same forgiving match as
 * the `@user` directory uses, so `#fix` matches "Fix CI flake".
 */
export function filterHashtagCandidates(
  candidates: ReadonlyArray<HashtagCandidate>,
  query: string,
): ReadonlyArray<HashtagCandidate> {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return candidates;
  return candidates.filter((c) => c.title.toLowerCase().includes(q));
}
