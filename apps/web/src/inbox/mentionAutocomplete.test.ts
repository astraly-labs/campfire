import { describe, expect, it } from "vitest";

import type { UserRef } from "@t3tools/contracts";

import {
  applyMentionSelection,
  findActiveMentionToken,
  mentionHandleForUser,
  renderTextWithMentions,
} from "./mentionAutocomplete";

const mkUser = (id: string, displayName: string): UserRef => ({
  id: id as UserRef["id"],
  displayName: displayName as UserRef["displayName"],
});

describe("findActiveMentionToken", () => {
  it("returns null when there is no @", () => {
    expect(findActiveMentionToken("hello world", 5)).toBeNull();
  });

  it("detects an empty token immediately after @", () => {
    const text = "hello @";
    const token = findActiveMentionToken(text, text.length);
    expect(token).toEqual({ query: "", start: 6, end: 7 });
  });

  it("detects a token in progress with a query", () => {
    const text = "ping @matt";
    const token = findActiveMentionToken(text, text.length);
    expect(token).toEqual({ query: "matt", start: 5, end: 10 });
  });

  it("requires whitespace before @ (skips email-like input)", () => {
    const text = "ping foo@bar";
    expect(findActiveMentionToken(text, text.length)).toBeNull();
  });

  it("stops at whitespace after the @ token", () => {
    const text = "ping @matt now";
    expect(findActiveMentionToken(text, text.length)).toBeNull();
  });

  it("accepts @ at the very start of input", () => {
    const text = "@alice";
    const token = findActiveMentionToken(text, text.length);
    expect(token).toEqual({ query: "alice", start: 0, end: 6 });
  });
});

describe("applyMentionSelection", () => {
  it("replaces the active token with @<handle> and a trailing space", () => {
    const text = "ping @ma";
    const token = findActiveMentionToken(text, text.length);
    expect(token).not.toBeNull();
    const { nextText, nextCaret } = applyMentionSelection(text, token!, mkUser("u-1", "Matthias"));
    expect(nextText).toBe("ping @matthias ");
    expect(nextCaret).toBe(nextText.length);
  });

  it("preserves text after the caret", () => {
    const text = "@al rest";
    const token = findActiveMentionToken(text, 3);
    const { nextText } = applyMentionSelection(text, token!, mkUser("u-2", "Alice"));
    expect(nextText).toBe("@alice  rest");
  });
});

describe("mentionHandleForUser", () => {
  it("slugifies accents and spaces", () => {
    expect(mentionHandleForUser(mkUser("u", "Matthias Édouard"))).toBe("matthias-edouard");
  });

  it("falls back to 'user' for empty handles", () => {
    expect(mentionHandleForUser(mkUser("u", "🎉🎉"))).toBe("user");
  });
});

describe("renderTextWithMentions", () => {
  it("returns the full text as a single segment when there are no mentions", () => {
    const segments = renderTextWithMentions("hello world", []);
    expect(segments).toEqual([{ kind: "text", text: "hello world" }]);
  });

  it("splits text around a resolved @mention", () => {
    const matteo = mkUser("u-matteo", "Matteo");
    const segments = renderTextWithMentions("ping @matteo please", [matteo]);
    expect(segments).toEqual([
      { kind: "text", text: "ping " },
      { kind: "mention", user: matteo, handle: "matteo" },
      { kind: "text", text: " please" },
    ]);
  });

  it("ignores @handles that don't match any pinned mention (e.g. typo)", () => {
    const matteo = mkUser("u-matteo", "Matteo");
    const segments = renderTextWithMentions("ping @nobody and @matteo", [matteo]);
    expect(segments).toEqual([
      { kind: "text", text: "ping @nobody and " },
      { kind: "mention", user: matteo, handle: "matteo" },
    ]);
  });

  it("handles a mention at the very start of the text", () => {
    const alice = mkUser("u-alice", "Alice");
    const segments = renderTextWithMentions("@alice ?", [alice]);
    expect(segments).toEqual([
      { kind: "mention", user: alice, handle: "alice" },
      { kind: "text", text: " ?" },
    ]);
  });
});
