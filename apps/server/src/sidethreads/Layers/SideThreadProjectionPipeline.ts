/**
 * SideThreadProjectionPipeline live — writes side thread snapshots and
 * messages into SQLite read-model tables.
 *
 * Bootstrap strategy (v0): truncate the projection tables and replay every
 * event from `side_thread_events`. Volumes are tiny (handful of side threads
 * per parent thread), so the simplicity outweighs the cost of a cursor.
 *
 * @module SideThreadProjectionPipelineLive
 */
import { SideThread, type SideThreadEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";

const SideThreadJson = Schema.fromJsonString(SideThread);
const encodeSnapshot = Schema.encodeUnknownEffect(SideThreadJson);
const decodeSnapshot = Schema.decodeUnknownEffect(SideThreadJson);

const PREVIEW_MAX_CHARS = 240;
/**
 * Single-line, length-capped preview of a side-thread message stored
 * alongside each mention so the inbox can render rows without re-fetching
 * the full message. Stays > 1 char so the contract's
 * `TrimmedNonEmptyString` decoder doesn't reject it on read.
 */
const truncateForPreview = (text: string): string => {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length === 0) return "…";
  if (singleLine.length <= PREVIEW_MAX_CHARS) return singleLine;
  return `${singleLine.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
};
import { SideThreadEventStore } from "../../persistence/Services/SideThreadEventStore.ts";
import {
  SideThreadProjectionPipeline,
  type SideThreadProjectionPipelineShape,
} from "../Services/SideThreadProjectionPipeline.ts";

interface SnapshotRow {
  readonly snapshot_json: string;
  readonly stream_version: number;
}

const makeSideThreadProjectionPipeline = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* SideThreadEventStore;

  const insertSnapshot = (snapshot: SideThread, streamVersion: number) =>
    Effect.gen(function* () {
      const snapshotJson = yield* encodeSnapshot(snapshot).pipe(
        Effect.mapError(toPersistenceDecodeError("SideThreadProjection.insertSnapshot:encode")),
      );
      yield* sql`
        INSERT INTO projection_side_threads (
          side_thread_id,
          parent_thread_id,
          anchor_kind,
          anchor_message_id,
          created_by_user_id,
          created_at,
          updated_at,
          archived_at,
          stream_version,
          snapshot_json
        ) VALUES (
          ${snapshot.id},
          ${snapshot.parentThreadId},
          ${snapshot.anchor.kind},
          ${snapshot.anchor.kind === "message" ? snapshot.anchor.messageId : null},
          ${snapshot.createdBy.id},
          ${snapshot.createdAt},
          ${snapshot.updatedAt},
          ${snapshot.archivedAt},
          ${streamVersion},
          ${snapshotJson}
        )
      `.pipe(Effect.mapError(toPersistenceSqlError("SideThreadProjection.insertSnapshot")));
    });

  const updateSnapshot = (sideThreadId: string, snapshot: SideThread) =>
    Effect.gen(function* () {
      const snapshotJson = yield* encodeSnapshot(snapshot).pipe(
        Effect.mapError(toPersistenceDecodeError("SideThreadProjection.updateSnapshot:encode")),
      );
      yield* sql`
        UPDATE projection_side_threads
        SET snapshot_json = ${snapshotJson},
            stream_version = stream_version + 1,
            updated_at = ${snapshot.updatedAt},
            archived_at = ${snapshot.archivedAt}
        WHERE side_thread_id = ${sideThreadId}
      `.pipe(Effect.mapError(toPersistenceSqlError("SideThreadProjection.updateSnapshot")));
    });

  const loadSnapshot = (sideThreadId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<SnapshotRow>`
        SELECT snapshot_json, stream_version
        FROM projection_side_threads
        WHERE side_thread_id = ${sideThreadId}
      `.pipe(Effect.mapError(toPersistenceSqlError("SideThreadProjection.loadSnapshot")));
      const row = rows[0];
      if (!row) return null;
      return yield* decodeSnapshot(row.snapshot_json).pipe(
        Effect.mapError(toPersistenceDecodeError("SideThreadProjection.loadSnapshot:decode")),
      );
    });

  const projectEvent: SideThreadProjectionPipelineShape["projectEvent"] = (event) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "sidethread.created": {
          const snapshot: SideThread = {
            id: event.payload.sideThreadId,
            parentThreadId: event.payload.parentThreadId,
            anchor: event.payload.anchor,
            createdBy: event.payload.createdBy,
            createdAt: event.occurredAt,
            updatedAt: event.occurredAt,
            archivedAt: null,
            messages: [],
          };
          yield* insertSnapshot(snapshot, event.sequence);
          break;
        }

        case "sidethread.message-posted": {
          yield* sql`
            INSERT INTO projection_side_thread_messages (
              message_id,
              side_thread_id,
              author_user_id,
              author_display_name,
              text,
              created_at,
              updated_at
            ) VALUES (
              ${event.payload.messageId},
              ${event.payload.sideThreadId},
              ${event.payload.author.id},
              ${event.payload.author.displayName},
              ${event.payload.text},
              ${event.occurredAt},
              ${event.occurredAt}
            )
          `.pipe(Effect.mapError(toPersistenceSqlError("SideThreadProjection.insertMessage")));

          const current = yield* loadSnapshot(event.payload.sideThreadId);
          const mentionsForMessage = event.payload.mentions ?? [];
          if (current) {
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
                  mentions: mentionsForMessage,
                },
              ],
            };
            yield* updateSnapshot(event.payload.sideThreadId, updated);
          }

          // Inbox projection: one row per (message, mentioned user). The
          // (message_id, user_id) PK makes bootstrap replay idempotent and
          // de-duplicates if a buggy command ships the same user twice.
          if (mentionsForMessage.length > 0) {
            const anchorMessageId =
              current?.anchor.kind === "message" ? current.anchor.messageId : null;
            const parentThreadId = current?.parentThreadId;
            // We need parentThreadId to power the inbox. If the snapshot
            // hasn't materialised yet (out-of-order replay), skip — bootstrap
            // will redo the insert after the SideThread snapshot lands.
            if (parentThreadId) {
              const textPreview = truncateForPreview(event.payload.text);
              for (const mention of mentionsForMessage) {
                yield* sql`
                  INSERT INTO projection_side_thread_message_mentions (
                    message_id,
                    user_id,
                    side_thread_id,
                    parent_thread_id,
                    anchor_message_id,
                    author_user_id,
                    author_display_name,
                    text_preview,
                    occurred_at
                  ) VALUES (
                    ${event.payload.messageId},
                    ${mention.id},
                    ${event.payload.sideThreadId},
                    ${parentThreadId},
                    ${anchorMessageId},
                    ${event.payload.author.id},
                    ${event.payload.author.displayName},
                    ${textPreview},
                    ${event.occurredAt}
                  )
                  ON CONFLICT(message_id, user_id) DO UPDATE SET
                    side_thread_id = excluded.side_thread_id,
                    parent_thread_id = excluded.parent_thread_id,
                    anchor_message_id = excluded.anchor_message_id,
                    author_user_id = excluded.author_user_id,
                    author_display_name = excluded.author_display_name,
                    text_preview = excluded.text_preview,
                    occurred_at = excluded.occurred_at
                `.pipe(
                  Effect.mapError(toPersistenceSqlError("SideThreadProjection.insertMention")),
                );
              }
            }
          }
          break;
        }

        case "sidethread.archived": {
          const current = yield* loadSnapshot(event.payload.sideThreadId);
          if (current) {
            const updated: SideThread = {
              ...current,
              updatedAt: event.occurredAt,
              archivedAt: event.occurredAt,
            };
            yield* updateSnapshot(event.payload.sideThreadId, updated);
          }
          break;
        }

        case "sidethread.inbox-dismissed": {
          // Upsert keeps replay idempotent and lets a user bump dismissed_at
          // forward by dismissing again after newer mentions arrive.
          yield* sql`
            INSERT INTO projection_inbox_dismissals (
              user_id,
              side_thread_id,
              dismissed_at
            ) VALUES (
              ${event.payload.userId},
              ${event.payload.sideThreadId},
              ${event.occurredAt}
            )
            ON CONFLICT(user_id, side_thread_id) DO UPDATE SET
              dismissed_at = excluded.dismissed_at
          `.pipe(
            Effect.mapError(toPersistenceSqlError("SideThreadProjection.upsertInboxDismissal")),
          );
          break;
        }
      }
    });

  const bootstrap: Effect.Effect<void, ProjectionRepositoryError> = Effect.gen(function* () {
    yield* sql`DELETE FROM projection_inbox_dismissals`.pipe(
      Effect.mapError(toPersistenceSqlError("SideThreadProjection.bootstrap:truncateDismissals")),
    );
    yield* sql`DELETE FROM projection_side_thread_message_mentions`.pipe(
      Effect.mapError(toPersistenceSqlError("SideThreadProjection.bootstrap:truncateMentions")),
    );
    yield* sql`DELETE FROM projection_side_thread_messages`.pipe(
      Effect.mapError(toPersistenceSqlError("SideThreadProjection.bootstrap:truncateMessages")),
    );
    yield* sql`DELETE FROM projection_side_threads`.pipe(
      Effect.mapError(toPersistenceSqlError("SideThreadProjection.bootstrap:truncateSnapshots")),
    );
    yield* eventStore
      .readAll()
      .pipe(Stream.runForEach((event: SideThreadEvent) => projectEvent(event)));
  });

  return { bootstrap, projectEvent } satisfies SideThreadProjectionPipelineShape;
});

export const SideThreadProjectionPipelineLive = Layer.effect(
  SideThreadProjectionPipeline,
  makeSideThreadProjectionPipeline,
);
