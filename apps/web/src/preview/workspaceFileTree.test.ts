import { describe, expect, it } from "vitest";

import { buildFileTree, filterPaths } from "./workspaceFileTree";

describe("buildFileTree", () => {
  it("groups paths into nested directories with directories before files", () => {
    const root = buildFileTree([
      "README.md",
      "apps/web/src/main.tsx",
      "apps/web/src/index.ts",
      "apps/server/src/server.ts",
      "package.json",
    ]);

    expect(root.path).toBe("");
    expect(root.children.map((c) => `${c.kind}:${c.name}`)).toEqual([
      "directory:apps",
      "file:package.json",
      "file:README.md",
    ]);

    const apps = root.children.find((c) => c.kind === "directory" && c.name === "apps");
    expect(apps).toBeDefined();
    if (!apps || apps.kind !== "directory") throw new Error("apps not a directory");
    expect(apps.children.map((c) => `${c.kind}:${c.name}`)).toEqual([
      "directory:server",
      "directory:web",
    ]);

    const web = apps.children.find((c) => c.kind === "directory" && c.name === "web");
    if (!web || web.kind !== "directory") throw new Error("web not a directory");
    expect(web.path).toBe("apps/web");

    const webSrc = web.children[0];
    if (!webSrc || webSrc.kind !== "directory") throw new Error("web/src missing");
    expect(webSrc.children.map((c) => `${c.kind}:${c.name}:${c.path}`)).toEqual([
      "file:index.ts:apps/web/src/index.ts",
      "file:main.tsx:apps/web/src/main.tsx",
    ]);
  });

  it("ignores empty paths and stray slashes", () => {
    const root = buildFileTree(["", "a//b.ts", "c.ts"]);
    expect(root.children.map((c) => `${c.kind}:${c.name}`)).toEqual(["directory:a", "file:c.ts"]);
  });

  it("returns an empty root when given no paths", () => {
    const root = buildFileTree([]);
    expect(root.children).toEqual([]);
  });
});

describe("filterPaths", () => {
  const paths = ["apps/web/src/main.tsx", "apps/server/src/server.ts", "README.md", "package.json"];

  it("returns an empty list when query is blank", () => {
    expect(filterPaths(paths, "")).toEqual([]);
    expect(filterPaths(paths, "   ")).toEqual([]);
  });

  it("matches case-insensitive substring on the full path", () => {
    expect(filterPaths(paths, "server")).toEqual(["apps/server/src/server.ts"]);
    expect(filterPaths(paths, "MAIN")).toEqual(["apps/web/src/main.tsx"]);
    expect(filterPaths(paths, "json")).toEqual(["package.json"]);
  });

  it("caps results at 500 entries", () => {
    const many = Array.from({ length: 600 }, (_, i) => `dir/file-${i}.ts`);
    expect(filterPaths(many, "file").length).toBe(500);
  });
});
