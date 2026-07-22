import { AuthSessionId, type AuthClientSession } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vitest";

import { googleTeamMembersFromSessions } from "./googleTeam";

function session(input: {
  readonly subject: string;
  readonly label?: string;
  readonly current?: boolean;
  readonly connected?: boolean;
}) {
  return {
    sessionId: AuthSessionId.make(
      `session-${input.subject}-${input.current ? "current" : "other"}`,
    ),
    subject: input.subject,
    scopes: [],
    method: "browser-session-cookie",
    client: { deviceType: "unknown", label: input.label ?? input.subject },
    issuedAt: DateTime.makeUnsafe("2026-07-23T00:00:00.000Z"),
    expiresAt: DateTime.makeUnsafe("2026-08-23T00:00:00.000Z"),
    lastConnectedAt: null,
    connected: input.connected ?? false,
    current: input.current ?? false,
  } satisfies AuthClientSession;
}

describe("googleTeamMembersFromSessions", () => {
  it("deduplicates Google accounts and excludes non-Google sessions", () => {
    expect(
      googleTeamMembersFromSessions([
        session({
          subject: "google:alice",
          current: true,
          label: "Alice",
        }),
        session({
          subject: "google:alice",
          connected: true,
          label: "Alice",
        }),
        session({ subject: "one-time-token" }),
        session({
          subject: "google:bob",
          label: "Bob",
        }),
      ]),
    ).toEqual([
      { subject: "google:alice", displayName: "Alice", current: true, connected: true },
      { subject: "google:bob", displayName: "Bob", current: false, connected: false },
    ]);
  });
});
