import {
  SideThreadQuotedExcerpt,
  type AssistantCitation,
  type MessageId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** What a team discussion draft quotes: an agent message, narrowed to a passage when one was selected. */
export interface SideThreadDraftQuote {
  readonly messageId: MessageId;
  readonly excerpt: SideThreadQuotedExcerpt | null;
}

const isQuotedExcerpt = Schema.is(SideThreadQuotedExcerpt);

/**
 * Keeps the citation's locator so the passage can be found again. A selection
 * the contract would reject still quotes its message, without the passage.
 */
export function sideThreadDraftQuoteFromCitation(
  citation: AssistantCitation,
): SideThreadDraftQuote {
  const excerpt = {
    text: citation.text,
    start: citation.start,
    end: citation.end,
    prefix: citation.prefix,
    suffix: citation.suffix,
  };
  return { messageId: citation.messageId, excerpt: isQuotedExcerpt(excerpt) ? excerpt : null };
}

/** What a quote shows: its passage, or else the quoted message's markdown as plain text. */
export function sideThreadQuoteText(
  excerpt: SideThreadQuotedExcerpt | null | undefined,
  sourceMarkdown: string | undefined,
): string {
  return excerpt ? sideThreadExcerptText(excerpt.text) : markdownPreviewText(sourceMarkdown ?? "");
}

/** The passage as the reader saw it, without selection edge whitespace or stacked blank lines. */
export function sideThreadExcerptText(text: string): string {
  return text
    .replace(/[^\S\n]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * One line of plain text from agent markdown, for previews of a whole quoted
 * message. It removes the syntax a reader would otherwise see literally; it is
 * not a renderer.
 */
export function markdownPreviewText(markdown: string): string {
  return markdown
    .replace(/^ {0,3}(?:`{3,}|~{3,}).*$/gm, "")
    .replace(/^ {0,3}([-*_])(?: *\1){2,} *$/gm, "")
    .replace(/^ {0,3}(?:#{1,6}[ \t]+|>[ \t]?)+/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+([^`\n]+)`+/g, "$1")
    .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}
