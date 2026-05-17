/**
 * SideThreadProjectionPipeline - Event projection pipeline service interface.
 *
 * Coordinates projection bootstrap/replay and per-event projection updates for
 * SideThread read models (projection_side_threads + projection_side_thread_messages).
 *
 * @module SideThreadProjectionPipeline
 */
import type { SideThreadEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface SideThreadProjectionPipelineShape {
  readonly bootstrap: Effect.Effect<void, ProjectionRepositoryError>;

  readonly projectEvent: (event: SideThreadEvent) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class SideThreadProjectionPipeline extends Context.Service<
  SideThreadProjectionPipeline,
  SideThreadProjectionPipelineShape
>()("t3/sidethreads/Services/ProjectionPipeline/SideThreadProjectionPipeline") {}
