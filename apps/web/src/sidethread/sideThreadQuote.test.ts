import {
  EnvironmentId,
  MessageId,
  SIDE_THREAD_QUOTE_MAX_TEXT_LENGTH,
  ThreadId,
  type AssistantCitation,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  markdownPreviewText,
  sideThreadDraftQuoteFromCitation,
  sideThreadExcerptText,
} from "./sideThreadQuote";

const citation = (overrides: Partial<AssistantCitation> = {}): AssistantCitation => ({
  version: 1,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("agent-message"),
  text: "At 10:39 UTC",
  start: 21,
  end: 33,
  prefix: "Thursday is settled. ",
  suffix: " the deploy finished.",
  ...overrides,
});

describe("sideThreadDraftQuoteFromCitation", () => {
  it("keeps the passage and everything that locates it in its message", () => {
    expect(sideThreadDraftQuoteFromCitation(citation({ comment: "ignored" }))).toEqual({
      messageId: "agent-message",
      excerpt: {
        text: "At 10:39 UTC",
        start: 21,
        end: 33,
        prefix: "Thursday is settled. ",
        suffix: " the deploy finished.",
      },
    });
  });

  it("accepts a passage at the length limit", () => {
    const text = "a".repeat(SIDE_THREAD_QUOTE_MAX_TEXT_LENGTH);
    const quote = sideThreadDraftQuoteFromCitation(
      citation({ text, start: 0, end: text.length, prefix: "", suffix: "" }),
    );
    expect(quote.excerpt?.text).toBe(text);
  });

  it.each([
    ["is longer than the limit", { text: "a".repeat(SIDE_THREAD_QUOTE_MAX_TEXT_LENGTH + 1) }],
    ["is only whitespace", { text: " \n " }],
    ["has an empty range", { start: 21, end: 21 }],
  ])("quotes the whole message when the passage %s", (_case, overrides) => {
    expect(sideThreadDraftQuoteFromCitation(citation(overrides))).toEqual({
      messageId: "agent-message",
      excerpt: null,
    });
  });
});

describe("sideThreadExcerptText", () => {
  it("trims the selection edges and stacked blank lines but keeps line breaks", () => {
    expect(sideThreadExcerptText("\n  First line  \r\nSecond\n\n\n\nThird \n")).toBe(
      "First line\nSecond\n\nThird",
    );
  });
});

describe("markdownPreviewText", () => {
  it.each([
    [
      "**Jeudi, c'est réglé.** À 10:39 UTC le déploiement est terminé.",
      "Jeudi, c'est réglé. À 10:39 UTC le déploiement est terminé.",
    ],
    [
      "## Plan\n\n- Run `vp test`\n- Read [the docs](https://example.com/docs)\n1. Ship it",
      "Plan Run vp test Read the docs Ship it",
    ],
    [
      "> Quoted _emphasis_ and *more*, not snake_case_name",
      "Quoted emphasis and more, not snake_case_name",
    ],
    [
      "```ts\nconst total = 2 * 3 * 4;\n```\n\n---\n\n~~old~~ new",
      "const total = 2 * 3 * 4; old new",
    ],
  ])("shows %j as plain text", (markdown, text) => {
    expect(markdownPreviewText(markdown)).toBe(text);
  });
});
