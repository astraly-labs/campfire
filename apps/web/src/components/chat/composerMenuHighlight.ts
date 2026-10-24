export function resolveComposerMenuActiveItemId(input: {
  items: ReadonlyArray<{ id: string }>;
  highlightedItemId: string | null;
  currentSearchKey: string | null;
  highlightedSearchKey: string | null;
}): string | null {
  if (input.items.length === 0) {
    return null;
  }

  if (
    input.currentSearchKey === input.highlightedSearchKey &&
    input.highlightedItemId &&
    input.items.some((item) => item.id === input.highlightedItemId)
  ) {
    return input.highlightedItemId;
  }

  return input.items[0]?.id ?? null;
}

/** The item ArrowDown or ArrowUp moves the highlight to, wrapping at either end. */
export function nudgeComposerMenuItemId(
  items: ReadonlyArray<{ id: string }>,
  highlightedItemId: string | null,
  key: "ArrowDown" | "ArrowUp",
): string | null {
  if (items.length === 0) return null;
  const highlightedIndex = items.findIndex((item) => item.id === highlightedItemId);
  const normalizedIndex = highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
  const offset = key === "ArrowDown" ? 1 : -1;
  return items[(normalizedIndex + offset + items.length) % items.length]?.id ?? null;
}
