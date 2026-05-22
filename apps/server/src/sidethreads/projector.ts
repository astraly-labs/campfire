/**
 * SideThread projector — pure event → read-model reduction.
 *
 * Updates the in-memory `SideThreadReadModel` from a persisted event. This
 * is used by the engine to keep `commandReadModel` fresh between command
 * dispatches; the SQL projection lives in `Layers/SideThreadProjectionPipeline.ts`.
 *
 * @module sidethreads/projector
 */
import type {
  SideThread,
  SideThreadEvent,
  SideThreadMessage,
  SideThreadMessageReaction,
  UserRef,
} from "@t3tools/contracts";

import type { SideThreadReadModel } from "./readModel.ts";

/**
 * Apply a single `add`/`remove` reaction delta to a message's reaction
 * buckets. Returns the same message reference when the delta is a no-op
 * (e.g. removing a reaction that doesn't exist), so React-style reference
 * checks in callers remain meaningful.
 */
const applyReactionDelta = (
  message: SideThreadMessage,
  user: UserRef,
  emoji: string,
  action: "added" | "removed",
  occurredAt: SideThreadEvent["occurredAt"],
): SideThreadMessage => {
  const bucketIndex = message.reactions.findIndex((r) => r.emoji === emoji);
  const bucket = bucketIndex >= 0 ? message.reactions[bucketIndex]! : undefined;
  if (action === "added") {
    if (bucket?.users.some((u) => u.id === user.id)) return message;
    const nextBucket: SideThreadMessageReaction = bucket
      ? { ...bucket, users: [...bucket.users, user] }
      : { emoji, users: [user] };
    const nextReactions =
      bucketIndex >= 0
        ? message.reactions.map((r, idx) => (idx === bucketIndex ? nextBucket : r))
        : [...message.reactions, nextBucket];
    return { ...message, updatedAt: occurredAt, reactions: nextReactions };
  }
  // action === "removed"
  if (!bucket) return message;
  const nextUsers = bucket.users.filter((u) => u.id !== user.id);
  if (nextUsers.length === bucket.users.length) return message;
  const nextReactions =
    nextUsers.length === 0
      ? message.reactions.filter((_, idx) => idx !== bucketIndex)
      : message.reactions.map((r, idx) =>
          idx === bucketIndex ? { ...r, users: nextUsers } : r,
        );
  return { ...message, updatedAt: occurredAt, reactions: nextReactions };
};

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
      if (nextBase.sideThreads.has(event.payload.sideThreadId)) {
        // Duplicate `sidethread.created` from legacy data — the normalizer
        // would have filtered it out already in bootstrap, but stay
        // defensive in case the engine ever re-projects an event.
        return nextBase;
      }
      const created: SideThread = {
        id: event.payload.sideThreadId,
        parentThreadId: event.payload.parentThreadId,
        createdBy: event.payload.createdBy,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
        archivedAt: null,
        messages: [],
        readBy: [],
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
            quotedMessageId: event.payload.quotedMessageId ?? null,
            attachments: event.payload.attachments ?? [],
            reactions: [],
            linkedRef: event.payload.linkedRef ?? null,
            replyToSideThreadMessageId:
              event.payload.replyToSideThreadMessageId ?? null,
            editedAt: null,
          },
        ],
      };
      const nextSideThreads = new Map(nextBase.sideThreads);
      nextSideThreads.set(updated.id, updated);
      return { ...nextBase, sideThreads: nextSideThreads };
    }

    case "sidethread.message-reacted": {
      const current = nextBase.sideThreads.get(event.payload.sideThreadId);
      if (!current) return nextBase;
      const messageIndex = current.messages.findIndex(
        (m) => m.id === event.payload.messageId,
      );
      if (messageIndex < 0) return nextBase;
      const message = current.messages[messageIndex]!;
      const updatedMessage = applyReactionDelta(
        message,
        event.payload.user,
        event.payload.emoji,
        event.payload.action,
        event.occurredAt,
      );
      // Reference equality: nothing changed → bail without churning the map.
      if (updatedMessage === message) {
        return { ...nextBase, sideThreads: nextBase.sideThreads };
      }
      const updated: SideThread = {
        ...current,
        updatedAt: event.occurredAt,
        messages: current.messages.map((m, idx) => (idx === messageIndex ? updatedMessage : m)),
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

    case "sidethread.message-edited": {
      const current = nextBase.sideThreads.get(event.payload.sideThreadId);
      if (!current) return nextBase;
      const messageIndex = current.messages.findIndex(
        (m) => m.id === event.payload.messageId,
      );
      if (messageIndex < 0) return nextBase;
      const original = current.messages[messageIndex]!;
      const updatedMessage: SideThreadMessage = {
        ...original,
        text: event.payload.text,
        updatedAt: event.occurredAt,
        editedAt: event.occurredAt,
      };
      const updated: SideThread = {
        ...current,
        updatedAt: event.occurredAt,
        messages: current.messages.map((m, idx) => (idx === messageIndex ? updatedMessage : m)),
      };
      const nextSideThreads = new Map(nextBase.sideThreads);
      nextSideThreads.set(updated.id, updated);
      return { ...nextBase, sideThreads: nextSideThreads };
    }

    case "sidethread.marked-read": {
      const current = nextBase.sideThreads.get(event.payload.sideThreadId);
      if (!current) return nextBase;
      const userId = event.payload.user.id;
      const incomingAt = event.payload.lastReadAt;
      const existingIndex = current.readBy.findIndex((m) => m.user.id === userId);
      const nextMarker = { user: event.payload.user, lastReadAt: incomingAt };
      let nextReadBy: SideThread["readBy"];
      if (existingIndex < 0) {
        nextReadBy = [...current.readBy, nextMarker];
      } else {
        const existing = current.readBy[existingIndex]!;
        // Monotonic max — a late-arriving older marker (e.g. from a peer
        // device that was behind) must not rewind the seen-up-to point.
        if (existing.lastReadAt >= incomingAt) return nextBase;
        nextReadBy = current.readBy.map((m, idx) => (idx === existingIndex ? nextMarker : m));
      }
      const updated: SideThread = {
        ...current,
        updatedAt: event.occurredAt,
        readBy: nextReadBy,
      };
      const nextSideThreads = new Map(nextBase.sideThreads);
      nextSideThreads.set(updated.id, updated);
      return { ...nextBase, sideThreads: nextSideThreads };
    }
  }
};
