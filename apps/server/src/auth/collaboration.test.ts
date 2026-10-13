import { describe, expect, it } from "vite-plus/test";

import { withAuthenticatedCollaboration } from "./collaboration.ts";

describe("collaboration identity at the transport boundary", () => {
  it("overwrites a forged teammate identity with the authenticated Google account", () => {
    const command = withAuthenticatedCollaboration({
      type: "sidethread.message.post",
      collaborationUser: { subject: "google:admin", displayName: "Admin" },
      text: "hello",
    }, { subject: "google:alice", displayName: "Alice" });
    expect(command.collaborationUser).toEqual({ subject: "google:alice", displayName: "Alice" });
    expect(command.text).toBe("hello");
  });

  it("does not turn a labeled pairing credential into a Google identity", () => {
    const command = withAuthenticatedCollaboration({
      collaborationUser: { subject: "google:admin", displayName: "Admin" },
    }, { subject: "one-time-token", displayName: "google:admin" });
    expect(command.collaborationUser).toBeNull();
  });
});
