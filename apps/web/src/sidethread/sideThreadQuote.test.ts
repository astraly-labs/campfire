import {
  EnvironmentId,
  MessageId,
  SIDE_THREAD_QUOTE_MAX_TEXT_LENGTH,
  ThreadId,
  type AssistantCitation,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createAssistantTextSelector,
  findAssistantCitationText,
} from "~/lib/assistantTextSelection";
import {
  markdownPreviewText,
  sideThreadDraftQuoteFromCitation,
  sideThreadExcerptText,
  sideThreadQuoteText,
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

describe("locating a quoted passage in its message", () => {
  // The selection toolbar's text stream: one line break between rendered blocks.
  const rendered = "Thursday is settled.\nAt 10:39 UTC the deploy finished. At 10:39 UTC we left.";
  const quoteAt = (start: number, end: number) => {
    const selector = createAssistantTextSelector(rendered, start, end)!;
    return sideThreadDraftQuoteFromCitation(citation(selector)).excerpt!;
  };

  it("finds a repeated passage at the occurrence that was selected", () => {
    const second = rendered.lastIndexOf("At 10:39 UTC");
    const excerpt = quoteAt(second, second + "At 10:39 UTC".length);
    expect(findAssistantCitationText(rendered, excerpt)).toEqual({
      start: second,
      end: second + "At 10:39 UTC".length,
    });
  });

  it("finds nothing once the message no longer contains the passage", () => {
    const excerpt = quoteAt(rendered.indexOf("the deploy"), rendered.indexOf(" finished"));
    expect(findAssistantCitationText(rendered.replace("deploy", "rollout"), excerpt)).toBeNull();
  });
});

describe("sideThreadQuoteText", () => {
  const source = "**Thursday is settled.** At 10:39 UTC the deploy finished.";

  it("shows the quoted passage rather than the start of its message", () => {
    const { excerpt } = sideThreadDraftQuoteFromCitation(citation());
    expect(sideThreadQuoteText(excerpt, source)).toBe("At 10:39 UTC");
  });

  it("shows a passage as rendered text, keeping its literal symbols and line breaks", () => {
    const text = "Total: 2 * 3 * 4 = *24*\nShip it";
    const { excerpt } = sideThreadDraftQuoteFromCitation(
      citation({ text, start: 0, end: text.length, prefix: "", suffix: "" }),
    );
    expect(sideThreadQuoteText(excerpt, source)).toBe(text);
  });

  it("shows a message quoted before passages were stored as plain text", () => {
    expect(sideThreadQuoteText(undefined, source)).toBe(
      "Thursday is settled. At 10:39 UTC the deploy finished.",
    );
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
