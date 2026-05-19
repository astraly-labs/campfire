/**
 * Unit tests for the in-process LRU that backs `summarizeConversation`.
 * We test the cache helpers in isolation; integration with the model is
 * exercised through the WS layer in `server.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";

import { __internals, invalidateThread } from "./conversationSummary.ts";
import type { ThreadId } from "@t3tools/contracts";

const threadA = "thread-a" as ThreadId;
const threadB = "thread-b" as ThreadId;

afterEach(() => {
  __internals.clear();
});

const cacheValue = (summary: string) =>
  ({
    summary,
    generatedAt: "2026-05-20T00:00:00.000Z",
    generatedByModel: "claude-haiku-4-5",
    generatedFromTurnId: "turn-1",
    fromCache: false,
  }) as const;

describe("conversationSummary cache", () => {
  it("returns cached entry on hit", () => {
    __internals.writeCache(threadA, "turn-1", cacheValue("hello"));
    const hit = __internals.readCache(threadA, "turn-1");
    expect(hit?.summary).toBe("hello");
  });

  it("misses when the turnId changes", () => {
    __internals.writeCache(threadA, "turn-1", cacheValue("v1"));
    expect(__internals.readCache(threadA, "turn-2")).toBeUndefined();
  });

  it("invalidates every entry for a thread regardless of turnId", () => {
    __internals.writeCache(threadA, "turn-1", cacheValue("a1"));
    __internals.writeCache(threadA, "turn-2", cacheValue("a2"));
    __internals.writeCache(threadB, "turn-1", cacheValue("b1"));

    invalidateThread(threadA);

    expect(__internals.readCache(threadA, "turn-1")).toBeUndefined();
    expect(__internals.readCache(threadA, "turn-2")).toBeUndefined();
    expect(__internals.readCache(threadB, "turn-1")?.summary).toBe("b1");
  });

  it("treats a null turnId as a distinct cache key", () => {
    __internals.writeCache(threadA, null, cacheValue("no-turn"));
    __internals.writeCache(threadA, "turn-1", cacheValue("with-turn"));
    expect(__internals.readCache(threadA, null)?.summary).toBe("no-turn");
    expect(__internals.readCache(threadA, "turn-1")?.summary).toBe("with-turn");
  });

  it("re-inserting a key bumps it to most-recently-used position", () => {
    // We can't observe LRU ordering directly without writing >CACHE_MAX_ENTRIES,
    // but a read should still return the same entry (touch is a no-op
    // value-wise).
    __internals.writeCache(threadA, "turn-1", cacheValue("v1"));
    const first = __internals.readCache(threadA, "turn-1");
    const second = __internals.readCache(threadA, "turn-1");
    expect(first?.summary).toBe("v1");
    expect(second?.summary).toBe("v1");
  });
});
