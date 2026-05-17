/**
 * SideThreadEventStore - Event store interface for SideThread events.
 *
 * Owns durable append/replay access to the side_thread_events stream.
 * It does not reduce events into read models or apply command validation rules.
 *
 * @module SideThreadEventStore
 */
import type { SideThreadEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { SideThreadEventStoreError } from "../Errors.ts";

export interface SideThreadEventStoreShape {
  readonly append: (
    event: Omit<SideThreadEvent, "sequence">,
    actorUserId: string,
  ) => Effect.Effect<SideThreadEvent, SideThreadEventStoreError>;

  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<SideThreadEvent, SideThreadEventStoreError>;

  readonly readAll: () => Stream.Stream<SideThreadEvent, SideThreadEventStoreError>;
}

export class SideThreadEventStore extends Context.Service<
  SideThreadEventStore,
  SideThreadEventStoreShape
>()("t3/persistence/Services/SideThreadEventStore") {}
