import { describe, expect, it } from "vitest";

import { colorIndexForUserId, initialsFor } from "./AvatarStack";

describe("initialsFor", () => {
  it("falls back to ? when displayName is empty or whitespace", () => {
    expect(initialsFor("")).toBe("?");
    expect(initialsFor("   ")).toBe("?");
  });

  it("returns the first letter, uppercase, for a single-word name", () => {
    expect(initialsFor("alice")).toBe("A");
    expect(initialsFor("Matthias")).toBe("M");
  });

  it("returns first + last initial for multi-word names", () => {
    expect(initialsFor("Matteo Combe")).toBe("MC");
    expect(initialsFor("Jean Pierre Dupont")).toBe("JD");
  });
});

describe("colorIndexForUserId", () => {
  it("is deterministic for the same id", () => {
    expect(colorIndexForUserId("u-matthias")).toBe(colorIndexForUserId("u-matthias"));
  });

  it("returns indices inside the palette range", () => {
    for (const id of ["a", "b", "u-alice", "u-bob", "u-matteo", "u-very-long-id-string"]) {
      const idx = colorIndexForUserId(id);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(6);
    }
  });

  it("spreads two different ids", () => {
    // Not strictly required by the contract, but if every user lands on
    // the same hue this hash is useless — sanity-check that at least two
    // common ids differ.
    const a = colorIndexForUserId("u-alice");
    const b = colorIndexForUserId("u-bob");
    expect(a).not.toBe(b);
  });
});
