/**
 * Named wrapper around `sql.withTransaction` that logs long holds.
 *
 * The sqlite client serializes ALL queries through a single-permit
 * semaphore, and a transaction holds that permit for its entire effect —
 * including any non-SQL work yielded inside it. One transaction that, say,
 * awaits a frozen-filesystem access therefore blocks every other query on
 * the server (observed as 20-45s shell snapshots). This wrapper makes such
 * holders visible by name in the logs instead of leaving the victim queries
 * to take the blame.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/** Holds longer than this get a warning log with the transaction's name. */
export const TRANSACTION_HOLD_WARN_MS = 3_000;

export const withNamedTransaction =
  (sql: SqlClient.SqlClient, name: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError, R> =>
    Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(effect).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const heldMs = (yield* Clock.currentTimeMillis) - startedAtMs;
            if (heldMs >= TRANSACTION_HOLD_WARN_MS) {
              yield* Effect.logWarning(
                "[🐌 SqlTransaction] long transaction hold starved other queries",
                { name, heldMs: Math.round(heldMs) },
              );
            }
          }),
        ),
      );
    });
