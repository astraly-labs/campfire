/**
 * InboxReadModelLive — SQLite implementation of {@link InboxReadModelShape}.
 *
 * One round-trip to SQLite per `listForUser` call, ordered by latest mention.
 * `MAX(occurred_at)` per side-thread keeps a single row per conversation in
 * the user's inbox; older mentions are folded into `mentionsCount`.
 *
 * @module InboxReadModelLive
 */
import {
  InboxItem,
  type MessageId,
  type SideThreadId,
  type SideThreadMessageId,
  type ThreadId,
  type UserId,
  type UserRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { InboxReadModelService, type InboxReadModelShape } from "../Services/InboxReadModel.ts";

interface InboxRow {
  readonly side_thread_id: string;
  /** NULL when the row belongs to the workspace-wide global chat. */
  readonly parent_thread_id: string | null;
  readonly quoted_message_id: string | null;
  readonly last_mention_message_id: string;
  readonly last_mention_at: string;
  readonly last_author_user_id: string;
  readonly last_author_display_name: string;
  readonly last_text_preview: string;
  readonly mentions_count: number;
}

const encodeInboxItem = Schema.encodeUnknownEffect(InboxItem);

const rowToInboxItem = (row: InboxRow): Effect.Effect<InboxItem, never> => {
  const author: UserRef = {
    id: row.last_author_user_id as UserId,
    displayName: row.last_author_display_name,
  };
  const item = {
    sideThreadId: row.side_thread_id as SideThreadId,
    parentThreadId: row.parent_thread_id === null ? null : (row.parent_thread_id as ThreadId),
    quotedMessageId: (row.quoted_message_id ?? null) as MessageId | null,
    lastMentionAt: row.last_mention_at,
    lastMentionMessageId: row.last_mention_message_id as SideThreadMessageId,
    lastMentionAuthor: author,
    lastMentionPreview: row.last_text_preview,
    mentionsCount: row.mentions_count,
  };
  // Validated via Schema so any drift (e.g. empty preview slipping in) is
  // surfaced early rather than as a Schema decode panic on the client.
  return Effect.orDie(encodeInboxItem(item).pipe(Effect.as(item)));
};

const makeInboxReadModel = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listForUser: InboxReadModelShape["listForUser"] = (userId) =>
    Effect.gen(function* () {
      // LEFT JOIN + `occurred_at > dismissed_at` hides every mention the
      // user has soft-dismissed. A fresh mention with a later `occurred_at`
      // re-surfaces the side-thread without an explicit undismiss step.
      // `mentions_count` is computed after the dismiss filter so the badge
      // only reflects the visible (post-dismiss) mentions.
      const rows = yield* sql<InboxRow>`
        WITH visible AS (
          SELECT
            m.side_thread_id,
            m.parent_thread_id,
            m.quoted_message_id,
            m.message_id,
            m.occurred_at,
            m.author_user_id,
            m.author_display_name,
            m.text_preview
          FROM projection_side_thread_message_mentions m
          LEFT JOIN projection_inbox_dismissals d
            ON d.user_id = m.user_id AND d.side_thread_id = m.side_thread_id
          WHERE m.user_id = ${userId}
            AND (d.dismissed_at IS NULL OR m.occurred_at > d.dismissed_at)
        ),
        ranked AS (
          SELECT
            side_thread_id,
            parent_thread_id,
            quoted_message_id,
            message_id,
            occurred_at,
            author_user_id,
            author_display_name,
            text_preview,
            COUNT(*) OVER (PARTITION BY side_thread_id) AS mentions_count,
            ROW_NUMBER() OVER (
              PARTITION BY side_thread_id
              ORDER BY occurred_at DESC, message_id DESC
            ) AS rn
          FROM visible
        )
        SELECT
          side_thread_id,
          parent_thread_id,
          quoted_message_id,
          message_id AS last_mention_message_id,
          occurred_at AS last_mention_at,
          author_user_id AS last_author_user_id,
          author_display_name AS last_author_display_name,
          text_preview AS last_text_preview,
          mentions_count
        FROM ranked
        WHERE rn = 1
        ORDER BY occurred_at DESC
      `.pipe(Effect.mapError(toPersistenceSqlError("InboxReadModel.listForUser")));

      // Lift each row through Schema validation (rowToInboxItem dies on
      // malformed rows rather than surfacing as a typed error, since the
      // table is fully owned by our projector).
      const items = yield* Effect.all(rows.map(rowToInboxItem));
      return items;
    });

  return { listForUser } satisfies InboxReadModelShape;
});

export const InboxReadModelLive = Layer.effect(InboxReadModelService, makeInboxReadModel);
