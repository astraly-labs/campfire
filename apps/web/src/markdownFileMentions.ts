// Pulls file-link mentions out of agent-authored markdown so other surfaces
// (preview drawer, Files popover) can reuse the same detection logic as the
// chat renderer without re-implementing it.

import {
  type MarkdownFileLinkMeta,
  normalizeMarkdownLinkDestination,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";

const MARKDOWN_LINK_HREF_PATTERN = /\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

export function extractMarkdownLinkHrefs(text: string): string[] {
  const hrefs: string[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = match[1]?.trim();
    if (!href) continue;
    hrefs.push(href);
  }
  return hrefs;
}

export function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  return rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
}

export interface FileMentionsByPath {
  readonly orderedFilePaths: ReadonlyArray<string>;
  readonly metaByFilePath: ReadonlyMap<string, MarkdownFileLinkMeta>;
}

// Given a sequence of text blobs (typically in chronological message order),
// return file mentions with the most-recently-mentioned ones first. Each path
// appears at most once — the meta from its earliest occurrence wins, which
// keeps the displayed label stable across re-renders.
export function collectFileMentions(
  texts: ReadonlyArray<string>,
  cwd: string | undefined,
): FileMentionsByPath {
  const metaByFilePath = new Map<string, MarkdownFileLinkMeta>();
  const lastMentionIndexByFilePath = new Map<string, number>();

  texts.forEach((text, index) => {
    if (!text) return;
    const seenHrefsInText = new Set<string>();
    for (const rawHref of extractMarkdownLinkHrefs(text)) {
      const normalizedHref = normalizeMarkdownLinkHrefKey(rawHref);
      if (seenHrefsInText.has(normalizedHref)) continue;
      seenHrefsInText.add(normalizedHref);

      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd);
      if (!meta) continue;

      if (!metaByFilePath.has(meta.filePath)) {
        metaByFilePath.set(meta.filePath, meta);
      }
      lastMentionIndexByFilePath.set(meta.filePath, index);
    }
  });

  const orderedFilePaths = [...lastMentionIndexByFilePath.entries()]
    .toSorted(([, a], [, b]) => b - a)
    .map(([filePath]) => filePath);

  return { orderedFilePaths, metaByFilePath };
}
