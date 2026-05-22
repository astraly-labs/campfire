/**
 * SideThreadProjectionPipeline live — writes side thread snapshots and
 * messages into SQLite read-model tables.
 *
 * Bootstrap strategy (v0): truncate the projection tables and replay every
 * event from `side_thread_events`. Volumes are tiny (handful of side threads
 * per parent thread), so the simplicity outweighs the cost of a cursor.
 *
 * Replay funnels every event through {@link SideThreadEventNormalizer} so
 * legacy events created under the old "one side-thread per anchored
 * message" model collapse onto the canonical `st-{parentThreadId}`
 * aggregate.
 *
 * @module SideThreadProjectionPipelineLive
 */
import {
  SideThread,
  type SideThreadEvent,
  type SideThreadMessage,
  type SideThreadMessageReaction,
  type UserRef,
} from "@t3tools/contracts";
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
import { SideThreadEventNormalizer } from "../normalize.ts";

const SideThreadJson = Schema.fromJsonString(SideThread);
const encodeSnapshot = Schema.encodeUnknownEffect(SideThreadJson);
const decodeSnapshot = Schema.decodeUnknownEffect(SideThreadJson);

/**
 * Mirror of the in-memory projector's reaction delta, but typed against the
 * snapshot read-model (which is identical in shape to the engine read-model
 * for our purposes). Kept here to avoid a cross-module import — the
 * function is 30 lines and trivially auditable.
 */
const applyReactionDeltaSnapshot = (
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
          created_by_user_id,
          created_at,
          updated_at,
          archived_at,
          stream_version,
          snapshot_json
        ) VALUES (
          ${snapshot.id},
          ${snapshot.parentThreadId},
          ${snapshot.createdBy.id},
          ${snapshot.createdAt},
          ${snapshot.updatedAt},
          ${snapshot.archivedAt},
          ${streamVersion},
          ${snapshotJson}
        )
        ON CONFLICT(side_thread_id) DO NOTHING
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
            createdBy: event.payload.createdBy,
            createdAt: event.occurredAt,
            updatedAt: event.occurredAt,
            archivedAt: null,
            messages: [],
            readBy: [],
          };
          yield* insertSnapshot(snapshot, event.sequence);
          break;
        }

        case "sidethread.message-posted": {
          const quotedMessageId = event.payload.quotedMessageId ?? null;
          yield* sql`
            INSERT INTO projection_side_thread_messages (
              message_id,
              side_thread_id,
              author_user_id,
              author_display_name,
              text,
              created_at,
              updated_at,
              quoted_message_id
            ) VALUES (
              ${event.payload.messageId},
              ${event.payload.sideThreadId},
              ${event.payload.author.id},
              ${event.payload.author.displayName},
              ${event.payload.text},
              ${event.occurredAt},
              ${event.occurredAt},
              ${quotedMessageId}
            )
            ON CONFLICT(message_id) DO NOTHING
          `.pipe(Effect.mapError(toPersistenceSqlError("SideThreadProjection.insertMessage")));

          const current = yield* loadSnapshot(event.payload.sideThreadId);
          const mentionsForMessage = event.payload.mentions ?? [];
          const attachmentsForMessage = event.payload.attachments ?? [];
          const linkedRefForMessage = event.payload.linkedRef ?? null;
          const replyToForMessage = event.payload.replyToSideThreadMessageId ?? null;
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
                  quotedMessageId,
                  attachments: attachmentsForMessage,
                  reactions: [],
                  linkedRef: linkedRefForMessage,
                  replyToSideThreadMessageId: replyToForMessage,
                  editedAt: null,
                },
              ],
            };
            yield* updateSnapshot(event.payload.sideThreadId, updated);
          }

          // Inbox projection: one row per (message, mentioned user). The
          // (message_id, user_id) PK makes bootstrap replay idempotent and
          // de-duplicates if a buggy command ships the same user twice.
          //
          // `parent_thread_id` may be NULL — that's how the workspace-wide
          // global chat appears in the inbox. We still need the SideThread
          // snapshot to be materialised before we can derive the parent (or
          // confirm it's a global chat), so skip when `current` is missing
          // (out-of-order replay); bootstrap re-runs the insert after the
          // snapshot lands.
          if (mentionsForMessage.length > 0 && current) {
            const parentThreadId = current.parentThreadId;
            const textPreview = truncateForPreview(event.payload.text);
            for (const mention of mentionsForMessage) {
              yield* sql`
                INSERT INTO projection_side_thread_message_mentions (
                  message_id,
                  user_id,
                  side_thread_id,
                  parent_thread_id,
                  quoted_message_id,
                  author_user_id,
                  author_display_name,
                  text_preview,
                  occurred_at
                ) VALUES (
                  ${event.payload.messageId},
                  ${mention.id},
                  ${event.payload.sideThreadId},
                  ${parentThreadId},
                  ${quotedMessageId},
                  ${event.payload.author.id},
                  ${event.payload.author.displayName},
                  ${textPreview},
                  ${event.occurredAt}
                )
                ON CONFLICT(message_id, user_id) DO UPDATE SET
                  side_thread_id = excluded.side_thread_id,
                  parent_thread_id = excluded.parent_thread_id,
                  quoted_message_id = excluded.quoted_message_id,
                  author_user_id = excluded.author_user_id,
                  author_display_name = excluded.author_display_name,
                  text_preview = excluded.text_preview,
                  occurred_at = excluded.occurred_at
              `.pipe(
                Effect.mapError(toPersistenceSqlError("SideThreadProjection.insertMention")),
              );
            }
          }
          break;
        }

        case "sidethread.message-reacted": {
          // Reactions live entirely inside the snapshot JSON — no dedicated
          // SQL table. We re-load the current snapshot, apply the toggle
          // delta in-place, and write it back. Volumes are tiny and the
          // read-modify-write happens inside the projection pipeline's
          // serial loop, so no concurrency window to worry about.
          const current = yield* loadSnapshot(event.payload.sideThreadId);
          if (!current) break;
          const messageIndex = current.messages.findIndex(
            (m) => m.id === event.payload.messageId,
          );
          if (messageIndex < 0) break;
          const message = current.messages[messageIndex]!;
          const updatedMessage = applyReactionDeltaSnapshot(
            message,
            event.payload.user,
            event.payload.emoji,
            event.payload.action,
            event.occurredAt,
          );
          if (updatedMessage === message) break;
          const updated: SideThread = {
            ...current,
            updatedAt: event.occurredAt,
            messages: current.messages.map((m, idx) =>
              idx === messageIndex ? updatedMessage : m,
            ),
          };
          yield* updateSnapshot(event.payload.sideThreadId, updated);
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

        case "sidethread.message-edited": {
          // Update both the dedicated flat row (so inbox preview / text
          // searches reflect the edit) and the snapshot JSON inside the
          // aggregate. The flat-row UPDATE is no-op safe if the row
          // isn't there (defensive replay).
          yield* sql`
            UPDATE projection_side_thread_messages
            SET text = ${event.payload.text}, updated_at = ${event.occurredAt}
            WHERE message_id = ${event.payload.messageId}
          `.pipe(Effect.mapError(toPersistenceSqlError("SideThreadProjection.editMessage")));

          const current = yield* loadSnapshot(event.payload.sideThreadId);
          if (!current) break;
          const messageIndex = current.messages.findIndex(
            (m) => m.id === event.payload.messageId,
          );
          if (messageIndex < 0) break;
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
            messages: current.messages.map((m, idx) =>
              idx === messageIndex ? updatedMessage : m,
            ),
          };
          yield* updateSnapshot(event.payload.sideThreadId, updated);
          break;
        }

        case "sidethread.marked-read": {
          // Read markers live inside the snapshot JSON — no dedicated SQL
          // table (same trade-off as reactions). Replay is idempotent
          // because we take max() on apply.
          const current = yield* loadSnapshot(event.payload.sideThreadId);
          if (!current) break;
          const userId = event.payload.user.id;
          const incomingAt = event.payload.lastReadAt;
          const existingIndex = current.readBy.findIndex((m) => m.user.id === userId);
          const nextMarker = { user: event.payload.user, lastReadAt: incomingAt };
          let nextReadBy: SideThread["readBy"];
          if (existingIndex < 0) {
            nextReadBy = [...current.readBy, nextMarker];
          } else {
            const existing = current.readBy[existingIndex]!;
            if (existing.lastReadAt >= incomingAt) break;
            nextReadBy = current.readBy.map((m, idx) =>
              idx === existingIndex ? nextMarker : m,
            );
          }
          const updated: SideThread = {
            ...current,
            updatedAt: event.occurredAt,
            readBy: nextReadBy,
          };
          yield* updateSnapshot(event.payload.sideThreadId, updated);
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
    const normalizer = new SideThreadEventNormalizer();
    yield* eventStore.readAll().pipe(
      Stream.runForEach((event: SideThreadEvent) => {
        const normalized = normalizer.normalize(event);
        if (!normalized) return Effect.void;
        return projectEvent(normalized);
      }),
    );
  });

  return { bootstrap, projectEvent } satisfies SideThreadProjectionPipelineShape;
});

export const SideThreadProjectionPipelineLive = Layer.effect(
  SideThreadProjectionPipeline,
  makeSideThreadProjectionPipeline,
);
