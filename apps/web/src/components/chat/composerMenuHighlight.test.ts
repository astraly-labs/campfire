import { describe, expect, it } from "vite-plus/test";

import { nudgeComposerMenuItemId, resolveComposerMenuActiveItemId } from "./composerMenuHighlight";

describe("resolveComposerMenuActiveItemId", () => {
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
