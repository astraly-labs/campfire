import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CodexInlineVisualization,
  splitCodexInlineVisualizations,
} from "./CodexInlineVisualization";

vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({
    _tag: "Success",
    url: "http://localhost:13774/api/assets/signed/playbooks-concept.html",
  }),
}));

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

  it("renders the resolved visualization in a sandboxed iframe", () => {
    const html = renderToStaticMarkup(
      <CodexInlineVisualization
        threadRef={{
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        }}
        fileName="playbooks-concept.html"
      />,
    );

    expect(html).toContain("<iframe");
    expect(html).toContain('title="playbooks-concept.html"');
    expect(html).toContain(
      'sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"',
    );
  });
});
