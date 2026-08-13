import {
  CommandId,
  CorrelationId,
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { coalesceContextWindowEvents } from "./ActivityPayloadProjection.ts";

const threadId = ThreadId.make("thread-context-window");
const turnId = TurnId.make("turn-context-window");

function contextWindowEvent(sequence: number) {
  const createdAt = `2026-08-13T15:00:0${sequence}.000Z`;
  return {
    sequence,
    eventId: EventId.make(`event-context-window-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: createdAt,
    commandId: CommandId.make(`command-context-window-${sequence}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`command-context-window-${sequence}`),
    metadata: {},
    type: "thread.activity-appended",
    payload: {
      threadId,
      activity: {
        id: EventId.make(`activity-context-window-${sequence}`),
        tone: "info",
        kind: "context-window.updated",
        summary: "Context window updated",
        payload: { usedTokens: sequence * 100 },
        turnId,
        createdAt,
      },
    },
  } satisfies Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;
}

describe("coalesceContextWindowEvents", () => {
  it("keeps only the latest usable context-window update for a turn", () => {
    const first = contextWindowEvent(1);
    const latest = contextWindowEvent(2);
    const unrelated = {
      ...contextWindowEvent(3),
      payload: {
        ...contextWindowEvent(3).payload,
        activity: {
          ...contextWindowEvent(3).payload.activity,
          kind: "runtime.note",
          summary: "Keep this activity",
        },
      },
    } satisfies Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

    expect(coalesceContextWindowEvents([first, latest, unrelated])).toEqual([latest, unrelated]);
  });
});
