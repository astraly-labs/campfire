/**
 * SideThread event normalizer — bridge between the legacy "one side-thread
 * per anchored agent message" event history and the current "one
 * side-thread per parent thread" model.
 *
 * Historical events on disk carry the original `sideThreadId`
 * (`st-{parent}-{message}`) and a payload with `anchor`. The new schema
 * strips `anchor` and keys side threads as `st-{parent}`. This normalizer
 * is fed every event during boostrap/replay and:
 *
 *   1. Rewrites `aggregateId` and `payload.sideThreadId` to the canonical
 *      `st-{parent}` form.
 *   2. Returns `null` for redundant historical `sidethread.created` events
 *      (one per anchored message) once the canonical aggregate has been
 *      materialised — so the projection only sees a single creation per
 *      parent.
 *
 * Live events flowing through the engine *after* migration are already
 * created with canonical ids by the decider, so passing them through the
 * normalizer is a no-op.
 *
 * @module sidethreads/normalize
 */
import type {
  SideThreadEvent,
  SideThreadId,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Stable canonical id for the (single) side thread attached to a parent.
 * Shared with the client; both sides compute it identically so the WS
 * `subscribe`/`create` round-trips don't need a server-side discovery
 * step.
 */
export const canonicalSideThreadIdFor = (parentThreadId: ThreadId): SideThreadId =>
  (`st-${parentThreadId}` as unknown) as SideThreadId;

export class SideThreadEventNormalizer {
  private readonly idMap = new Map<string, SideThreadId>();
  private readonly materialised = new Set<SideThreadId>();

  /**
   * Returns the rewritten event, or `null` when the event should be
   * dropped (only happens for redundant historical `sidethread.created`).
   */
  normalize(event: SideThreadEvent): SideThreadEvent | null {
    switch (event.type) {
      case "sidethread.created": {
        // Global chat events have `parentThreadId === null`. They predate
        // no legacy "one per anchored message" layout, so their canonical id
        // is just the id they were created with — no remapping needed.
        const canonical =
          event.payload.parentThreadId === null
            ? event.payload.sideThreadId
            : canonicalSideThreadIdFor(event.payload.parentThreadId);
        this.idMap.set(event.payload.sideThreadId, canonical);
        if (this.materialised.has(canonical)) return null;
        this.materialised.add(canonical);
        if (canonical === event.payload.sideThreadId) return event;
        return {
          ...event,
          aggregateId: canonical,
          payload: {
            ...event.payload,
            sideThreadId: canonical,
          },
        };
      }
      case "sidethread.message-posted": {
        const canonical = this.idMap.get(event.payload.sideThreadId);
        if (!canonical || canonical === event.payload.sideThreadId) return event;
        return {
          ...event,
          aggregateId: canonical,
          payload: {
            ...event.payload,
            sideThreadId: canonical,
          },
        };
      }
      case "sidethread.message-reacted": {
        // Reactions are post-canonicalisation only (introduced after the
        // one-per-parent migration), but pass through the same id-map
        // rewrite for symmetry. No historical events to drop.
        const canonical = this.idMap.get(event.payload.sideThreadId);
        if (!canonical || canonical === event.payload.sideThreadId) return event;
        return {
          ...event,
          aggregateId: canonical,
          payload: {
            ...event.payload,
            sideThreadId: canonical,
          },
        };
      }
      case "sidethread.archived": {
        const canonical = this.idMap.get(event.payload.sideThreadId);
        if (!canonical || canonical === event.payload.sideThreadId) return event;
        return {
          ...event,
          aggregateId: canonical,
          payload: {
            ...event.payload,
            sideThreadId: canonical,
          },
        };
      }
      case "sidethread.inbox-dismissed": {
        const canonical = this.idMap.get(event.payload.sideThreadId);
        if (!canonical || canonical === event.payload.sideThreadId) return event;
        return {
          ...event,
          aggregateId: canonical,
          payload: {
            ...event.payload,
            sideThreadId: canonical,
          },
        };
      }
      case "sidethread.marked-read": {
        // Read markers are a post-canonicalisation feature; pass through
        // the id-map rewrite for symmetry with reactions.
        const canonical = this.idMap.get(event.payload.sideThreadId);
        if (!canonical || canonical === event.payload.sideThreadId) return event;
        return {
          ...event,
          aggregateId: canonical,
          payload: {
            ...event.payload,
            sideThreadId: canonical,
          },
        };
      }
      case "sidethread.message-edited": {
        const canonical = this.idMap.get(event.payload.sideThreadId);
        if (!canonical || canonical === event.payload.sideThreadId) return event;
        return {
          ...event,
          aggregateId: canonical,
          payload: {
            ...event.payload,
            sideThreadId: canonical,
          },
        };
      }
    }
  }
}
