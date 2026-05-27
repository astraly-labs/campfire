/**
 * InboxReadModelLive — SQLite implementation of {@link InboxReadModelShape}.
 *
 * Returns two kinds of rows for the current user, unioned into one list:
 *  - `"mention"` — side-threads where the user was @mentioned, derived from
 *    `projection_side_thread_message_mentions`, minus soft-dismissed rows.
 *  - `"activity"` — side-threads the user participates in (has posted in),
 *    derived from `projection_side_thread_participants`, surfacing the latest
 *    message authored by *someone else*. This is what makes "a teammate
 *    replied in a thread I'm in" reach the inbox without an @mention.
 *
 * One side-thread can yield both a mention row and an activity row; the client
 * keys items by `(kind, sideThreadId)` and renders each kind in its own
 * section.
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
import { truncateForPreview } from "../preview.ts";
import { InboxReadModelService, type InboxReadModelShape } from "../Services/InboxReadModel.ts";

/** Cap on activity rows so an active workspace can't grow the inbox without bound. */
const ACTIVITY_ROW_LIMIT = 100;

interface MentionRow {
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

interface ActivityRow {
  readonly side_thread_id: string;
  readonly parent_thread_id: string | null;
  readonly last_message_id: string;
  readonly last_activity_at: string;
  readonly last_author_user_id: string;
  readonly last_author_display_name: string;
  /** Raw message text — truncated to a single-line preview in TS. */
  readonly last_text: string;
  readonly other_count: number;
}

const encodeInboxItem = Schema.encodeUnknownEffect(InboxItem);

/** Lift a candidate item through Schema validation, dying on malformed rows
 * (the projection tables are fully owned by our projector, so drift is a bug,
 * not a typed error). */
const validate = (item: InboxItem): Effect.Effect<InboxItem, never> =>
  Effect.orDie(encodeInboxItem(item).pipe(Effect.as(item)));

const mentionRowToItem = (row: MentionRow): Effect.Effect<InboxItem, never> => {
  const author: UserRef = {
    id: row.last_author_user_id as UserId,
    displayName: row.last_author_display_name,
  };
  return validate({
    kind: "mention",
    sideThreadId: row.side_thread_id as SideThreadId,
    parentThreadId: row.parent_thread_id === null ? null : (row.parent_thread_id as ThreadId),
    quotedMessageId: (row.quoted_message_id ?? null) as MessageId | null,
    lastActivityAt: row.last_mention_at,
    lastMessageId: row.last_mention_message_id as SideThreadMessageId,
    lastAuthor: author,
    lastPreview: row.last_text_preview,
    count: row.mentions_count,
  });
};

const activityRowToItem = (row: ActivityRow): Effect.Effect<InboxItem, never> => {
  const author: UserRef = {
    id: row.last_author_user_id as UserId,
    displayName: row.last_author_display_name,
  };
  return validate({
    kind: "activity",
    sideThreadId: row.side_thread_id as SideThreadId,
    parentThreadId: row.parent_thread_id === null ? null : (row.parent_thread_id as ThreadId),
    quotedMessageId: null,
    lastActivityAt: row.last_activity_at,
    lastMessageId: row.last_message_id as SideThreadMessageId,
    lastAuthor: author,
    lastPreview: truncateForPreview(row.last_text),
    count: row.other_count,
  });
};

const makeInboxReadModel = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listForUser: InboxReadModelShape["listForUser"] = (userId) =>
    Effect.gen(function* () {
      // --- Mentions ------------------------------------------------------
      // LEFT JOIN + `occurred_at > dismissed_at` hides every mention the
      // user has soft-dismissed. A fresh mention with a later `occurred_at`
      // re-surfaces the side-thread without an explicit undismiss step.
      // `mentions_count` is computed after the dismiss filter so the badge
      // only reflects the visible (post-dismiss) mentions.
      const mentionRows = yield* sql<MentionRow>`
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
      `.pipe(Effect.mapError(toPersistenceSqlError("InboxReadModel.listForUser:mentions")));

      // --- Activity ------------------------------------------------------
      // For every side-thread the user participates in (has posted in),
      // surface the latest message authored by *someone else*. `other_count`
      // is the number of such non-self messages — the "N new messages" hint.
      // Archived threads are excluded (an archived side-thread is muted).
      const activityRows = yield* sql<ActivityRow>`
        WITH my_threads AS (
          SELECT side_thread_id
          FROM projection_side_thread_participants
          WHERE user_id = ${userId}
        ),
        others AS (
          SELECT
            msg.side_thread_id,
            msg.message_id,
            msg.author_user_id,
            msg.author_display_name,
            msg.text,
            msg.created_at,
            COUNT(*) OVER (PARTITION BY msg.side_thread_id) AS other_count,
            ROW_NUMBER() OVER (
              PARTITION BY msg.side_thread_id
              ORDER BY msg.created_at DESC, msg.message_id DESC
            ) AS rn
          FROM projection_side_thread_messages msg
          JOIN my_threads t ON t.side_thread_id = msg.side_thread_id
          WHERE msg.author_user_id <> ${userId}
        )
        SELECT
          o.side_thread_id,
          st.parent_thread_id,
          o.message_id AS last_message_id,
          o.created_at AS last_activity_at,
          o.author_user_id AS last_author_user_id,
          o.author_display_name AS last_author_display_name,
          o.text AS last_text,
          o.other_count
        FROM others o
        JOIN projection_side_threads st ON st.side_thread_id = o.side_thread_id
        WHERE o.rn = 1
          AND st.archived_at IS NULL
        ORDER BY o.created_at DESC
        LIMIT ${ACTIVITY_ROW_LIMIT}
      `.pipe(Effect.mapError(toPersistenceSqlError("InboxReadModel.listForUser:activity")));

      const mentions = yield* Effect.all(mentionRows.map(mentionRowToItem));
      const activity = yield* Effect.all(activityRows.map(activityRowToItem));
      return [...mentions, ...activity];
    });

  return { listForUser } satisfies InboxReadModelShape;
});

export const InboxReadModelLive = Layer.effect(InboxReadModelService, makeInboxReadModel);
