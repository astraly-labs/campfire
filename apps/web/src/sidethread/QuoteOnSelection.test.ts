import { describe, expect, it } from "vite-plus/test";

import { formatSideThreadQuote } from "./QuoteOnSelection";

describe("formatSideThreadQuote", () => {
  it("turns a multiline selection into a markdown quote", () => {
    expect(formatSideThreadQuote("first\n\nsecond  ")).toBe("> first\n>\n> second\n\n");
  });
});
