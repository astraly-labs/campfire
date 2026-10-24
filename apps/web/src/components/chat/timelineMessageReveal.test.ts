import { MessageId, RunId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { locateTimelineMessage, useTimelineMessageRevealStore } from "./timelineMessageReveal";

const quoted = MessageId.make("quoted");
const run = RunId.make("run-1");
const messageRow = (id: string) => ({ kind: "message", message: { id } });
const messageEntry = (id: string, runId: RunId | null = run) => ({
  kind: "message",
  message: { id, runId },
});
const locate = (input: {
  rows?: ReadonlyArray<{ kind: string; message?: { id: string } }>;
  entries?: ReadonlyArray<{ kind: string; message?: { id: string; runId: RunId | null } }>;
  expandedRunIds?: ReadonlySet<RunId>;
  canLoadEarlier?: boolean;
}) =>
  locateTimelineMessage({
    messageId: quoted,
    rows: input.rows ?? [],
    entries: input.entries ?? [],
    expandedRunIds: input.expandedRunIds ?? new Set(),
    canLoadEarlier: input.canLoadEarlier ?? false,
  });

describe("locateTimelineMessage", () => {
  it("scrolls to the message row, not to other rows that carry the same message", () => {
    expect(
      locate({
        rows: [
          messageRow("other"),
          { kind: "assistant-meta", message: { id: "quoted" } },
          messageRow("quoted"),
        ],
        entries: [messageEntry("quoted")],
      }),
    ).toEqual({ kind: "scroll", index: 2 });
  });

  it("unfolds the turn when the message is loaded but folded away", () => {
    expect(locate({ rows: [messageRow("other")], entries: [messageEntry("quoted")] })).toEqual({
      kind: "expand",
      runId: run,
    });
  });

  it("gives up instead of unfolding the same turn again", () => {
    expect(locate({ entries: [messageEntry("quoted")], expandedRunIds: new Set([run]) })).toEqual({
      kind: "missing",
    });
    expect(locate({ entries: [messageEntry("quoted", null)] })).toEqual({ kind: "missing" });
  });

  it("pages in older history while the message is not loaded", () => {
    expect(locate({ entries: [messageEntry("other")], canLoadEarlier: true })).toEqual({
      kind: "load-earlier",
    });
  });

  it("reports the message missing once history is exhausted", () => {
    expect(locate({ entries: [messageEntry("other")], canLoadEarlier: false })).toEqual({
      kind: "missing",
    });
  });
});

describe("useTimelineMessageRevealStore", () => {
  afterEach(() => {
    vi.useRealTimers();
    useTimelineMessageRevealStore.setState({ pending: null, highlighted: null });
  });

  it("highlights a found message briefly, then clears the highlight", () => {
    vi.useFakeTimers();
    const store = useTimelineMessageRevealStore;
    store.getState().reveal("env:thread", quoted);
    const pending = store.getState().pending!;
    store.getState().settle(pending, true);
    expect(store.getState()).toMatchObject({ pending: null, highlighted: pending });
    vi.advanceTimersByTime(1_999);
    expect(store.getState().highlighted).toEqual(pending);
    vi.advanceTimersByTime(1);
    expect(store.getState().highlighted).toBeNull();
  });

  it("does not highlight a message it could not find", () => {
    const store = useTimelineMessageRevealStore;
    store.getState().reveal("env:thread", quoted);
    store.getState().settle(store.getState().pending!, false);
    expect(store.getState()).toMatchObject({ pending: null, highlighted: null });
  });

  it("keeps a newer reveal pending when an older one settles", () => {
    const store = useTimelineMessageRevealStore;
    store.getState().reveal("env:thread", quoted);
    const older = store.getState().pending!;
    store.getState().reveal("env:thread", MessageId.make("newer"));
    store.getState().settle(older, true);
    expect(store.getState().pending?.messageId).toBe("newer");
    expect(store.getState().highlighted).toBeNull();
  });
});
