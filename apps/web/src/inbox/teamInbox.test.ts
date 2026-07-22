import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  SideThreadId,
  SideThreadMessageId,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vitest";

import { countUnreadTeamInboxItems, deriveTeamInboxItems } from "./teamInbox";

const environmentId = EnvironmentId.make("primary");
const alice = { subject: "google:alice", displayName: "Alice" } as const;
const bob = { subject: "google:bob", displayName: "Bob" } as const;

function thread(input: {
  readonly id: string;
  readonly author?: typeof alice | typeof bob;
  readonly mentions?: ReadonlyArray<typeof alice | typeof bob>;
  readonly participants?: ReadonlyArray<typeof alice | typeof bob>;
  readonly lastReadAt?: string;
}): EnvironmentThreadShell {
  const createdAt = "2026-07-23T00:00:00.000Z";
  const message = {
    id: SideThreadMessageId.make(`message-${input.id}`),
    author: input.author ?? bob,
    text: `Update for ${input.id}`,
    mentions: [...(input.mentions ?? [])],
    hasAttachments: false,
    createdAt,
  } as const;
  return {
    environmentId,
    id: ThreadId.make(input.id),
    projectId: ProjectId.make("project"),
    title: input.id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    teamDiscussion: {
      id: SideThreadId.make(`thread:${input.id}`),
      createdBy: bob,
      updatedAt: createdAt,
      archivedAt: null,
      messageCount: 1,
      latestMessage: message,
      latestMentions: input.mentions?.length ? [message] : [],
      participants: [...(input.participants ?? [])],
      readBy: input.lastReadAt ? [{ user: alice, lastReadAt: input.lastReadAt }] : [],
    },
  };
}

describe("deriveTeamInboxItems", () => {
  it("surfaces unread Google mentions and collaborative activity", () => {
    const items = deriveTeamInboxItems({
      threads: [
        thread({ id: "mention", mentions: [alice], participants: [alice, bob] }),
        thread({ id: "activity", participants: [alice, bob] }),
        thread({ id: "unrelated", participants: [bob] }),
      ],
      environmentId,
      currentSubject: alice.subject,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["activity", "mention"]);
    expect(items.find((item) => item.thread.id === "mention")?.isMention).toBe(true);
    expect(countUnreadTeamInboxItems(items)).toBe(2);
  });

  it("keeps read conversations visible without counting them as unread", () => {
    const items = deriveTeamInboxItems({
      threads: [
        thread({
          id: "read",
          mentions: [alice],
          participants: [alice, bob],
          lastReadAt: "2026-07-23T00:01:00.000Z",
        }),
      ],
      environmentId,
      currentSubject: alice.subject,
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.unread).toBe(false);
    expect(items[0]?.isMention).toBe(false);
  });
});
