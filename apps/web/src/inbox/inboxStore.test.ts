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
  kind: "mention",
  sideThreadId: "st-1" as SideThreadId,
  parentThreadId: "thread-1" as ThreadId,
  quotedMessageId: null,
  lastMessageId: "msg-1" as SideThreadMessageId,
  lastActivityAt: "2026-05-18T10:00:00.000Z",
  lastAuthor: mkUser("u-1", "Alice"),
  lastPreview: "hey @me look at this",
  count: 1,
  ...overrides,
});

const rowKey = (item: InboxItem) => `${item.kind}:${item.sideThreadId}`;

describe("isInboxItemUnread", () => {
  it("is unread when the thread was never visited", () => {
    expect(isInboxItemUnread(mkItem(), {})).toBe(true);
  });

  it("is unread when last visit predates the activity", () => {
    const item = mkItem({ lastActivityAt: "2026-05-18T10:00:00.000Z" });
    const visited = { "st-1": "2026-05-18T09:00:00.000Z" };
    expect(isInboxItemUnread(item, visited)).toBe(true);
  });

  it("is read when the user visited after the activity", () => {
    const item = mkItem({ lastActivityAt: "2026-05-18T10:00:00.000Z" });
    const visited = { "st-1": "2026-05-18T11:00:00.000Z" };
    expect(isInboxItemUnread(item, visited)).toBe(false);
  });
});

describe("useInboxStore", () => {
  beforeEach(() => {
    useInboxStore.getState().reset();
  });

  it("removes only the matching (kind, sideThreadId) on a 'removed' event", () => {
    const mention = mkItem({ kind: "mention", sideThreadId: "st-a" as SideThreadId });
    const activity = mkItem({ kind: "activity", sideThreadId: "st-a" as SideThreadId });
    const other = mkItem({ kind: "mention", sideThreadId: "st-b" as SideThreadId });
    useInboxStore.setState({ items: [mention, activity, other] });

    useInboxStore.getState().applyStreamEvent({
      kind: "removed",
      itemKind: "mention",
      sideThreadId: "st-a" as SideThreadId,
    });

    // The mention row for st-a is gone, but the activity row for st-a stays.
    expect(useInboxStore.getState().items.map(rowKey).toSorted()).toEqual([
      "activity:st-a",
      "mention:st-b",
    ]);
  });

  it("upsert replaces by (kind, sideThreadId) and leaves the other kind intact", () => {
    const mention = mkItem({ kind: "mention", sideThreadId: "st-a" as SideThreadId, count: 1 });
    const activity = mkItem({ kind: "activity", sideThreadId: "st-a" as SideThreadId, count: 1 });
    useInboxStore.setState({ items: [mention, activity] });

    useInboxStore.getState().applyStreamEvent({
      kind: "upserted",
      item: mkItem({ kind: "activity", sideThreadId: "st-a" as SideThreadId, count: 3 }),
    });

    const items = useInboxStore.getState().items;
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.kind === "activity")?.count).toBe(3);
    expect(items.find((i) => i.kind === "mention")?.count).toBe(1);
  });

  it("dismiss optimistically removes only the mention row, keeping activity", async () => {
    const mention = mkItem({ kind: "mention", sideThreadId: "st-a" as SideThreadId });
    const activity = mkItem({ kind: "activity", sideThreadId: "st-a" as SideThreadId });
    const other = mkItem({ kind: "mention", sideThreadId: "st-b" as SideThreadId });
    useInboxStore.setState({ items: [mention, activity, other] });

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

    // Optimistic: mention:st-a gone, activity:st-a and mention:st-b remain.
    expect(useInboxStore.getState().items.map(rowKey).toSorted()).toEqual([
      "activity:st-a",
      "mention:st-b",
    ]);
    expect(dispatchCommand).toHaveBeenCalledOnce();
    const dispatched = dispatchCommand.mock.calls[0]![0];
    expect(dispatched.type).toBe("sidethread.inbox.dismiss");
    expect(dispatched.sideThreadId).toBe("st-a");
    expect(dispatched.userId).toBe("u-1");

    resolveDispatch?.();
    await dismissPromise;
    expect(useInboxStore.getState().items.map(rowKey).toSorted()).toEqual([
      "activity:st-a",
      "mention:st-b",
    ]);
  });

  it("dismiss rolls back and surfaces an error when the server rejects", async () => {
    const mention = mkItem({ kind: "mention", sideThreadId: "st-a" as SideThreadId });
    const other = mkItem({ kind: "mention", sideThreadId: "st-b" as SideThreadId });
    useInboxStore.setState({ items: [mention, other] });

    const dispatchCommand = vi.fn(() => Promise.reject(new Error("server boom")));
    const api = {
      sideThread: { dispatchCommand },
    } as unknown as EnvironmentApi;

    await useInboxStore.getState().dismiss(api, "st-a" as SideThreadId, "u-1" as UserId);

    expect(useInboxStore.getState().items.map(rowKey).toSorted()).toEqual([
      "mention:st-a",
      "mention:st-b",
    ]);
    expect(useInboxStore.getState().errorMessage).toBe("server boom");
  });
});
