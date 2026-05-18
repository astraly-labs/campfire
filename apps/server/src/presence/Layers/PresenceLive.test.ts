import { describe, expect, it } from "vitest";
import type { PresenceTypingFocus, ThreadId, UserId, UserRef } from "@t3tools/contracts";

import { __testEntryView, __testProjectSnapshot, __testTTLs } from "./PresenceLive.ts";

interface InternalEntry {
  user: UserRef;
  parentThreadId: ThreadId | null;
  sideThreadId: null;
  typingIn: PresenceTypingFocus | null;
  lastSeenAt: number;
  typingSince: number | null;
}

const mkUser = (id: string, displayName: string): UserRef => ({
  id: id as UserId,
  displayName: displayName as UserRef["displayName"],
});

const ALICE = mkUser("u-alice", "Alice");
const T1 = "thread-1" as ThreadId;

describe("PresenceLive — entryView TTL", () => {
  it("hides the typing flag once typingSince is older than TYPING_TTL_MS", () => {
    const now = 100_000;
    const fresh: InternalEntry = {
      user: ALICE,
      parentThreadId: T1,
      sideThreadId: null,
      typingIn: "side",
      lastSeenAt: now,
      typingSince: now - 1_000,
    };
    const stale: InternalEntry = {
      ...fresh,
      typingSince: now - (__testTTLs.TYPING_TTL_MS + 1_000),
    };
    expect(__testEntryView(fresh, now).typingIn).toBe("side");
    expect(__testEntryView(stale, now).typingIn).toBeNull();
  });

  it("returns null typingIn when typingSince is null (never typed)", () => {
    const entry: InternalEntry = {
      user: ALICE,
      parentThreadId: T1,
      sideThreadId: null,
      typingIn: null,
      lastSeenAt: 0,
      typingSince: null,
    };
    expect(__testEntryView(entry, 0).typingIn).toBeNull();
  });
});

describe("PresenceLive — projectSnapshot", () => {
  it("emits one snapshot entry per internal entry", () => {
    const now = 100_000;
    const entries = new Map<UserId, InternalEntry>([
      [
        ALICE.id,
        {
          user: ALICE,
          parentThreadId: T1,
          sideThreadId: null,
          typingIn: null,
          lastSeenAt: now,
          typingSince: null,
        },
      ],
    ]);
    const snap = __testProjectSnapshot(entries, now);
    expect(snap.kind).toBe("snapshot");
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]!.user.id).toBe(ALICE.id);
    expect(snap.entries[0]!.lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("produces a valid ISO string for lastSeenAt", () => {
    const t = 1_700_000_000_000; // 2023-11-14T...
    const entries = new Map<UserId, InternalEntry>([
      [
        ALICE.id,
        {
          user: ALICE,
          parentThreadId: T1,
          sideThreadId: null,
          typingIn: null,
          lastSeenAt: t,
          typingSince: null,
        },
      ],
    ]);
    const iso = __testProjectSnapshot(entries, t).entries[0]!.lastSeenAt;
    expect(Date.parse(iso)).toBe(t);
  });
});
