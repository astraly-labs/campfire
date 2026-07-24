import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { MarkdownWorkspaceImage } from "./MarkdownWorkspaceImage";

vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({
    _tag: "Success",
    url: "http://localhost:13774/api/assets/signed/playbooks-concept.png",
  }),
}));

it("renders a local workspace image through its signed asset URL", () => {
  const html = renderToStaticMarkup(
    <MarkdownWorkspaceImage
      cwd="/Users/julius/Library/Application Support/Campfire/worktree"
      threadRef={{
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
      }}
      src="/Users/julius/Library/Application Support/Campfire/worktree/playbooks-concept.png"
      alt="Maquette Playbooks"
    />,
  );

  expect(html).toContain('href="http://localhost:13774/api/assets/signed/playbooks-concept.png"');
  expect(html).toContain('src="http://localhost:13774/api/assets/signed/playbooks-concept.png"');
  expect(html).toContain('alt="Maquette Playbooks"');
});
