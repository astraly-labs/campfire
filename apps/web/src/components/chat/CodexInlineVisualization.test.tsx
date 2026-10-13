import { describe, expect, it } from "vite-plus/test";
import { splitCodexInlineVisualizations } from "./CodexInlineVisualization";

describe("splitCodexInlineVisualizations", () => {
  it("replaces standalone visualization directives without consuming surrounding markdown", () => {
    expect(
      splitCodexInlineVisualizations(
        'Before\n\n::codex-inline-vis{file="playbooks-concept.html"}\n\nAfter',
      ),
    ).toEqual([
      { kind: "markdown", text: "Before\n\n", offset: 0 },
      { kind: "visualization", fileName: "playbooks-concept.html", offset: 8 },
      { kind: "markdown", text: "\nAfter", offset: 58 },
    ]);
  });

  it("leaves inline text and unsafe paths as markdown", () => {
    const text = 'See ::codex-inline-vis{file="../secret.html"}';
    expect(splitCodexInlineVisualizations(text)).toEqual([{ kind: "markdown", text, offset: 0 }]);
  });
});
