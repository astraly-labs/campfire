/**
 * SideThreadEventStore live implementation — SQLite-backed.
 *
 * Persists planned events into `side_thread_events` and exposes ordered
 * replay streams. The caller passes an event without `sequence` (assigned
 * by the AUTOINCREMENT PK) and an explicit `actorUserId` (extracted upstream
 * by the engine where the discriminated union is properly narrowed).
 *
 * @module SideThreadEventStoreLive
 */
import { SideThreadEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type SideThreadEventStoreError,
} from "../Errors.ts";
import {
  SideThreadEventStore,
  type SideThreadEventStoreShape,
} from "../Services/SideThreadEventStore.ts";

const decodeEvent = Schema.decodeUnknownEffect(SideThreadEvent);
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodePayload = Schema.decodeUnknownEffect(UnknownFromJsonString);

interface SideThreadEventRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly side_thread_id: string;
  readonly stream_version: number;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly command_id: string | null;
  readonly causation_event_id: string | null;
  readonly correlation_id: string | null;
  readonly actor_user_id: string;
  readonly payload_json: string;
  readonly metadata_json: string;
}

const rowToEvent = (row: SideThreadEventRow) =>
  Effect.gen(function* () {
    const payload = yield* decodePayload(row.payload_json).pipe(
      Effect.mapError(toPersistenceDecodeError("SideThreadEventStore.rowToEvent:payload")),
    );
    const metadata = yield* decodePayload(row.metadata_json).pipe(
      Effect.mapError(toPersistenceDecodeError("SideThreadEventStore.rowToEvent:metadata")),
    );
    return yield* decodeEvent({
      sequence: row.sequence,
      eventId: row.event_id,
      aggregateKind: "sidethread",
      aggregateId: row.side_thread_id,
      occurredAt: row.occurred_at,
      commandId: row.command_id,
      causationEventId: row.causation_event_id,
      correlationId: row.correlation_id,
      metadata,
      type: row.event_type,
      payload,
    }).pipe(Effect.mapError(toPersistenceDecodeError("SideThreadEventStore.rowToEvent:event")));
  });

const DEFAULT_PAGE_SIZE = 256;

const normalizeLimit = (limit: number | undefined): number => {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  const asInt = Math.trunc(limit);
  if (!Number.isFinite(asInt) || asInt <= 0) return DEFAULT_PAGE_SIZE;
  return asInt;
};

const encodePayload = Schema.encodeUnknownEffect(UnknownFromJsonString);

const makeSideThreadEventStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const append: SideThreadEventStoreShape["append"] = (event, actorUserId) =>
    Effect.gen(function* () {
      const payloadJson = yield* encodePayload(event.payload).pipe(
        Effect.mapError(toPersistenceDecodeError("SideThreadEventStore.append:payload")),
      );
      const metadataJson = yield* encodePayload(event.metadata).pipe(
        Effect.mapError(toPersistenceDecodeError("SideThreadEventStore.append:metadata")),
      );

      const versionRows = yield* sql<{ next_version: number }>`
        SELECT COALESCE(MAX(stream_version), 0) + 1 AS next_version
        FROM side_thread_events
        WHERE side_thread_id = ${event.aggregateId}
      `.pipe(Effect.mapError(toPersistenceSqlError("SideThreadEventStore.append:version")));
      const streamVersion = versionRows[0]?.next_version ?? 1;

      const inserted = yield* sql<{ sequence: number }>`
        INSERT INTO side_thread_events (
          event_id,
          side_thread_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_user_id,
          payload_json,
          metadata_json
        ) VALUES (
          ${event.eventId},
          ${event.aggregateId},
          ${streamVersion},
          ${event.type},
          ${event.occurredAt},
          ${event.commandId},
          ${event.causationEventId},
          ${event.correlationId},
          ${actorUserId},
          ${payloadJson},
          ${metadataJson}
        )
        RETURNING sequence
      `.pipe(Effect.mapError(toPersistenceSqlError("SideThreadEventStore.append:insert")));

      const sequence = inserted[0]?.sequence;
      if (sequence === undefined) {
        return yield* toPersistenceSqlError("SideThreadEventStore.append:insert")(
          new Error("INSERT did not return a sequence"),
        );
      }
      return { ...event, sequence } as SideThreadEvent;
    });

  const readFromSequence: SideThreadEventStoreShape["readFromSequence"] = (
    sequenceExclusive,
    limit,
  ) => {
    const pageSize = normalizeLimit(limit);
    return Stream.unwrap(
      Effect.gen(function* () {
        const rows = yield* sql<SideThreadEventRow>`
          SELECT * FROM side_thread_events
          WHERE sequence > ${sequenceExclusive}
          ORDER BY sequence ASC
          LIMIT ${pageSize}
        `.pipe(Effect.mapError(toPersistenceSqlError("SideThreadEventStore.readFromSequence")));
        return Stream.fromIterable(rows).pipe(Stream.mapEffect(rowToEvent));
      }),
    );
  };

  const readAll: SideThreadEventStoreShape["readAll"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const rows = yield* sql<SideThreadEventRow>`
          SELECT * FROM side_thread_events ORDER BY sequence ASC
        `.pipe(Effect.mapError(toPersistenceSqlError("SideThreadEventStore.readAll")));
        return Stream.fromIterable(rows).pipe(Stream.mapEffect(rowToEvent));
      }),
    );

  return { append, readFromSequence, readAll } satisfies SideThreadEventStoreShape;
});

export const SideThreadEventStoreLive = Layer.effect(
  SideThreadEventStore,
  makeSideThreadEventStore,
);

export type { SideThreadEventStoreError };
