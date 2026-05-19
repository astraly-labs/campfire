import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EnvironmentApi,
  InboxItem,
  SideThreadId,
  SideThreadMessageId,
  ThreadId,
  UserId,
  UserRef,
} from "@t3tools/contracts";

import { isInboxItemUnread, useInboxStore } from "./inboxStore";

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

describe("useInboxStore", () => {
  beforeEach(() => {
    useInboxStore.getState().reset();
  });

  it("removes the matching item on a 'removed' stream event", () => {
    const a = mkItem({ sideThreadId: "st-a" as SideThreadId });
    const b = mkItem({ sideThreadId: "st-b" as SideThreadId });
    useInboxStore.setState({ items: [a, b] });

    useInboxStore.getState().applyStreamEvent({
      kind: "removed",
      sideThreadId: "st-a" as SideThreadId,
    });

    expect(useInboxStore.getState().items.map((item) => item.sideThreadId)).toEqual(["st-b"]);
  });

  it("dismiss optimistically removes the row before the server acks", async () => {
    const a = mkItem({ sideThreadId: "st-a" as SideThreadId });
    const b = mkItem({ sideThreadId: "st-b" as SideThreadId });
    useInboxStore.setState({ items: [a, b] });

    let resolveDispatch: (() => void) | undefined;
    const dispatchPromise = new Promise<void>((resolve) => {
      resolveDispatch = resolve;
    });
    const dispatchCommand = vi.fn(
      (_command: { type: string; sideThreadId: string; userId: string }) => dispatchPromise,
    );
    const api = { sideThread: { dispatchCommand } } as unknown as EnvironmentApi;

    const dismissPromise = useInboxStore
      .getState()
      .dismiss(api, "st-a" as SideThreadId, "u-1" as UserId);

    // Optimistic state: st-a already gone while server hasn't acked.
    expect(useInboxStore.getState().items.map((item) => item.sideThreadId)).toEqual(["st-b"]);
    expect(dispatchCommand).toHaveBeenCalledOnce();
    const dispatched = dispatchCommand.mock.calls[0]![0];
    expect(dispatched.type).toBe("sidethread.inbox.dismiss");
    expect(dispatched.sideThreadId).toBe("st-a");
    expect(dispatched.userId).toBe("u-1");

    resolveDispatch?.();
    await dismissPromise;
    expect(useInboxStore.getState().items.map((item) => item.sideThreadId)).toEqual(["st-b"]);
  });

  it("dismiss rolls back and surfaces an error when the server rejects", async () => {
    const a = mkItem({ sideThreadId: "st-a" as SideThreadId });
    const b = mkItem({ sideThreadId: "st-b" as SideThreadId });
    useInboxStore.setState({ items: [a, b] });

    const dispatchCommand = vi.fn(() => Promise.reject(new Error("server boom")));
    const api = {
      sideThread: { dispatchCommand },
    } as unknown as EnvironmentApi;

    await useInboxStore.getState().dismiss(api, "st-a" as SideThreadId, "u-1" as UserId);

    expect(useInboxStore.getState().items.map((item) => item.sideThreadId)).toEqual([
      "st-a",
      "st-b",
    ]);
    expect(useInboxStore.getState().errorMessage).toBe("server boom");
  });
});
