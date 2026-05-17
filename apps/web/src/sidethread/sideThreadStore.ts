import type { MessageId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

export interface SideThreadAnchor {
  readonly parentThreadId: ThreadId;
  readonly anchorMessageId: MessageId;
}

interface SideThreadStore {
  readonly anchor: SideThreadAnchor | null;
  readonly open: (anchor: SideThreadAnchor) => void;
  readonly close: () => void;
}

export const useSideThreadStore = create<SideThreadStore>((set) => ({
  anchor: null,
  open: (anchor) => set({ anchor }),
  close: () => set({ anchor: null }),
}));

/**
 * Deterministic side-thread id derived from the anchor. v0 enforces a single
 * side-thread per (parentThread, message) so both ends compute the same id
 * and converge on the same aggregate without server-side discovery.
 */
export function deriveSideThreadId(anchor: SideThreadAnchor): string {
  return `st-${anchor.parentThreadId}-${anchor.anchorMessageId}`;
}
