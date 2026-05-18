/**
 * SideThreadEngineService - Service interface for SideThread command handling.
 *
 * Owns command validation/dispatch and in-memory read-model updates backed by
 * `SideThreadEventStore` persistence. It does not own transport concerns
 * (e.g. websocket request parsing) — those live in ws.ts handlers.
 *
 * @module SideThreadEngineService
 */
import type {
  SideThreadCommand,
  SideThreadDetailSnapshot,
  SideThreadEvent,
  SideThreadId,
  SideThreadParentIndexSnapshot,
  SideThreadSummary,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Stream from "effect/Stream";

import type { SideThreadEventStoreError } from "../../persistence/Errors.ts";
import type { SideThreadDispatchError } from "../Errors.ts";

export interface SideThreadEngineShape {
  readonly readEvents: (
    fromSequenceExclusive: number,
  ) => Stream.Stream<SideThreadEvent, SideThreadEventStoreError, never>;

  readonly dispatch: (
    command: SideThreadCommand,
  ) => Effect.Effect<{ sequence: number }, SideThreadDispatchError, never>;

  readonly streamDomainEvents: Stream.Stream<SideThreadEvent>;

  /**
   * Read the in-memory snapshot for a side thread. Returns `Option.none`
   * when the id is unknown. Used by WS subscribe handlers to ship the
   * initial snapshot before the live event stream.
   */
  readonly getSnapshot: (
    sideThreadId: SideThreadId,
  ) => Effect.Effect<Option.Option<SideThreadDetailSnapshot>>;

  /**
   * Snapshot of every side thread anchored on the given parent thread.
   * Returned as lightweight summaries so the parent UI can decorate its
   * messages without loading every full thread up-front.
   */
  readonly getParentSnapshot: (
    parentThreadId: ThreadId,
  ) => Effect.Effect<SideThreadParentIndexSnapshot>;

  /**
   * Derive a summary for the side thread the given event belongs to. Returns
   * `Option.none` when the aggregate is no longer in the in-memory read
   * model (should not happen in practice, since the projector applies the
   * event before publishing).
   */
  readonly summarizeForEvent: (event: SideThreadEvent) => Option.Option<SideThreadSummary>;
}

export class SideThreadEngineService extends Context.Service<
  SideThreadEngineService,
  SideThreadEngineShape
>()("t3/sidethreads/Services/SideThreadEngine/SideThreadEngineService") {}
