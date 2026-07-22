import { ThreadId } from "@t3tools/contracts";
import { sideThreadIdForThread } from "@t3tools/shared/sideThread";
import { describe, expect, it } from "vitest";

describe("SideThreadDrawer", () => {
  it("derives one stable discussion id per agent thread", () => {
    const first = sideThreadIdForThread(ThreadId.make("thread-1"));
    expect(first).toBe("thread:thread-1");
    expect(sideThreadIdForThread(ThreadId.make("thread-1"))).toBe(first);
    expect(sideThreadIdForThread(ThreadId.make("thread-2"))).not.toBe(first);
  });
});
