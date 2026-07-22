import { describe, expect, it } from "vitest";

import { formatSideThreadQuote } from "./QuoteOnSelection";

describe("formatSideThreadQuote", () => {
  it("turns a multiline selection into a markdown quote", () => {
    expect(formatSideThreadQuote("first\n\nsecond  ")).toBe("> first\n>\n> second\n\n");
  });
});
