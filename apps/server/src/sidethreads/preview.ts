/**
 * Shared single-line preview helper for side-thread messages.
 *
 * Used by the projection pipeline (to pin a mention preview at write time) and
 * by the inbox read model (to derive an activity preview at read time). Kept
 * in one place so both surfaces truncate identically.
 *
 * @module sidethreads/preview
 */

export const PREVIEW_MAX_CHARS = 240;

/**
 * Single-line, length-capped preview of a side-thread message. Stays > 1 char
 * so the contract's `TrimmedNonEmptyString` decoder doesn't reject it on read
 * (empty/whitespace-only text collapses to a single ellipsis).
 */
export const truncateForPreview = (text: string): string => {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length === 0) return "…";
  if (singleLine.length <= PREVIEW_MAX_CHARS) return singleLine;
  return `${singleLine.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
};
