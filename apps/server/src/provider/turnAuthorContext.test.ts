import { describe, expect, it } from "vite-plus/test";

import { providerTurnText } from "./turnAuthorContext.ts";

describe("providerTurnText", () => {
  it("returns the plain prompt when the author is unknown", () => {
    expect(providerTurnText({ input: "  fix the build  " })).toBe("fix the build");
    expect(providerTurnText({})).toBe("");
  });

  it("prepends the author and the author's own memory", () => {
    expect(
      providerTurnText({
        input: "fix the build",
        author: {
          subject: "google:alice",
          displayName: "Alice",
          email: "alice@example.com",
          memory: "Prefers French replies.",
        },
      }),
    ).toBe(
      [
        "[Message from: Alice (alice@example.com)]",
        "[User memory for Alice:",
        "Prefers French replies.",
        "]",
        "",
        "fix the build",
      ].join("\n"),
    );
  });

  it("sends the author block alone for attachment-only turns", () => {
    expect(providerTurnText({ author: { subject: "google:bob", displayName: "Bob" } })).toBe(
      "[Message from: Bob]",
    );
  });
});
