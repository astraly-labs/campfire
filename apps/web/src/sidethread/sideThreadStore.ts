import type { MessageId, SideThreadId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Where the side-thread drawer is currently open. We only model a single
 * side-thread per parent agent thread, so the drawer state is just the
 * parent thread we're viewing alongside the chat — the canonical
 * `sideThreadId` is derived from it.
 */
interface SideThreadStore {
  readonly openParentThreadId: ThreadId | null;
  readonly open: (
    parentThreadId: ThreadId,
    options?: { draftPrefill?: string; quotedMessageId?: MessageId | null },
  ) => void;
  readonly close: () => void;

  /**
   * One-shot draft seed consumed by the drawer the next time it mounts on
   * the current parent. Used by the "quote excerpt" and "take a look"
   * affordances to drop a `> ...` blockquote (and a quotedMessageId) into
   * the composer without coupling the store to the drawer's local state.
   * Cleared by `consumeDraftPrefill` so a subsequent open of the same
   * parent doesn't replay the citation.
   */
  readonly pendingDraftPrefill: string | null;
  readonly pendingQuotedMessageId: MessageId | null;
  readonly consumeDraftPrefill: () => {
    text: string | null;
    quotedMessageId: MessageId | null;
  };
}

export const useSideThreadStore = create<SideThreadStore>((set, get) => ({
  openParentThreadId: null,
  open: (parentThreadId, options) =>
    set({
      openParentThreadId: parentThreadId,
      pendingDraftPrefill: options?.draftPrefill ?? null,
      pendingQuotedMessageId: options?.quotedMessageId ?? null,
    }),
  close: () =>
    set({
      openParentThreadId: null,
      pendingDraftPrefill: null,
      pendingQuotedMessageId: null,
    }),

  pendingDraftPrefill: null,
  pendingQuotedMessageId: null,
  consumeDraftPrefill: () => {
    const { pendingDraftPrefill, pendingQuotedMessageId } = get();
    if (pendingDraftPrefill !== null || pendingQuotedMessageId !== null) {
      set({ pendingDraftPrefill: null, pendingQuotedMessageId: null });
    }
    return { text: pendingDraftPrefill, quotedMessageId: pendingQuotedMessageId };
  },
}));

/**
 * Stable prefix on every derived side-thread id. Other stores (notably
 * `uiStateStore`) rely on this to distinguish side-thread keys from regular
 * agent-thread keys when pruning/persisting per-thread UI state.
 */
export const SIDE_THREAD_KEY_PREFIX = "st-";

/**
 * Deterministic side-thread id derived from the parent agent thread. v0
 * enforces a single side-thread per parent thread so both ends compute the
 * same id and converge on the same aggregate without server-side discovery.
 */
export function deriveSideThreadId(parentThreadId: ThreadId): SideThreadId {
  return (`${SIDE_THREAD_KEY_PREFIX}${parentThreadId}` as unknown) as SideThreadId;
}

/**
 * True for any string id produced by {@link deriveSideThreadId}. Useful to
 * decide whether a `threadLastVisitedAtById` entry belongs to the regular
 * thread namespace (re-seeded from snapshot) or the side-thread namespace
 * (owned by the side-thread drawer + inbox, persisted locally).
 */
export function isSideThreadKey(threadId: string): boolean {
  return threadId.startsWith(SIDE_THREAD_KEY_PREFIX);
}
