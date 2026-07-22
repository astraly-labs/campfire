import { SideThreadId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { isSideThreadIdForThread, sideThreadIdForThread } from "./sideThread.ts";

describe("sideThreadIdForThread", () => {
  it("derives one stable side thread id per agent thread", () => {
    const threadId = ThreadId.make("agent-thread-1");
    expect(sideThreadIdForThread(threadId)).toBe("thread:agent-thread-1");
    expect(isSideThreadIdForThread(sideThreadIdForThread(threadId), threadId)).toBe(true);
    expect(isSideThreadIdForThread(SideThreadId.make("message:legacy"), threadId)).toBe(false);
  });
});
