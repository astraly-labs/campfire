import { describe, expect, it } from "vite-plus/test";

import { withTurnAuthorContext } from "./turnAuthorContext.ts";

const alice = { subject: "google:alice", displayName: "Alice" };

describe("withTurnAuthorContext", () => {
  it("leaves messages without a signed-in author unchanged", () => {
    expect(withTurnAuthorContext({ author: null, text: "fix the build" })).toBe("fix the build");
    expect(withTurnAuthorContext({ author: undefined, text: "fix the build" })).toBe(
      "fix the build",
    );
  });

  it("names the sender and their memory in front of the text", () => {
    expect(
      withTurnAuthorContext({
        author: alice,
        email: "alice@example.com",
        memory: "Prefers French replies.",
        text: "fix the build",
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

  it("names only the sender when no email or memory is known", () => {
    expect(withTurnAuthorContext({ author: alice, text: "hi" })).toBe(
      "[Message from: Alice]\n\nhi",
    );
  });

  it("sends the block alone for an attachment-only message", () => {
    expect(withTurnAuthorContext({ author: alice, text: "  " })).toBe("[Message from: Alice]");
  });

  it("passes slash commands through so providers still expand them", () => {
    expect(
      withTurnAuthorContext({ author: alice, memory: "Prefers French.", text: " /compact" }),
    ).toBe(" /compact");
    expect(withTurnAuthorContext({ author: alice, text: "/goal ship it" })).toBe("/goal ship it");
  });
});
