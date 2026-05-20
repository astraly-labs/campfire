import type { EnvironmentId, OrchestrationThreadGoal, ThreadId } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  CircleSlashIcon,
  LoaderIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  TargetIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useState } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";
import { cn } from "~/lib/utils";

interface Props {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly goal: OrchestrationThreadGoal;
}

// Mirrors Codex's goal bar (see the Codex desktop app). Source of truth for
// the goal is Codex itself, pushed via the thread/goal/updated notification
// channel and projected onto thread.goal by the server. This component just
// renders it and exposes pause / resume / edit / clear actions that round-trip
// through Codex's thread/goal/{set,clear} RPCs.
//
// Renders nothing unless a goal is set. Only mounted for Codex-backed threads
// (gated by the parent in ChatView).
export function ThreadGoalBar({ environmentId, threadId, goal }: Props) {
  const api = ensureEnvironmentApi(environmentId);
  const [pending, setPending] = useState<null | "toggle" | "clear" | "edit">(null);
  const [error, setError] = useState<string | null>(null);

  const isActive = goal.status === "active";
  const isPaused = goal.status === "paused";
  const isTerminal =
    goal.status === "complete" ||
    goal.status === "blocked" ||
    goal.status === "usageLimited" ||
    goal.status === "budgetLimited";

  const handleToggle = useCallback(async () => {
    if (pending || isTerminal) return;
    setPending("toggle");
    setError(null);
    try {
      await api.orchestration.codexSetThreadGoal({
        threadId,
        status: isActive ? "paused" : "active",
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not toggle goal");
    } finally {
      setPending(null);
    }
  }, [api, threadId, isActive, isTerminal, pending]);

  const handleClear = useCallback(async () => {
    if (pending) return;
    setPending("clear");
    setError(null);
    try {
      await api.orchestration.codexClearThreadGoal({ threadId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not clear goal");
    } finally {
      setPending(null);
    }
  }, [api, threadId, pending]);

  const handleEdit = useCallback(async () => {
    if (pending) return;
    const next = window.prompt("Edit goal objective", goal.objective);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === goal.objective) return;
    setPending("edit");
    setError(null);
    try {
      await api.orchestration.codexSetThreadGoal({ threadId, objective: trimmed });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update goal");
    } finally {
      setPending(null);
    }
  }, [api, threadId, goal.objective, pending]);

  const statusLabel = statusToLabel(goal.status);
  const StatusIcon = statusToIcon(goal.status);

  return (
    <div className="mx-auto mb-1 max-w-208 px-1">
      <div
        className={cn(
          "flex w-full items-center gap-2 rounded-md border border-border/40 bg-muted/30 px-2.5 py-1.5 text-xs",
          isTerminal ? "opacity-80" : "",
        )}
      >
        <StatusIcon
          className={cn(
            "size-3.5 shrink-0",
            isPaused ? "text-amber-500" : isActive ? "text-emerald-500" : "text-muted-foreground",
          )}
          aria-hidden
        />
        <span className="shrink-0 font-medium text-foreground/90">{statusLabel}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={goal.objective}>
          {goal.objective}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground/70">
          {formatElapsed(goal.timeUsedSeconds)}
        </span>

        <div className="flex shrink-0 items-center gap-0.5 text-muted-foreground/80">
          <button
            type="button"
            onClick={handleEdit}
            disabled={pending !== null}
            className={iconButtonClass}
            aria-label="Edit goal objective"
            title="Edit objective"
          >
            <PencilIcon className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={handleToggle}
            disabled={pending !== null || isTerminal}
            className={iconButtonClass}
            aria-label={isActive ? "Pause goal" : "Resume goal"}
            title={isActive ? "Pause goal" : isPaused ? "Resume goal" : "Goal is in a terminal state"}
          >
            {pending === "toggle" ? (
              <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
            ) : isActive ? (
              <PauseIcon className="size-3.5" aria-hidden />
            ) : (
              <PlayIcon className="size-3.5" aria-hidden />
            )}
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={pending !== null}
            className={iconButtonClass}
            aria-label="Clear goal"
            title="Clear goal"
          >
            {pending === "clear" ? (
              <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Trash2Icon className="size-3.5" aria-hidden />
            )}
          </button>
        </div>
      </div>
      {error ? (
        <p className="mt-0.5 px-2 text-[10px] text-destructive/80" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const iconButtonClass = cn(
  "inline-flex size-6 items-center justify-center rounded transition-colors",
  "hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
);

function statusToLabel(status: OrchestrationThreadGoal["status"]): string {
  switch (status) {
    case "active":
      return "Active goal";
    case "paused":
      return "Paused";
    case "blocked":
      return "Blocked";
    case "usageLimited":
      return "Usage limit";
    case "budgetLimited":
      return "Budget limit";
    case "complete":
      return "Complete";
  }
}

function statusToIcon(status: OrchestrationThreadGoal["status"]) {
  switch (status) {
    case "active":
    case "paused":
      return TargetIcon;
    case "complete":
      return CheckCircle2Icon;
    case "blocked":
    case "usageLimited":
    case "budgetLimited":
      return CircleSlashIcon;
  }
}

function formatElapsed(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
