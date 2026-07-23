import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SideThreadId,
  SideThreadMessageId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyThreadDetailEvent } from "./threadReducer.ts";

const now = "2026-07-22T12:00:00.000Z";
const threadId = ThreadId.make("thread-side-reducer");
const sideThreadId = SideThreadId.make("side-reducer");
const baseThread: OrchestrationThread = {
  id: threadId,
  projectId: ProjectId.make("project-side-reducer"),
  title: "Reducer",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  sideThreads: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const baseEvent = {
  eventId: EventId.make("event-side-reducer"),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: now,
  commandId: CommandId.make("command-side-reducer"),
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

describe("SideThread detail reduction", () => {
  it("replays create, message, and archive events", () => {
    const created = applyThreadDetailEvent(baseThread, {
      ...baseEvent,
      sequence: 1,
      type: "sidethread.created",
      payload: {
        threadId,
        sideThreadId,
        anchorMessageId: MessageId.make("anchor-reducer"),
        createdBy: { subject: "google:alice", displayName: "Alice" },
        createdAt: now,
      },
    } satisfies OrchestrationEvent);
    expect(created.kind).toBe("updated");
    if (created.kind !== "updated") return;
    expect(created.thread.sideThreads?.[0]?.id).toBe("thread:thread-side-reducer");

    const posted = applyThreadDetailEvent(created.thread, {
      ...baseEvent,
      sequence: 2,
      type: "sidethread.message-posted",
      payload: {
        threadId,
        sideThreadId,
        messageId: SideThreadMessageId.make("message-reducer"),
        author: { subject: "google:bob", displayName: "Bob" },
        text: "Ship it",
        createdAt: now,
      },
    } satisfies OrchestrationEvent);
    expect(posted.kind).toBe("updated");
    if (posted.kind !== "updated") return;
    expect(posted.thread.sideThreads?.[0]?.messages[0]?.author.displayName).toBe("Bob");

    const archived = applyThreadDetailEvent(posted.thread, {
      ...baseEvent,
      sequence: 3,
      type: "sidethread.archived",
      payload: { threadId, sideThreadId, archivedAt: now },
    } satisfies OrchestrationEvent);
    expect(archived.kind).toBe("updated");
    if (archived.kind === "updated") {
      expect(archived.thread.sideThreads?.[0]?.archivedAt).toBe(now);
    }
  });

  it("replays reactions, edits, and read markers without losing message metadata", () => {
    const created = applyThreadDetailEvent(baseThread, {
      ...baseEvent,
      sequence: 1,
      type: "sidethread.created",
      payload: {
        threadId,
        sideThreadId,
        anchorMessageId: MessageId.make("anchor-rich-reducer"),
        createdBy: { subject: "google:alice", displayName: "Alice" },
        createdAt: now,
      },
    } satisfies OrchestrationEvent);
    if (created.kind !== "updated") throw new Error("Expected side thread creation");

    const posted = applyThreadDetailEvent(created.thread, {
      ...baseEvent,
      sequence: 2,
      type: "sidethread.message-posted",
      payload: {
        threadId,
        sideThreadId,
        messageId: SideThreadMessageId.make("message-rich-reducer"),
        author: { subject: "google:bob", displayName: "Bob" },
        text: "Please review",
        mentions: [{ subject: "google:alice", displayName: "Alice" }],
        attachments: [
          {
            type: "gif",
            url: "https://example.com/review.gif",
            previewUrl: "https://example.com/review-preview.gif",
            width: 320,
            height: 180,
          },
        ],
        linkedRef: { kind: "agent-thread", threadId: ThreadId.make("linked-thread") },
        quotedMessageId: MessageId.make("anchor-rich-reducer"),
        createdAt: now,
      },
    } satisfies OrchestrationEvent);
    if (posted.kind !== "updated") throw new Error("Expected side thread message");

    const reacted = applyThreadDetailEvent(posted.thread, {
      ...baseEvent,
      sequence: 3,
      type: "sidethread.message-reacted",
      payload: {
        threadId,
        sideThreadId,
        messageId: SideThreadMessageId.make("message-rich-reducer"),
        emoji: "👀",
        user: { subject: "google:alice", displayName: "Alice" },
        action: "added",
        createdAt: "2026-07-22T12:01:00.000Z",
      },
    } satisfies OrchestrationEvent);
    if (reacted.kind !== "updated") throw new Error("Expected side thread reaction");

    const edited = applyThreadDetailEvent(reacted.thread, {
      ...baseEvent,
      sequence: 4,
      type: "sidethread.message-edited",
      payload: {
        threadId,
        sideThreadId,
        messageId: SideThreadMessageId.make("message-rich-reducer"),
        editor: { subject: "google:bob", displayName: "Bob" },
        text: "Please review this",
        editedAt: "2026-07-22T12:02:00.000Z",
      },
    } satisfies OrchestrationEvent);
    if (edited.kind !== "updated") throw new Error("Expected side thread edit");

    const markedRead = applyThreadDetailEvent(edited.thread, {
      ...baseEvent,
      sequence: 5,
      type: "sidethread.marked-read",
      payload: {
        threadId,
        sideThreadId,
        user: { subject: "google:alice", displayName: "Alice" },
        lastReadAt: "2026-07-22T12:02:00.000Z",
        createdAt: "2026-07-22T12:02:00.000Z",
      },
    } satisfies OrchestrationEvent);
    if (markedRead.kind !== "updated") throw new Error("Expected side thread read marker");

    const richThread = markedRead.thread.sideThreads?.[0];
    expect(richThread?.messages[0]).toMatchObject({
      text: "Please review this",
      editedAt: "2026-07-22T12:02:00.000Z",
      linkedRef: { kind: "agent-thread", threadId: "linked-thread" },
      reactions: [
        {
          emoji: "👀",
          users: [{ subject: "google:alice", displayName: "Alice" }],
        },
      ],
    });
    expect(richThread?.messages[0]?.attachments?.[0]?.type).toBe("gif");
    expect(richThread?.readBy).toEqual([
      {
        user: { subject: "google:alice", displayName: "Alice" },
        lastReadAt: "2026-07-22T12:02:00.000Z",
      },
    ]);
  });
});
