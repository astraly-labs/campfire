import type { IsoDateTime, SideThread, SideThreadId } from "@t3tools/contracts";

/**
 * In-memory state used by the SideThread decider/projector to validate
 * commands and reduce events. This is server-internal and never crosses
 * the wire — the wire format is `SideThreadDetailSnapshot` from contracts.
 */
export interface SideThreadReadModel {
  readonly snapshotSequence: number;
  readonly updatedAt: IsoDateTime;
  readonly sideThreads: ReadonlyMap<SideThreadId, SideThread>;
}

export const createEmptySideThreadReadModel = (now: IsoDateTime): SideThreadReadModel => ({
  snapshotSequence: 0,
  updatedAt: now,
  sideThreads: new Map(),
});
