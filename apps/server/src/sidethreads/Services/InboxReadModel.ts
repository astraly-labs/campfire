/**
 * InboxReadModelService — queries the `projection_side_thread_message_mentions`
 * table to render per-user inbox snapshots.
 *
 * The aggregate-per-side-thread shape (`InboxItem`) is computed at read time
 * rather than materialised: SQLite handles the GROUP BY in milliseconds for
 * the expected volumes (handful of side-threads per user, dozens of mentions).
 *
 * @module InboxReadModelService
 */
import type { InboxItem, UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface InboxReadModelShape {
  /**
   * Return the inbox for a user, sorted most-recent-first. Items are
   * collapsed so the same side-thread appears once with `mentionsCount` and
   * the latest mention's metadata.
   */
  readonly listForUser: (
    userId: UserId,
  ) => Effect.Effect<ReadonlyArray<InboxItem>, ProjectionRepositoryError>;
}

export class InboxReadModelService extends Context.Service<
  InboxReadModelService,
  InboxReadModelShape
>()("t3/sidethreads/Services/InboxReadModel/InboxReadModelService") {}
