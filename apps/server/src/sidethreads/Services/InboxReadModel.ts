/**
 * InboxReadModelService — renders per-user inbox snapshots by unioning two
 * projection tables: `projection_side_thread_message_mentions` (mention rows)
 * and `projection_side_thread_participants` + `projection_side_thread_messages`
 * (activity rows for threads the user has posted in).
 *
 * The aggregate-per-side-thread shape (`InboxItem`) is computed at read time
 * rather than materialised: SQLite handles the window functions in
 * milliseconds for the expected volumes (handful of side-threads per user).
 *
 * @module InboxReadModelService
 */
import type { InboxItem, UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface InboxReadModelShape {
  /**
   * Return the inbox for a user: mention rows first, then activity rows. Each
   * side-thread appears at most once per `kind`, collapsed to `count` plus the
   * latest mention's / message's metadata. The client splits by `kind` and
   * sorts each section by `lastActivityAt`.
   */
  readonly listForUser: (
    userId: UserId,
  ) => Effect.Effect<ReadonlyArray<InboxItem>, ProjectionRepositoryError>;
}

export class InboxReadModelService extends Context.Service<
  InboxReadModelService,
  InboxReadModelShape
>()("t3/sidethreads/Services/InboxReadModel/InboxReadModelService") {}
