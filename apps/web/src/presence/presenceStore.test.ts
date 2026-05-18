import { describe, expect, it } from "vitest";

import type { PresenceEntry, SideThreadId, ThreadId, UserId, UserRef } from "@t3tools/contracts";

import { selectViewersOfParentThread, selectViewersOfSideThread } from "./presenceStore";

const mkUser = (id: string, displayName: string): UserRef => ({
  id: id as UserId,
  displayName: displayName as UserRef["displayName"],
});

const ALICE = mkUser("u-alice", "Alice");
const BOB = mkUser("u-bob", "Bob");
const MATTEO = mkUser("u-matteo", "Matteo");

const mkEntry = (overrides: Partial<PresenceEntry> & { user: UserRef }): PresenceEntry => ({
  parentThreadId: null,
  sideThreadId: null,
  typingIn: null,
  lastSeenAt: "2026-01-01T00:00:00.000Z" as PresenceEntry["lastSeenAt"],
  ...overrides,
});

const T1 = "thread-1" as ThreadId;
const T2 = "thread-2" as ThreadId;
const S1 = "st-1" as SideThreadId;
const S2 = "st-2" as SideThreadId;

function buildMap(entries: ReadonlyArray<PresenceEntry>): ReadonlyMap<UserId, PresenceEntry> {
  const out = new Map<UserId, PresenceEntry>();
  for (const e of entries) out.set(e.user.id, e);
  return out;
}

describe("selectViewersOfParentThread", () => {
  it("returns viewers whose parentThreadId matches, ordered by displayName", () => {
    const entries = buildMap([
      mkEntry({ user: MATTEO, parentThreadId: T1 }),
      mkEntry({ user: ALICE, parentThreadId: T1 }),
      mkEntry({ user: BOB, parentThreadId: T2 }),
    ]);
    const viewers = selectViewersOfParentThread(entries, T1);
    expect(viewers.map((v) => v.user.id)).toEqual([ALICE.id, MATTEO.id]);
  });

  it("excludes users on other parent threads", () => {
    const entries = buildMap([mkEntry({ user: BOB, parentThreadId: T2 })]);
    expect(selectViewersOfParentThread(entries, T1)).toEqual([]);
  });

  it("flags typing when typingIn is set, regardless of which surface", () => {
    const entries = buildMap([
      mkEntry({ user: ALICE, parentThreadId: T1, typingIn: "parent" }),
      mkEntry({ user: BOB, parentThreadId: T1, sideThreadId: S1, typingIn: "side" }),
    ]);
    const viewers = selectViewersOfParentThread(entries, T1);
    // Parent-thread view exposes "someone is typing somewhere in this thread"
    // — the side-thread anchor will narrow it further when relevant.
    expect(viewers.find((v) => v.user.id === ALICE.id)?.isTyping).toBe(true);
    expect(viewers.find((v) => v.user.id === BOB.id)?.isTyping).toBe(true);
  });
});

describe("selectViewersOfSideThread", () => {
  it("only includes users with the exact sideThreadId focused", () => {
    const entries = buildMap([
      mkEntry({ user: ALICE, parentThreadId: T1, sideThreadId: S1 }),
      mkEntry({ user: BOB, parentThreadId: T1, sideThreadId: S2 }),
      mkEntry({ user: MATTEO, parentThreadId: T1, sideThreadId: null }),
    ]);
    const viewers = selectViewersOfSideThread(entries, S1);
    expect(viewers.map((v) => v.user.id)).toEqual([ALICE.id]);
  });

  it("only flags typing when typingIn === 'side'", () => {
    const entries = buildMap([
      // Same user has drawer open AND is typing in parent → not "typing in side"
      mkEntry({
        user: ALICE,
        parentThreadId: T1,
        sideThreadId: S1,
        typingIn: "parent",
      }),
      mkEntry({
        user: BOB,
        parentThreadId: T1,
        sideThreadId: S1,
        typingIn: "side",
      }),
    ]);
    const viewers = selectViewersOfSideThread(entries, S1);
    expect(viewers.find((v) => v.user.id === ALICE.id)?.isTyping).toBe(false);
    expect(viewers.find((v) => v.user.id === BOB.id)?.isTyping).toBe(true);
  });
});
