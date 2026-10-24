import { describe, expect, it } from "vite-plus/test";

import { nudgeComposerMenuItemId, resolveComposerMenuActiveItemId } from "./composerMenuHighlight";

describe("resolveComposerMenuActiveItemId", () => {
  const items = [{ id: "top" }, { id: "second" }, { id: "third" }] as const;

  it("defaults to the first item when nothing is highlighted", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: null,
        currentSearchKey: "skill:u",
        highlightedSearchKey: null,
      }),
    ).toBe("top");
  });

  it("preserves the highlighted item within the same query", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: "second",
        currentSearchKey: "skill:u",
        highlightedSearchKey: "skill:u",
      }),
    ).toBe("second");
  });

  it("resets to the top result when the query changes", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: "second",
        currentSearchKey: "skill:ui",
        highlightedSearchKey: "skill:u",
      }),
    ).toBe("top");
  });

  it("falls back to the first item when the highlighted item disappears", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: "missing",
        currentSearchKey: "skill:ui",
        highlightedSearchKey: "skill:ui",
      }),
    ).toBe("top");
  });

  it("clears the active result while async results are empty and resolves against restored results", () => {
    const search = {
      highlightedItemId: "second",
      currentSearchKey: "path:src",
      highlightedSearchKey: "path:src",
    };
    const cleared = resolveComposerMenuActiveItemId({ ...search, items: [] });
    expect(cleared).toBeNull();
    expect(
      resolveComposerMenuActiveItemId({
        ...search,
        highlightedItemId: cleared,
        items: [{ id: "new-result" }, { id: "second" }],
      }),
    ).toBe("new-result");
  });
});

describe("nudgeComposerMenuItemId", () => {
  const items = [{ id: "top" }, { id: "second" }, { id: "third" }] as const;

  it("moves down and up from the highlighted item", () => {
    expect(nudgeComposerMenuItemId(items, "top", "ArrowDown")).toBe("second");
    expect(nudgeComposerMenuItemId(items, "second", "ArrowUp")).toBe("top");
  });

  it("wraps at both ends", () => {
    expect(nudgeComposerMenuItemId(items, "third", "ArrowDown")).toBe("top");
    expect(nudgeComposerMenuItemId(items, "top", "ArrowUp")).toBe("third");
  });

  it("starts at the top on ArrowDown and the bottom on ArrowUp with nothing highlighted", () => {
    expect(nudgeComposerMenuItemId(items, null, "ArrowDown")).toBe("top");
    expect(nudgeComposerMenuItemId(items, null, "ArrowUp")).toBe("third");
  });

  it("has nothing to highlight in an empty menu", () => {
    expect(nudgeComposerMenuItemId([], "top", "ArrowDown")).toBeNull();
  });
});
