import { SideThreadId, type ThreadId } from "@t3tools/contracts";

const THREAD_SIDE_THREAD_PREFIX = "thread:";

/** One deterministic human discussion channel for every agent thread. */
export function sideThreadIdForThread(threadId: ThreadId): SideThreadId {
  return SideThreadId.make(`${THREAD_SIDE_THREAD_PREFIX}${threadId}`);
}

export function isSideThreadIdForThread(sideThreadId: SideThreadId, threadId: ThreadId): boolean {
  return sideThreadId === sideThreadIdForThread(threadId);
}
