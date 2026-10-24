import type { LegendListRef } from "@legendapp/list/react";
import type { MessageId, RunId } from "@t3tools/contracts";
import { useEffect, useRef, type RefObject } from "react";
import { create } from "zustand";

import { toastManager } from "../ui/toast";

const REVEAL_HIGHLIGHT_MS = 2_000;
const REVEAL_MAX_HISTORY_PAGES = 20;
// Matches the minimap jump: the message top lands just below the timeline's top edge.
const REVEAL_VIEW_OFFSET = 24;

interface RevealTarget {
  readonly threadKey: string;
  readonly messageId: MessageId;
  /** Tells repeated reveals of the same message apart. */
  readonly id: number;
}

interface TimelineMessageRevealState {
  /** A reveal the timeline has not positioned yet. */
  readonly pending: RevealTarget | null;
  /** The message showing the static reveal highlight. */
  readonly highlighted: RevealTarget | null;
  readonly reveal: (threadKey: string, messageId: MessageId) => void;
  readonly settle: (target: RevealTarget, found: boolean) => void;
}

let nextRevealId = 0;

/** Asks a thread's timeline to scroll to one message and highlight it briefly. */
export const useTimelineMessageRevealStore = create<TimelineMessageRevealState>((set) => ({
  pending: null,
  highlighted: null,
  reveal: (threadKey, messageId) => {
    nextRevealId += 1;
    set({ pending: { threadKey, messageId, id: nextRevealId } });
  },
  settle: (target, found) => {
    set((state) =>
      state.pending?.id === target.id
        ? { pending: null, highlighted: found ? target : state.highlighted }
        : state,
    );
    if (!found) return;
    setTimeout(
      () => set((state) => (state.highlighted?.id === target.id ? { highlighted: null } : state)),
      REVEAL_HIGHLIGHT_MS,
    );
  },
}));

interface RevealRow {
  readonly kind: string;
  readonly message?: { readonly id: string };
}

interface RevealEntry {
  readonly kind: string;
  readonly message?: { readonly id: string; readonly runId: RunId | null };
}

export type TimelineRevealStep =
  | { readonly kind: "scroll"; readonly index: number }
  | { readonly kind: "expand"; readonly runId: RunId }
  | { readonly kind: "load-earlier" }
  | { readonly kind: "missing" };

/**
 * What the timeline must do next to show a message: scroll to its row, unfold
 * the turn that hides it, page in older history, or give up.
 */
export function locateTimelineMessage(input: {
  readonly messageId: MessageId;
  readonly rows: ReadonlyArray<RevealRow>;
  readonly entries: ReadonlyArray<RevealEntry>;
  readonly expandedRunIds: ReadonlySet<RunId>;
  readonly canLoadEarlier: boolean;
}): TimelineRevealStep {
  const index = input.rows.findIndex(
    (row) => row.kind === "message" && row.message?.id === input.messageId,
  );
  if (index >= 0) return { kind: "scroll", index };
  const entry = input.entries.find(
    (candidate) => candidate.kind === "message" && candidate.message?.id === input.messageId,
  );
  if (entry) {
    const runId = entry.message?.runId ?? null;
    return runId !== null && !input.expandedRunIds.has(runId)
      ? { kind: "expand", runId }
      : { kind: "missing" };
  }
  return input.canLoadEarlier ? { kind: "load-earlier" } : { kind: "missing" };
}

/** Positions the timeline on a requested message once it is loaded and unfolded. */
export function useTimelineMessageReveal(input: {
  readonly threadKey: string;
  readonly enabled: boolean;
  readonly listReady: boolean;
  readonly rows: ReadonlyArray<RevealRow>;
  readonly entries: ReadonlyArray<RevealEntry>;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly history:
    | {
        readonly hasMoreHistory: boolean;
        readonly loading: boolean;
        readonly error: string | null;
        readonly onLoadEarlier: () => void;
      }
    | undefined;
  readonly onExpandTurn: (runId: RunId) => void;
  readonly onManualNavigation: () => void;
}): MessageId | null {
  const { threadKey, enabled, listReady, rows, entries, listRef, history } = input;
  const { onExpandTurn, onManualNavigation } = input;
  const pending = useTimelineMessageRevealStore((state) =>
    state.pending?.threadKey === threadKey ? state.pending : null,
  );
  const highlighted = useTimelineMessageRevealStore((state) =>
    state.highlighted?.threadKey === threadKey ? state.highlighted.messageId : null,
  );
  const progressRef = useRef<{
    readonly id: number;
    readonly expandedRunIds: Set<RunId>;
    pages: number;
  } | null>(null);

  useEffect(() => {
    if (pending === null || !enabled || !listReady || history?.loading) return;
    if (progressRef.current?.id !== pending.id) {
      progressRef.current = { id: pending.id, expandedRunIds: new Set(), pages: 0 };
    }
    const progress = progressRef.current;
    const step = locateTimelineMessage({
      messageId: pending.messageId,
      rows,
      entries,
      expandedRunIds: progress.expandedRunIds,
      canLoadEarlier:
        history !== undefined &&
        history.hasMoreHistory &&
        history.error === null &&
        progress.pages < REVEAL_MAX_HISTORY_PAGES,
    });
    const { settle } = useTimelineMessageRevealStore.getState();
    switch (step.kind) {
      case "scroll":
        onManualNavigation();
        void listRef.current?.scrollToIndex({
          index: step.index,
          animated: true,
          viewOffset: REVEAL_VIEW_OFFSET,
        });
        settle(pending, true);
        return;
      case "expand":
        progress.expandedRunIds.add(step.runId);
        onExpandTurn(step.runId);
        return;
      case "load-earlier":
        progress.pages += 1;
        history?.onLoadEarlier();
        return;
      case "missing":
        settle(pending, false);
        toastManager.add({
          type: "warning",
          title: "Could not find the quoted message",
          description: "It may have been removed from this thread.",
        });
        return;
    }
  }, [
    enabled,
    entries,
    history,
    listReady,
    listRef,
    onExpandTurn,
    onManualNavigation,
    pending,
    rows,
  ]);

  return highlighted;
}
