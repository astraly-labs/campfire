import type {
  EnvironmentId,
  OrchestrationGenerateConversationSummaryResult,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronRightIcon, LoaderIcon, RefreshCcwIcon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";
import { cn } from "~/lib/utils";

interface Props {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /**
   * The thread's current `latestTurn.turnId`. When this changes we re-fetch
   * the summary (with the cache key on the server bound to turnId, the call
   * is a no-op if nothing has actually shifted).
   */
  readonly latestTurnId: string | null;
}

type SummaryState =
  | { kind: "idle" }
  | { kind: "loading"; previous?: OrchestrationGenerateConversationSummaryResult }
  | { kind: "ready"; result: OrchestrationGenerateConversationSummaryResult }
  | { kind: "error"; message: string };

/**
 * Discreet "Summary" toggle that sits above the composer. Behaves like the
 * Claude Code recap pill: collapsed by default, click to expand and read the
 * 2-3 sentence recap of the conversation so far.
 *
 * Generation flow:
 *   - On mount and on each `latestTurnId` change, attempt a fetch with
 *     `force=false`. The server returns cached when available, runs the
 *     model otherwise.
 *   - The "Regenerate" button re-issues with `force=true`.
 *   - We never auto-generate from empty state: if there is no summary yet,
 *     the toggle stays collapsed and shows "Generate" — explicit consent
 *     before we burn a model call on threads no teammate cares about.
 *
 * The summary is shown to every viewer of the thread (it's server-cached,
 * not per-user) which is intentional — the "Take a look" ping pre-warms it
 * so the teammate sees it instantly, and any later viewer reuses the same
 * entry.
 */
export function ThreadSummaryBar({ environmentId, threadId, latestTurnId }: Props) {
  const api = ensureEnvironmentApi(environmentId);
  const [state, setState] = useState<SummaryState>({ kind: "idle" });
  const [expanded, setExpanded] = useState(false);

  // Per-thread guard so a slow in-flight request doesn't clobber the result
  // for a newer turn. We compare against `inflightTurnRef.current` when the
  // response lands and drop it if a fresher request has already started.
  const inflightTurnRef = useRef<string | null | undefined>(undefined);

  const fetchSummary = useCallback(
    async (force: boolean) => {
      const requestedTurnId = latestTurnId;
      inflightTurnRef.current = requestedTurnId;
      setState((prev) =>
        prev.kind === "ready" ? { kind: "loading", previous: prev.result } : { kind: "loading" },
      );
      try {
        const result = await api.orchestration.generateConversationSummary({
          threadId,
          force,
        });
        // Drop late responses if a newer turn has already kicked off a fetch.
        if (inflightTurnRef.current !== requestedTurnId) return;
        setState({ kind: "ready", result });
      } catch (cause) {
        if (inflightTurnRef.current !== requestedTurnId) return;
        const message = cause instanceof Error ? cause.message : "Could not generate summary";
        setState({ kind: "error", message });
      }
    },
    [api, threadId, latestTurnId],
  );

  // When the latest completed turn moves, refresh — but only if we already
  // have a summary on screen. Threads no teammate has asked about don't pay
  // the regeneration cost.
  const lastSeenTurnRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const previous = lastSeenTurnRef.current;
    lastSeenTurnRef.current = latestTurnId;
    if (previous === undefined) return; // first render — wait for explicit open
    if (previous === latestTurnId) return;
    if (state.kind === "ready" || state.kind === "loading") {
      void fetchSummary(false);
    }
  }, [latestTurnId, fetchSummary, state.kind]);

  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    // First open with nothing cached → kick off a generation.
    if (next && state.kind === "idle") {
      void fetchSummary(false);
    }
  };

  const handleRegenerate = () => {
    void fetchSummary(true);
  };

  const summaryText =
    state.kind === "ready"
      ? state.result.summary
      : state.kind === "loading"
        ? state.previous?.summary
        : undefined;

  return (
    <div className="mx-auto mb-1 max-w-208 px-1">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={expanded}
        aria-controls={`thread-summary-${threadId}`}
        className={cn(
          "group/summary flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors",
          "text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground",
        )}
      >
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 transition-transform duration-150",
            expanded ? "rotate-90" : "rotate-0",
          )}
          aria-hidden
        />
        <SparklesIcon className="size-3 shrink-0 opacity-60" aria-hidden />
        <span className="font-medium">Summary</span>
        {state.kind === "loading" ? (
          <LoaderIcon className="size-3 shrink-0 animate-spin opacity-60" aria-hidden />
        ) : null}
        {state.kind === "error" ? <span className="text-destructive/80">unavailable</span> : null}
      </button>

      {expanded ? (
        <div
          id={`thread-summary-${threadId}`}
          className={cn(
            "mt-1 rounded-md border border-border/40 bg-muted/20 px-2.5 py-2 text-xs",
            "text-foreground/85",
          )}
        >
          {summaryText ? (
            <p className="leading-relaxed whitespace-pre-wrap">{summaryText}</p>
          ) : state.kind === "loading" ? (
            <p className="text-muted-foreground/70 italic">Generating…</p>
          ) : state.kind === "error" ? (
            <p className="text-destructive/80">{state.message}</p>
          ) : (
            <p className="text-muted-foreground/60 italic">
              No summary yet. Click below to generate.
            </p>
          )}

          <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground/50">
            <span className="truncate">
              {state.kind === "ready"
                ? `via ${state.result.generatedByModel}${state.result.fromCache ? " (cached)" : ""}`
                : ""}
            </span>
            <button
              type="button"
              onClick={handleRegenerate}
              disabled={state.kind === "loading"}
              className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
                "hover:bg-muted/60 hover:text-foreground disabled:opacity-40",
              )}
              aria-label="Regenerate summary"
            >
              <RefreshCcwIcon className="size-3" aria-hidden />
              <span>
                {state.kind === "ready" || state.kind === "loading" ? "Regenerate" : "Generate"}
              </span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
