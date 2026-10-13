import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presenceColorIndex, presenceInitials } from "./PresenceAvatarStack";
import { viewersForThread } from "./presence";

describe("presence presentation", () => {
  it("selects and sorts viewers for a task", () => {
    const threadId = ThreadId.make("thread-a");
    const entries = [
      {
        sessionId: "session-b" as never,
        user: { subject: "google:b", displayName: "Bob" },
        threadId,
        typing: true,
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      },
      {
        sessionId: "session-a" as never,
        user: { subject: "google:a", displayName: "Alice" },
        threadId,
        typing: false,
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      },
      {
        sessionId: "session-c" as never,
        user: { subject: "google:c", displayName: "Carol" },
        threadId: ThreadId.make("thread-b"),
        typing: false,
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    expect(viewersForThread(entries, threadId).map((entry) => entry.user.displayName)).toEqual([
      "Alice",
      "Bob",
    ]);
    expect(EnvironmentId.make("environment-a")).toBe("environment-a");
  });

  it("derives stable compact avatar presentation", () => {
    expect(presenceInitials("Alice Example")).toBe("AE");
    expect(presenceInitials("Alice")).toBe("A");
    expect(presenceColorIndex("google:alice")).toBe(presenceColorIndex("google:alice"));
  });
});
