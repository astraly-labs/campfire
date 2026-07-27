import { describe, expect, it } from "vite-plus/test";

import { githubPullRequestNumber } from "./ChatMarkdown";

describe("githubPullRequestNumber", () => {
  it("extracts GitHub pull request numbers and rejects unrelated links", () => {
    expect(githubPullRequestNumber("https://github.com/EvolveArt/campfire/pull/1")).toBe(1);
    expect(githubPullRequestNumber("https://github.com/org/repo/pull/389/files")).toBe(389);
    expect(githubPullRequestNumber("https://example.com/org/repo/pull/1")).toBeNull();
    expect(githubPullRequestNumber("https://github.com/org/repo/issues/1")).toBeNull();
  });
});
