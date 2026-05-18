import { describe, expect, it } from "vitest";

import type {
  InboxItem,
  SideThreadId,
  SideThreadMessageId,
  ThreadId,
  UserRef,
} from "@t3tools/contracts";

import { isInboxItemUnread } from "./inboxStore";

const mkUser = (id: string, displayName: string): UserRef => ({
  id: id as UserRef["id"],
  displayName: displayName as UserRef["displayName"],
});

const mkItem = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  sideThreadId: "st-1" as SideThreadId,
  parentThreadId: "thread-1" as ThreadId,
  anchorMessageId: "anchor-1" as SideThreadMessageId,
  lastMentionMessageId: "msg-1" as SideThreadMessageId,
  lastMentionAt: "2026-05-18T10:00:00.000Z",
  lastMentionAuthor: mkUser("u-1", "Alice"),
  lastMentionPreview: "hey @me look at this",
  mentionsCount: 1,
  ...overrides,
});

describe("isInboxItemUnread", () => {
  it("is unread when the thread was never visited", () => {
    expect(isInboxItemUnread(mkItem(), {})).toBe(true);
  });

  it("is unread when last visit predates the mention", () => {
    const item = mkItem({ lastMentionAt: "2026-05-18T10:00:00.000Z" });
    const visited = { "st-1": "2026-05-18T09:00:00.000Z" };
    expect(isInboxItemUnread(item, visited)).toBe(true);
  });

  it("is read when the user visited after the mention", () => {
    const item = mkItem({ lastMentionAt: "2026-05-18T10:00:00.000Z" });
    const visited = { "st-1": "2026-05-18T11:00:00.000Z" };
    expect(isInboxItemUnread(item, visited)).toBe(false);
  });
});
