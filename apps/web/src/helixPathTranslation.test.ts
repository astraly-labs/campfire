import { describe, expect, it } from "vitest";
import { buildHelixUrl, translateHelixPath } from "./helixPathTranslation";

describe("translateHelixPath", () => {
  it("rewrites the matching remote prefix to the local one", () => {
    const mappings = [{ remotePrefix: "/Users/shared/work", localPrefix: "/Users/me/sshfs/work" }];
    expect(translateHelixPath("/Users/shared/work/repo/file.ts", mappings)).toBe(
      "/Users/me/sshfs/work/repo/file.ts",
    );
  });

  it("returns null when no mapping matches", () => {
    const mappings = [{ remotePrefix: "/srv/code", localPrefix: "/home/me/code" }];
    expect(translateHelixPath("/var/log/file.txt", mappings)).toBeNull();
  });

  it("picks the longest matching prefix", () => {
    const mappings = [
      { remotePrefix: "/Users", localPrefix: "/A" },
      { remotePrefix: "/Users/shared/work", localPrefix: "/B" },
      { remotePrefix: "/Users/shared", localPrefix: "/C" },
    ];
    expect(translateHelixPath("/Users/shared/work/repo", mappings)).toBe("/B/repo");
  });

  it("treats prefix as a path boundary, not a substring", () => {
    const mappings = [{ remotePrefix: "/foo", localPrefix: "/bar" }];
    expect(translateHelixPath("/foobar/baz", mappings)).toBeNull();
    expect(translateHelixPath("/foo", mappings)).toBe("/bar");
    expect(translateHelixPath("/foo/baz", mappings)).toBe("/bar/baz");
  });

  it("normalizes trailing slashes on both prefixes", () => {
    const mappings = [{ remotePrefix: "/srv/", localPrefix: "/mnt/srv/" }];
    expect(translateHelixPath("/srv/file.ts", mappings)).toBe("/mnt/srv/file.ts");
  });
});

describe("buildHelixUrl", () => {
  it("URI-encodes path components while keeping slashes", () => {
    expect(buildHelixUrl("/Users/me/A B/file?#.ts")).toBe("helix:///Users/me/A%20B/file%3F%23.ts");
  });
});
