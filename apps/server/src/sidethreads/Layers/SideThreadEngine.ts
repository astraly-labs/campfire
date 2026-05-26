/**
 * SideThreadEngine live — serializes command dispatch, persists events,
 * applies projection updates, and broadcasts persisted events to subscribers.
 *
 * Flow per command:
 *   1. dispatch enqueues a CommandEnvelope and awaits a Deferred.
 *   2. The worker fiber reads commands one-at-a-time:
 *        decide → withTransaction { eventStore.append + projectEvent } → publish.
 *   3. The in-memory `commandReadModel` is updated after each event so the
 *      next dispatch sees up-to-date invariants.
 *
 * Broadcast uses `PubSub` so each WS subscriber gets its own filtered stream.
 *
 * @module SideThreadEngineLive
 */
import type {
  SideThreadArchivedPayload,
  SideThreadCommand,
  SideThreadCreatedPayload,
  SideThreadDetailSnapshot,
  SideThreadEvent,
  SideThreadInboxDismissedPayload,
  SideThreadMarkedReadPayload,
  SideThreadMessageEditedPayload,
  SideThreadMessagePostedPayload,
  SideThreadMessageReactedPayload,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { SideThreadEventStore } from "../../persistence/Services/SideThreadEventStore.ts";
import { persistSideThreadPostAttachments } from "../attachmentNormalizer.ts";
import { decideSideThreadCommand, type PlannedSideThreadEvent } from "../decider.ts";
import { SideThreadCommandInvariantError, type SideThreadDispatchError } from "../Errors.ts";
import { SideThreadEventNormalizer } from "../normalize.ts";
import { projectSideThreadEvent } from "../projector.ts";
import { createEmptySideThreadReadModel, type SideThreadReadModel } from "../readModel.ts";
import {
  SideThreadEngineService,
  type SideThreadEngineShape,
} from "../Services/SideThreadEngine.ts";
import { SideThreadProjectionPipeline } from "../Services/SideThreadProjectionPipeline.ts";

interface CommandEnvelope {
  readonly command: SideThreadCommand;
  readonly result: Deferred.Deferred<{ sequence: number }, SideThreadDispatchError>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const actorOf = (planned: PlannedSideThreadEvent): string => {
  switch (planned.type) {
    case "sidethread.created":
      return (planned.payload as SideThreadCreatedPayload).createdBy.id;
    case "sidethread.message-posted":
      return (planned.payload as SideThreadMessagePostedPayload).author.id;
    case "sidethread.message-reacted":
      return (planned.payload as SideThreadMessageReactedPayload).user.id;
    case "sidethread.archived":
      return (planned.payload as SideThreadArchivedPayload).archivedBy;
    case "sidethread.inbox-dismissed":
      return (planned.payload as SideThreadInboxDismissedPayload).userId;
    case "sidethread.marked-read":
      return (planned.payload as SideThreadMarkedReadPayload).user.id;
    case "sidethread.message-edited":
      return (planned.payload as SideThreadMessageEditedPayload).editor.id;
  }
};

const makeSideThreadEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* SideThreadEventStore;
  const projectionPipeline = yield* SideThreadProjectionPipeline;

  yield* projectionPipeline.bootstrap;

  let commandReadModel: SideThreadReadModel = createEmptySideThreadReadModel(yield* nowIso);

  // Legacy events keyed side threads by `st-{parent}-{message}`; collapse
  // them onto the canonical `st-{parent}` aggregate as we rebuild the
  // in-memory command read model. Events produced post-migration use the
  // canonical id natively, so the normalizer is a no-op for them.
  const replayNormalizer = new SideThreadEventNormalizer();
  yield* eventStore.readAll().pipe(
    Stream.runForEach((event: SideThreadEvent) =>
      Effect.sync(() => {
        const normalized = replayNormalizer.normalize(event);
        if (!normalized) return;
        commandReadModel = projectSideThreadEvent(commandReadModel, normalized);
      }),
    ),
  );

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<SideThreadEvent>();

  const processEnvelope = (
    envelope: CommandEnvelope,
  ): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path | ServerConfig> =>
    Effect.exit(
      Effect.gen(function* () {
        const now = yield* nowIso;
        // Resolve wire attachments → persisted attachments before deciding:
        // upload images get written to the blob store and swapped for an id,
        // GIFs pass through. The decider stays pure and never sees raw bytes.
        const resolvedAttachments =
          envelope.command.type === "sidethread.message.post"
            ? yield* persistSideThreadPostAttachments({
                sideThreadId: envelope.command.sideThreadId,
                attachments: envelope.command.attachments,
              })
            : undefined;
        const planned = yield* decideSideThreadCommand({
          command: envelope.command,
          readModel: commandReadModel,
          now,
          resolvedAttachments,
        });
        const actorUserId = actorOf(planned);

        const savedEvent = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const saved = yield* eventStore.append(planned, actorUserId);
              yield* projectionPipeline.projectEvent(saved);
              return saved;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("SideThreadEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        commandReadModel = projectSideThreadEvent(commandReadModel, savedEvent);
        yield* PubSub.publish(eventPubSub, savedEvent);
        return { sequence: savedEvent.sequence };
      }),
    ).pipe(
      Effect.flatMap((exit) => {
        if (Exit.isSuccess(exit)) {
          return Deferred.succeed(envelope.result, exit.value);
        }
        const error = Cause.squash(exit.cause);
        const dispatchError: SideThreadDispatchError =
          error instanceof Error && "_tag" in error
            ? (error as SideThreadDispatchError)
            : new SideThreadCommandInvariantError({
                commandType: envelope.command.type,
                detail: `Unexpected engine failure: ${String(error)}`,
              });
        return Deferred.fail(envelope.result, dispatchError);
      }),
    );

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(worker);

  const dispatch: SideThreadEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, SideThreadDispatchError>();
      yield* Queue.offer(commandQueue, { command, result });
      return yield* Deferred.await(result);
    });

  const getSnapshot: SideThreadEngineShape["getSnapshot"] = (sideThreadId) =>
    Effect.sync(() => {
      const sideThread = commandReadModel.sideThreads.get(sideThreadId);
      if (!sideThread) return Option.none<SideThreadDetailSnapshot>();
      return Option.some({
        snapshotSequence: commandReadModel.snapshotSequence,
        sideThread,
      });
    });

  return {
    readEvents: (fromSequenceExclusive) => eventStore.readFromSequence(fromSequenceExclusive),
    dispatch,
    getSnapshot,
    get streamDomainEvents() {
      return Stream.fromPubSub(eventPubSub);
    },
  } satisfies SideThreadEngineShape;
});

export const SideThreadEngineLive = Layer.effect(SideThreadEngineService, makeSideThreadEngine);
