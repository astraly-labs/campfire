import {
  MessageId,
  SideThreadId,
  SideThreadMessageId,
  ThreadId,
  type SideThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  canonicalizeSideThreads,
  isSideThreadIdForThread,
  sideThreadIdForThread,
} from "./sideThread.ts";

describe("sideThreadIdForThread", () => {
  it("derives one stable side thread id per agent thread", () => {
    const threadId = ThreadId.make("agent-thread-1");
    expect(sideThreadIdForThread(threadId)).toBe("thread:agent-thread-1");
    expect(isSideThreadIdForThread(sideThreadIdForThread(threadId), threadId)).toBe(true);
    expect(isSideThreadIdForThread(SideThreadId.make("message:legacy"), threadId)).toBe(false);
  });

  it("merges legacy per-message discussions without losing messages or read markers", () => {
    const threadId = ThreadId.make("agent-thread-1");
    const alice = { subject: "google:alice", displayName: "Alice" };
    const bob = { subject: "google:bob", displayName: "Bob" };
    const sideThreads = [
      {
        id: SideThreadId.make("message:old-1"),
        anchorMessageId: MessageId.make("agent-message-1"),
        createdBy: alice,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:02:00.000Z",
        archivedAt: null,
        messages: [
          {
            id: SideThreadMessageId.make("side-message-1"),
            author: alice,
            text: "first",
            createdAt: "2026-01-01T00:01:00.000Z",
          },
        ],
        readBy: [{ user: alice, lastReadAt: "2026-01-01T00:01:00.000Z" }],
      },
      {
        id: SideThreadId.make("message:old-2"),
        createdBy: bob,
        createdAt: "2026-01-01T00:03:00.000Z",
        updatedAt: "2026-01-01T00:05:00.000Z",
        archivedAt: null,
        messages: [
          {
            id: SideThreadMessageId.make("side-message-2"),
            author: bob,
            text: "second",
            createdAt: "2026-01-01T00:04:00.000Z",
          },
        ],
        readBy: [
          { user: alice, lastReadAt: "2026-01-01T00:05:00.000Z" },
          { user: bob, lastReadAt: "2026-01-01T00:04:00.000Z" },
        ],
      },
    ] satisfies ReadonlyArray<SideThread>;

    expect(canonicalizeSideThreads(threadId, sideThreads)).toEqual([
      {
        ...sideThreads[0],
        id: SideThreadId.make("thread:agent-thread-1"),
        updatedAt: "2026-01-01T00:05:00.000Z",
        messages: [sideThreads[0]!.messages[0], sideThreads[1]!.messages[0]],
        readBy: [
          { user: alice, lastReadAt: "2026-01-01T00:05:00.000Z" },
          { user: bob, lastReadAt: "2026-01-01T00:04:00.000Z" },
        ],
      },
    ]);
  });
});
