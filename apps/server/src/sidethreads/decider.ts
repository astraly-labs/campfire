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
  SideThreadMessagePostCommand,
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
    case "sidethread.archive":
      return yield* decideArchive({ command, readModel, now });
    case "sidethread.inbox.dismiss":
      return yield* decideInboxDismiss({ command, readModel, now });
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
        anchor: command.anchor,
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
    return {
      ...baseEnvelope(command, command.sideThreadId, now),
      type: "sidethread.message-posted" as const,
      payload: {
        sideThreadId: command.sideThreadId,
        messageId: command.messageId,
        author: command.author,
        text: command.text,
        mentions: command.mentions,
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
