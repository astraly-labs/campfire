/**
 * Composition of the SideThread aggregate runtime. Mirrors the orchestration
 * runtimeLayer but stays isolated — no cross-dependency with `OrchestrationLayerLive`
 * so upstream rebases of `pingdotgg/t3code` do not touch this graph.
 */
import * as Layer from "effect/Layer";

import { SideThreadEventStoreLive } from "../persistence/Layers/SideThreadEventStore.ts";
import { InboxReadModelLive } from "./Layers/InboxReadModel.ts";
import { SideThreadEngineLive } from "./Layers/SideThreadEngine.ts";
import { SideThreadProjectionPipelineLive } from "./Layers/SideThreadProjectionPipeline.ts";
import { UserDirectoryLive } from "./Layers/UserDirectory.ts";
import { UserIdentityLive } from "./Layers/UserIdentity.ts";

const SideThreadProjectionPipelineLayerLive = SideThreadProjectionPipelineLive.pipe(
  Layer.provide(SideThreadEventStoreLive),
);

const SideThreadInfrastructureLayerLive = Layer.mergeAll(
  SideThreadEventStoreLive,
  SideThreadProjectionPipelineLayerLive,
  UserIdentityLive,
  UserDirectoryLive,
  InboxReadModelLive,
);

export const SideThreadLayerLive = Layer.mergeAll(
  SideThreadInfrastructureLayerLive,
  SideThreadEngineLive.pipe(Layer.provide(SideThreadInfrastructureLayerLive)),
);
