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
});
