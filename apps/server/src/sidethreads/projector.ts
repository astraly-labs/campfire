/**
 * SideThread projector — pure event → read-model reduction.
 *
 * Updates the in-memory `SideThreadReadModel` from a persisted event. This
 * is used by the engine to keep `commandReadModel` fresh between command
 * dispatches; the SQL projection lives in `Layers/SideThreadProjectionPipeline.ts`.
 *
 * @module sidethreads/projector
 */
import type { SideThread, SideThreadEvent } from "@t3tools/contracts";

import type { SideThreadReadModel } from "./readModel.ts";

export const projectSideThreadEvent = (
  model: SideThreadReadModel,
  event: SideThreadEvent,
): SideThreadReadModel => {
  const nextBase: SideThreadReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "sidethread.created": {
      const created: SideThread = {
        id: event.payload.sideThreadId,
        parentThreadId: event.payload.parentThreadId,
        anchor: event.payload.anchor,
        createdBy: event.payload.createdBy,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
        archivedAt: null,
        messages: [],
      };
      const nextSideThreads = new Map(nextBase.sideThreads);
      nextSideThreads.set(created.id, created);
      return { ...nextBase, sideThreads: nextSideThreads };
    }

    case "sidethread.message-posted": {
      const current = nextBase.sideThreads.get(event.payload.sideThreadId);
      if (!current) {
        return nextBase;
      }
      const updated: SideThread = {
        ...current,
        updatedAt: event.occurredAt,
        messages: [
          ...current.messages,
          {
            id: event.payload.messageId,
            author: event.payload.author,
            text: event.payload.text,
            createdAt: event.occurredAt,
            updatedAt: event.occurredAt,
            mentions: event.payload.mentions ?? [],
          },
        ],
      };
      const nextSideThreads = new Map(nextBase.sideThreads);
      nextSideThreads.set(updated.id, updated);
      return { ...nextBase, sideThreads: nextSideThreads };
    }

    case "sidethread.archived": {
      const current = nextBase.sideThreads.get(event.payload.sideThreadId);
      if (!current) {
        return nextBase;
      }
      const updated: SideThread = {
        ...current,
        updatedAt: event.occurredAt,
        archivedAt: event.occurredAt,
      };
      const nextSideThreads = new Map(nextBase.sideThreads);
      nextSideThreads.set(updated.id, updated);
      return { ...nextBase, sideThreads: nextSideThreads };
    }

    case "sidethread.inbox-dismissed": {
      // Per-user inbox state — does not mutate the side-thread aggregate
      // snapshot, only the dedicated dismissals projection table.
      return nextBase;
    }
  }
};
