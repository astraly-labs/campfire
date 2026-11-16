import { describe, expect, it } from "@effect/vitest";

import { lowDiskNotice } from "./lowDiskNotice.ts";

const GIB = 1024 ** 3;

describe("lowDiskNotice", () => {
  it("shows nothing while no volume is low", () => {
    expect(lowDiskNotice(undefined)).toBeNull();
    expect(lowDiskNotice([])).toBeNull();
  });

  it("rounds free space down and warns about saving when the data volume is low", () => {
    expect(
      lowDiskNotice([
        { role: "state", path: "/data", freeBytes: 12.9 * GIB, totalBytes: 500 * GIB },
        { role: "worktrees", path: "/ssd/worktrees", freeBytes: GIB / 2, totalBytes: GIB },
      ]),
    ).toEqual({
      title: "Low disk space on this server",
      description:
        "12 GB left where Campfire keeps its data; less than 1 GB left where worktrees are created. Free some space or messages may fail to save.",
      paths: ["/data", "/ssd/worktrees"],
    });
  });

  it("warns about worktrees, not messages, when only the worktrees volume is low", () => {
    expect(
      lowDiskNotice([
        { role: "worktrees", path: "/ssd/worktrees", freeBytes: GIB / 2, totalBytes: 9 * GIB },
      ])?.description,
    ).toBe(
      "Less than 1 GB left where worktrees are created. Free some space or new worktrees may fail to be created.",
    );
  });
});
