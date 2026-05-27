import { UserId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { InboxReadModelService } from "../Services/InboxReadModel.ts";
import { InboxReadModelLive } from "./InboxReadModel.ts";

const layer = it.layer(InboxReadModelLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const ME = "u-me";

/** Seed helpers mirror the columns the projection pipeline writes, so the test
 * exercises the real post-migration schema. */
const seed = {
  sideThread: (
    sql: SqlClient.SqlClient,
    opts: { id: string; parentThreadId: string | null; archivedAt?: string | null },
  ) =>
    sql`
      INSERT INTO projection_side_threads (
        side_thread_id, parent_thread_id, created_by_user_id,
        created_at, updated_at, archived_at, stream_version, snapshot_json
      ) VALUES (
        ${opts.id}, ${opts.parentThreadId}, ${ME},
        ${"2026-05-01T00:00:00.000Z"}, ${"2026-05-01T00:00:00.000Z"},
        ${opts.archivedAt ?? null}, ${0}, ${"{}"}
      )
    `,
  message: (
    sql: SqlClient.SqlClient,
    opts: {
      id: string;
      sideThreadId: string;
      authorId: string;
      authorName: string;
      text: string;
      at: string;
    },
  ) =>
    sql`
      INSERT INTO projection_side_thread_messages (
        message_id, side_thread_id, author_user_id, author_display_name,
        text, created_at, updated_at
      ) VALUES (
        ${opts.id}, ${opts.sideThreadId}, ${opts.authorId}, ${opts.authorName},
        ${opts.text}, ${opts.at}, ${opts.at}
      )
    `,
  participant: (
    sql: SqlClient.SqlClient,
    opts: { sideThreadId: string; userId: string; at: string },
  ) =>
    sql`
      INSERT INTO projection_side_thread_participants (side_thread_id, user_id, first_posted_at)
      VALUES (${opts.sideThreadId}, ${opts.userId}, ${opts.at})
    `,
  mention: (
    sql: SqlClient.SqlClient,
    opts: {
      messageId: string;
      userId: string;
      sideThreadId: string;
      parentThreadId: string | null;
      authorId: string;
      authorName: string;
      preview: string;
      at: string;
    },
  ) =>
    sql`
      INSERT INTO projection_side_thread_message_mentions (
        message_id, user_id, side_thread_id, parent_thread_id,
        author_user_id, author_display_name, text_preview, occurred_at
      ) VALUES (
        ${opts.messageId}, ${opts.userId}, ${opts.sideThreadId}, ${opts.parentThreadId},
        ${opts.authorId}, ${opts.authorName}, ${opts.preview}, ${opts.at}
      )
    `,
  dismissal: (
    sql: SqlClient.SqlClient,
    opts: { userId: string; sideThreadId: string; at: string },
  ) =>
    sql`
      INSERT INTO projection_inbox_dismissals (user_id, side_thread_id, dismissed_at)
      VALUES (${opts.userId}, ${opts.sideThreadId}, ${opts.at})
    `,
};

layer("InboxReadModel.listForUser", (it) => {
  it.effect("surfaces both a mention row and an activity row for one side-thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const readModel = yield* InboxReadModelService;

      yield* seed.sideThread(sql, { id: "st-a", parentThreadId: "thread-1" });
      // u-me + u-alice both posted → both are participants of st-a.
      yield* seed.participant(sql, {
        sideThreadId: "st-a",
        userId: ME,
        at: "2026-05-02T10:00:00.000Z",
      });
      yield* seed.participant(sql, {
        sideThreadId: "st-a",
        userId: "u-alice",
        at: "2026-05-02T10:05:00.000Z",
      });
      yield* seed.message(sql, {
        id: "m1",
        sideThreadId: "st-a",
        authorId: ME,
        authorName: "Me",
        text: "kickoff",
        at: "2026-05-02T10:00:00.000Z",
      });
      yield* seed.message(sql, {
        id: "m2",
        sideThreadId: "st-a",
        authorId: "u-alice",
        authorName: "Alice",
        text: "reply from alice",
        at: "2026-05-02T10:05:00.000Z",
      });
      // A mention of me by a third user, in the same side-thread.
      yield* seed.mention(sql, {
        messageId: "mm",
        userId: ME,
        sideThreadId: "st-a",
        parentThreadId: "thread-1",
        authorId: "u-bob",
        authorName: "Bob",
        preview: "hey @me look",
        at: "2026-05-02T10:09:00.000Z",
      });

      const items = yield* readModel.listForUser(UserId.make(ME));
      assert.equal(items.length, 2);

      const mention = items.find((i) => i.kind === "mention");
      const activity = items.find((i) => i.kind === "activity");
      assert.ok(mention, "expected a mention row");
      assert.ok(activity, "expected an activity row");
      assert.equal(mention!.sideThreadId, "st-a");
      assert.equal(mention!.lastAuthor.displayName, "Bob");
      assert.equal(activity!.sideThreadId, "st-a");
      assert.equal(activity!.lastAuthor.displayName, "Alice");
      assert.equal(activity!.lastPreview, "reply from alice");
      // other_count = messages by non-me = 1 (only m2).
      assert.equal(activity!.count, 1);
    }),
  );

  it.effect("excludes self-only threads and counts only messages from others", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const readModel = yield* InboxReadModelService;

      // st-solo: only I posted → no activity row, no mention → absent entirely.
      yield* seed.sideThread(sql, { id: "st-solo", parentThreadId: "thread-2" });
      yield* seed.participant(sql, {
        sideThreadId: "st-solo",
        userId: ME,
        at: "2026-05-03T10:00:00.000Z",
      });
      yield* seed.message(sql, {
        id: "s1",
        sideThreadId: "st-solo",
        authorId: ME,
        authorName: "Me",
        text: "talking to myself",
        at: "2026-05-03T10:00:00.000Z",
      });

      const items = yield* readModel.listForUser(UserId.make(ME));
      assert.equal(
        items.some((i) => i.sideThreadId === "st-solo"),
        false,
      );
    }),
  );

  it.effect("excludes archived side-threads from activity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const readModel = yield* InboxReadModelService;

      yield* seed.sideThread(sql, {
        id: "st-archived",
        parentThreadId: "thread-3",
        archivedAt: "2026-05-04T12:00:00.000Z",
      });
      yield* seed.participant(sql, {
        sideThreadId: "st-archived",
        userId: ME,
        at: "2026-05-04T10:00:00.000Z",
      });
      yield* seed.message(sql, {
        id: "a1",
        sideThreadId: "st-archived",
        authorId: ME,
        authorName: "Me",
        text: "mine",
        at: "2026-05-04T10:00:00.000Z",
      });
      yield* seed.message(sql, {
        id: "a2",
        sideThreadId: "st-archived",
        authorId: "u-alice",
        authorName: "Alice",
        text: "alice reply on archived",
        at: "2026-05-04T10:05:00.000Z",
      });

      const items = yield* readModel.listForUser(UserId.make(ME));
      assert.equal(
        items.some((i) => i.sideThreadId === "st-archived"),
        false,
      );
    }),
  );

  it.effect("hides mentions soft-dismissed at or after their occurrence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const readModel = yield* InboxReadModelService;

      yield* seed.sideThread(sql, { id: "st-dismissed", parentThreadId: "thread-4" });
      yield* seed.mention(sql, {
        messageId: "dm",
        userId: ME,
        sideThreadId: "st-dismissed",
        parentThreadId: "thread-4",
        authorId: "u-bob",
        authorName: "Bob",
        preview: "old mention",
        at: "2026-05-05T10:00:00.000Z",
      });
      yield* seed.dismissal(sql, {
        userId: ME,
        sideThreadId: "st-dismissed",
        at: "2026-05-05T11:00:00.000Z",
      });

      const items = yield* readModel.listForUser(UserId.make(ME));
      assert.equal(
        items.some((i) => i.sideThreadId === "st-dismissed"),
        false,
      );
    }),
  );
});
