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
}

export class SideThreadEngineService extends Context.Service<
  SideThreadEngineService,
  SideThreadEngineShape
>()("t3/sidethreads/Services/SideThreadEngine/SideThreadEngineService") {}
