/**
 * SideThread decider — pure command → planned event reduction.
 *
 * Receives the current in-memory read model and a validated command, runs
 * invariants, and returns the planned event without `sequence` (assigned
 * by the EventStore on append). `eventId` is generated here.
 *
 * @module sidethreads/decider
 */
import type {
  EventId,
  IsoDateTime,
  SideThreadArchiveCommand,
  SideThreadCommand,
  SideThreadCreateCommand,
  SideThreadEvent,
  SideThreadInboxDismissCommand,
  SideThreadMarkReadCommand,
  SideThreadMessageEditCommand,
  SideThreadMessagePostCommand,
  SideThreadMessageReactCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { SideThreadCommandInvariantError } from "./Errors.ts";
import type { SideThreadReadModel } from "./readModel.ts";

export type PlannedSideThreadEvent = Omit<SideThreadEvent, "sequence">;

export interface DecideSideThreadCommandParams {
  readonly command: SideThreadCommand;
  readonly readModel: SideThreadReadModel;
  readonly now: IsoDateTime;
}

const newEventId = (): EventId => crypto.randomUUID() as unknown as EventId;

const baseEnvelope = (
  command: { commandId: SideThreadCommand["commandId"] },
  aggregateId: string,
  now: IsoDateTime,
) => ({
  eventId: newEventId(),
  aggregateKind: "sidethread" as const,
  aggregateId: aggregateId as SideThreadEvent["aggregateId"],
  occurredAt: now,
  commandId: command.commandId,
  causationEventId: null,
  correlationId: command.commandId,
  metadata: {},
});

export const decideSideThreadCommand = Effect.fn("decideSideThreadCommand")(function* ({
  command,
  readModel,
  now,
}: DecideSideThreadCommandParams) {
  switch (command.type) {
    case "sidethread.create":
      return yield* decideCreate({ command, readModel, now });
    case "sidethread.message.post":
      return yield* decidePost({ command, readModel, now });
    case "sidethread.message.react":
      return yield* decideReact({ command, readModel, now });
    case "sidethread.archive":
      return yield* decideArchive({ command, readModel, now });
    case "sidethread.inbox.dismiss":
      return yield* decideInboxDismiss({ command, readModel, now });
    case "sidethread.mark-read":
      return yield* decideMarkRead({ command, readModel, now });
    case "sidethread.message.edit":
      return yield* decideEdit({ command, readModel, now });
  }
});

const decideCreate = ({
  command,
  readModel,
  now,
}: {
  command: SideThreadCreateCommand;
  readModel: SideThreadReadModel;
  now: IsoDateTime;
}): Effect.Effect<PlannedSideThreadEvent, SideThreadCommandInvariantError> =>
  Effect.gen(function* () {
    if (readModel.sideThreads.has(command.sideThreadId)) {
      return yield* new SideThreadCommandInvariantError({
        commandType: command.type,
        detail: `SideThread already exists: ${command.sideThreadId}`,
      });
    }
    return {
      ...baseEnvelope(command, command.sideThreadId, now),
      type: "sidethread.created" as const,
      payload: {
        sideThreadId: command.sideThreadId,
        parentThreadId: command.parentThreadId,
        createdBy: command.createdBy,
      },
    };
  });

const decidePost = ({
  command,
  readModel,
  now,
}: {
  command: SideThreadMessagePostCommand;
  readModel: SideThreadReadModel;
  now: IsoDateTime;
}): Effect.Effect<PlannedSideThreadEvent, SideThreadCommandInvariantError> =>
  Effect.gen(function* () {
    const sideThread = readModel.sideThreads.get(command.sideThreadId);
    if (!sideThread) {
      return yield* new SideThreadCommandInvariantError({
        commandType: command.type,
        detail: `Unknown SideThread: ${command.sideThreadId}`,
      });
    }
    if (sideThread.archivedAt !== null) {
      return yield* new SideThreadCommandInvariantError({
        commandType: command.type,
        detail: `SideThread is archived: ${command.sideThreadId}`,
      });
    }
    if (sideThread.messages.some((message) => message.id === command.messageId)) {
      return yield* new SideThreadCommandInvariantError({
        commandType: command.type,
        detail: `Message id already used: ${command.messageId}`,
      });
    }
    // A side-thread message must carry *something*. With GIF attachments
    // we relaxed `text` to allow empty strings — re-enforce the "at least
    // one" rule here so a buggy client can't persist a fully blank row.
    if (command.text.length === 0 && command.attachments.length === 0) {
      return yield* new SideThreadCommandInvariantError({
        commandType: command.type,
        detail: "Message must have text or at least one attachment",
      });
    }
    // When the reply target is set, verify it points at an existing
    // message in the same side thread — otherwise we'd persist a
    // dangling pointer that the UI would render as a broken chip.
    if (command.replyToSideThreadMessageId !== null) {
      const target = sideThread.messages.find(
        (m) => m.id === command.replyToSideThreadMessageId,
      );
      if (!target) {
        return yield* new SideThreadCommandInvariantError({
          commandType: command.type,
          detail: `Reply target not found in side thread: ${command.replyToSideThreadMessageId}`,
        });
      }
    }
    return {
      ...baseEnvelope(command, command.sideThreadId, now),
      type: "sidethread.message-posted" as const,
      payload: {
        sideThreadId: command.sideThreadId,
        messageId: command.messageId,
        author: command.author,
        text: command.text,
        mentions: command.mentions,
        quotedMessageId: command.quotedMessageId,
        attachments: command.attachments,
        linkedRef: command.linkedRef,
        replyToSideThreadMessageId: command.replyToSideThreadMessageId,
      },
    };
  });

const decideReact = ({
  command,
  readModel,
  now,
}: {
  command: SideThreadMessageReactCommand;
  readModel: SideThreadReadModel;
  now: IsoDateTime;
}): Effect.Effect<PlannedSideThreadEvent, SideThreadCommandInvariantError> =>
  Effect.gen(function* () {
    const sideThread = readModel.sideThreads.get(command.sideThreadId);
    if (!sideThread) {
      return yield* new SideThreadCommandInvariantError({
        commandType: command.type,
        detail: `Unknown SideThread: ${command.sideThreadId}`,
      });
    }
    if (sideThread.archivedAt !== null) {
      return yield* new SideThreadCommandInvariantError({
        commandType: command.type,
        detail: `SideThread is archived: ${command.sideThreadId}`,
      });
    }
    const message = sideThread.messages.find((m) => m.id === command.messageId);
    if (!message) {
      return yield* new SideThreadCommandInvariantError({
        commandType: command.type,
        detail: `Unknown message: ${command.messageId}`,
      });
    }
    // Resolve the toggle here so the projector only has to apply a delta.
    // Adding a brand-new emoji bucket also counts as "added" — the projector
    // creates the bucket on demand.
    const bucket = message.reactions.find((r) => r.emoji === command.emoji);
    const alreadyReacted = bucket?.users.some((u) => u.id === command.user.id) ?? false;
    return {
      ...baseEnvelope(command, command.sideThreadId, now),
      type: "sidethread.message-reacted" as const,
      payload: {
        sideThreadId: command.sideThreadId,
        messageId: command.messageId,
        user: command.user,
        emoji: command.emoji,
        action: alreadyReacted ? ("removed" as const) : ("added" as const),
      },
    };
  });

const decideArchive = ({
  command,
  readModel,
  now,
}: {
  command: SideThreadArchiveCommand;
  readModel: SideThreadReadModel;
  now: IsoDateTime;
}): Effect.Effect<PlannedSideThreadEvent, SideThreadCommandInvariantError> =>
  Effect.gen(function* () {
    const sideThread = readModel.sideThreads.get(command.sideThreadId);
    if (!sideThread) {
      return yield* new SideThreadCommandInvariantError({
        commandType: command.type,
        detail: `Unknown SideThread: ${command.sideThreadId}`,
      });
    }
    if (sideThread.archivedAt !== null) {
      return yield* new SideThreadCommandInvariantError({
        commandType: command.type,
        detail: `SideThread already archived: ${command.sideThreadId}`,
      });
    }
    return {
      ...baseEnvelope(command, command.sideThreadId, now),
      type: "sidethread.archived" as const,
      payload: {
        sideThreadId: command.sideThreadId,
        archivedBy: command.archivedBy,
      },
    };
  });

const decideInboxDismiss = ({
  command,
  readModel,
  now,
}: {
  command: SideThreadInboxDismissCommand;
  readModel: SideThreadReadModel;
  now: IsoDateTime;
}): Effect.Effect<PlannedSideThreadEvent, SideThreadCommandInvariantError> =>
  Effect.gen(function* () {
    if (!readModel.sideThreads.has(command.sideThreadId)) {
      return yield* new SideThreadCommandInvariantError({
        commandType: command.type,
        detail: `Unknown SideThread: ${command.sideThreadId}`,
      });
    }
    // No "already dismissed" check — the projector upserts so repeated
    // dismisses just bump dismissed_at forward, which is the desired
    // behaviour ("dismiss again to clear newer mentions").
    return {
      ...baseEnvelope(command, command.sideThreadId, now),
      type: "sidethread.inbox-dismissed" as const,
      payload: {
        sideThreadId: command.sideThreadId,
        userId: command.userId,
      },
    };
  });

const decideEdit = ({
  command,
  readModel,
  now,
}: {
  command: SideThreadMessageEditCommand;
  readModel: SideThreadReadModel;
  now: IsoDateTime;
}): Effect.Effect<PlannedSideThreadEvent, SideThreadCommandInvariantError> =>
  Effect.gen(function* () {
    const sideThread = readModel.sideThreads.get(command.sideThreadId);
    if (!sideThread) {
      return yield* new SideThreadCommandInvariantError({
        commandType: command.type,
        detail: `Unknown SideThread: ${command.sideThreadId}`,
      });
    }
    if (sideThread.archivedAt !== null) {
      return yield* new SideThreadCommandInvariantError({
        commandType: command.type,
        detail: `SideThread is archived: ${command.sideThreadId}`,
      });
    }
    const message = sideThread.messages.find((m) => m.id === command.messageId);
    if (!message) {
      return yield* new SideThreadCommandInvariantError({
        commandType: command.type,
        detail: `Unknown message: ${command.messageId}`,
      });
    }
    // A user can only rewrite their own messages — never another peer's.
    // The transport already pins identity to the WS session, but defend
    // here too so a buggy client can't silently corrupt history.
    if (message.author.id !== command.editor.id) {
      return yield* new SideThreadCommandInvariantError({
        commandType: command.type,
        detail: `Only the author can edit a message: ${command.messageId}`,
      });
    }
    // No-op guard: don't burn an event for a "rewrite to same text".
    if (message.text === command.text) {
      return yield* new SideThreadCommandInvariantError({
        commandType: command.type,
        detail: "Edit is a no-op (text unchanged)",
      });
    }
    return {
      ...baseEnvelope(command, command.sideThreadId, now),
      type: "sidethread.message-edited" as const,
      payload: {
        sideThreadId: command.sideThreadId,
        messageId: command.messageId,
        editor: command.editor,
        text: command.text,
      },
    };
  });

const decideMarkRead = ({
  command,
  readModel,
  now,
}: {
  command: SideThreadMarkReadCommand;
  readModel: SideThreadReadModel;
  now: IsoDateTime;
}): Effect.Effect<PlannedSideThreadEvent, SideThreadCommandInvariantError> =>
  Effect.gen(function* () {
    if (!readModel.sideThreads.has(command.sideThreadId)) {
      return yield* new SideThreadCommandInvariantError({
        commandType: command.type,
        detail: `Unknown SideThread: ${command.sideThreadId}`,
      });
    }
    // Read markers are monotonic — we always emit and let the projector
    // take the max. Same upsert pattern as `inbox.dismiss`. This keeps
    // the decider stateless w.r.t. read-marker history.
    return {
      ...baseEnvelope(command, command.sideThreadId, now),
      type: "sidethread.marked-read" as const,
      payload: {
        sideThreadId: command.sideThreadId,
        user: command.user,
        lastReadAt: command.lastReadAt,
      },
    };
  });
