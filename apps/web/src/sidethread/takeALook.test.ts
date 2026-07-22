import { describe, expect, it } from "vitest";

import {
  buildTakeALookText,
  mentionHandleForGoogleUser,
  toggleTakeALookSelection,
} from "./takeALook";

describe("Take a look", () => {
  it("builds stable readable Google-account mentions", () => {
    expect(
      buildTakeALookText([
        { subject: "google:alice", displayName: "Alice Example" },
        { subject: "google:bob", displayName: "Bób Dev" },
      ]),
    ).toBe("@alice.example @bob.dev please take a look!");
    expect(mentionHandleForGoogleUser({ subject: "google:123", displayName: "???" })).toBe("123");
  });

  it("toggles selected Google subjects immutably", () => {
    const first = toggleTakeALookSelection(new Set(), "google:alice");
    expect([...first]).toEqual(["google:alice"]);
    expect([...toggleTakeALookSelection(first, "google:alice")]).toEqual([]);
  });
});
