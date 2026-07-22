import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SideThreadMessageId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { sideThreadIdForThread } from "@t3tools/shared/sideThread";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-07-22T12:00:00.000Z";
const threadId = ThreadId.make("thread-side");
const anchorMessageId = MessageId.make("message-anchor");
const sideThreadId = sideThreadIdForThread(threadId);
const actor = {
  kind: "client" as const,
  subject: "google:alice-subject",
  displayName: "Alice Example",
};

function persisted(
  sequence: number,
  event: Omit<OrchestrationEvent, "sequence">,
): OrchestrationEvent {
  return { ...event, sequence } as OrchestrationEvent;
}

const seededReadModel = Effect.gen(function* () {
  const created = yield* projectEvent(createEmptyReadModel(now), {
    sequence: 1,
    eventId: EventId.make("event-thread-created"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("command-thread-created"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      projectId: ProjectId.make("project-side"),
      title: "Side conversation",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  return yield* projectEvent(created, {
    sequence: 2,
    eventId: EventId.make("event-anchor-message"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.message-sent",
    occurredAt: now,
    commandId: CommandId.make("command-anchor-message"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      messageId: anchorMessageId,
      role: "assistant",
      text: "Inspect this design.",
      turnId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  });
});

it.layer(NodeServices.layer)("durable orchestration SideThreads", (it) => {
  it.effect(
    "creates one thread-level discussion and posts with the authenticated Google author",
    () =>
      Effect.gen(function* () {
        let readModel = yield* seededReadModel;
        const created = yield* decideOrchestrationCommand({
          readModel,
          actor,
          command: {
            type: "sidethread.create",
            commandId: CommandId.make("command-side-create"),
            threadId,
            sideThreadId,
            anchorMessageId,
            createdAt: now,
          },
        });
        expect(Array.isArray(created)).toBe(false);
        const createdEvent = created as Omit<OrchestrationEvent, "sequence">;
        expect(createdEvent.type).toBe("sidethread.created");
        if (createdEvent.type === "sidethread.created") {
          expect((createdEvent.payload as { createdBy: unknown }).createdBy).toEqual({
            subject: "google:alice-subject",
            displayName: "Alice Example",
          });
        }
        readModel = yield* projectEvent(readModel, persisted(3, createdEvent));

        const posted = yield* decideOrchestrationCommand({
          readModel,
          actor,
          command: {
            type: "sidethread.message.post",
            commandId: CommandId.make("command-side-post"),
            threadId,
            sideThreadId,
            messageId: SideThreadMessageId.make("side-message-1"),
            text: "Looks safe to me.",
            createdAt: now,
          },
        });
        const postedEvent = posted as Omit<OrchestrationEvent, "sequence">;
        readModel = yield* projectEvent(readModel, persisted(4, postedEvent));
        expect(readModel.threads[0]?.sideThreads?.[0]?.messages[0]?.author.subject).toBe(
          "google:alice-subject",
        );
        expect(readModel.threads[0]?.sideThreads?.[0]?.messages[0]?.text).toBe("Looks safe to me.");

        const archived = yield* decideOrchestrationCommand({
          readModel,
          actor,
          command: {
            type: "sidethread.archive",
            commandId: CommandId.make("command-side-archive"),
            threadId,
            sideThreadId,
            createdAt: now,
          },
        });
        readModel = yield* projectEvent(
          readModel,
          persisted(5, archived as Omit<OrchestrationEvent, "sequence">),
        );
        expect(readModel.threads[0]?.sideThreads?.[0]?.archivedAt).toBe(now);
      }),
  );

  it.effect(
    "accepts no anchor and rejects non-canonical ids, missing anchors, and unauthenticated authors",
    () =>
      Effect.gen(function* () {
        const readModel = yield* seededReadModel;
        const withoutAnchor = yield* decideOrchestrationCommand({
          readModel,
          actor,
          command: {
            type: "sidethread.create",
            commandId: CommandId.make("command-side-no-anchor"),
            threadId,
            sideThreadId,
            createdAt: now,
          },
        });
        expect((withoutAnchor as Omit<OrchestrationEvent, "sequence">).type).toBe(
          "sidethread.created",
        );

        const nonCanonical = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel,
            actor,
            command: {
              type: "sidethread.create",
              commandId: CommandId.make("command-side-non-canonical"),
              threadId,
              sideThreadId: sideThreadIdForThread(ThreadId.make("another-thread")),
              createdAt: now,
            },
          }),
        );
        expect(nonCanonical.message).toContain("canonical discussion");

        const missingAnchor = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel,
            actor,
            command: {
              type: "sidethread.create",
              commandId: CommandId.make("command-side-missing-anchor"),
              threadId,
              sideThreadId,
              anchorMessageId: MessageId.make("missing-message"),
              createdAt: now,
            },
          }),
        );
        expect(missingAnchor.message).toContain("does not exist");

        const missingActor = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel,
            command: {
              type: "sidethread.create",
              commandId: CommandId.make("command-side-missing-actor"),
              threadId,
              sideThreadId,
              anchorMessageId,
              createdAt: now,
            },
          }),
        );
        expect(missingActor.message).toContain("authenticated Google account");
      }),
  );
});
