import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

import { ensureEnvironmentApi } from "../environmentApi";
import { useSideThreadStore } from "./sideThreadStore";

/**
 * Mountable side-effect: subscribes the active conversation to the
 * server's parent side-thread index and mirrors it into
 * `useSideThreadStore`. Renders nothing — pair with `SideThreadDrawer`
 * inside the ChatView so anchor buttons can pick the right affordance
 * without each one issuing its own RPC.
 */
export function ParentSideThreadSubscription({
  environmentId,
  parentThreadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly parentThreadId: ThreadId;
}): null {
  useParentSideThreadSubscription(environmentId, parentThreadId);
  return null;
}

export function useParentSideThreadSubscription(
  environmentId: EnvironmentId,
  parentThreadId: ThreadId,
): void {
  const resetParentIndex = useSideThreadStore((state) => state.resetParentIndex);
  const upsertParentSummary = useSideThreadStore((state) => state.upsertParentSummary);
  const clearParentIndex = useSideThreadStore((state) => state.clearParentIndex);

  useEffect(() => {
    const api = ensureEnvironmentApi(environmentId);
    let cancelled = false;

    const unsubscribe = api.sideThread.subscribeParent({ parentThreadId }, (item) => {
      if (cancelled) return;
      if (item.kind === "snapshot") {
        resetParentIndex(parentThreadId, item.snapshot.entries);
      } else {
        upsertParentSummary(item.summary);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
      clearParentIndex();
    };
  }, [environmentId, parentThreadId, resetParentIndex, upsertParentSummary, clearParentIndex]);
}
