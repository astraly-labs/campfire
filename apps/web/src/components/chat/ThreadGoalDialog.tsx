import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { LoaderIcon, TargetIcon, Trash2Icon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";
import { usePendingGoalsStore } from "../../pendingGoalsStore";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

interface Props {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Existing objective, if a goal is already set. Pre-fills the input. */
  readonly initialObjective: string | undefined;
  readonly onError: (message: string) => void;
  /**
   * `scopedThreadKey(scopeThreadRef(environmentId, threadId))`. Used to key the
   * pending goal store when the thread has no live Codex session to flush
   * against yet — e.g. a freshly created draft thread.
   */
  readonly scopedThreadKey: string;
  /**
   * True when the thread has a live Codex session that can accept the
   * `thread/goal/set` RPC right now. When false (draft thread, never-started
   * server thread, etc.) the dialog persists the objective to the pending
   * store; ChatView's session-watcher flushes it once the session is up.
   */
  readonly hasActiveCodexSession: boolean;
}

// Dialog mounted by ChatComposer when the user picks `/goal` from the slash
// palette. Mirrors ThreadGoalBar.handleEdit but uses an in-app Dialog instead
// of the native `window.prompt`, and adds a Clear action for the
// `codexClearThreadGoal` RPC.
export function ThreadGoalDialog({
  open,
  onOpenChange,
  environmentId,
  threadId,
  initialObjective,
  onError,
  scopedThreadKey,
  hasActiveCodexSession,
}: Props) {
  const [draft, setDraft] = useState(initialObjective ?? "");
  const [pending, setPending] = useState<null | "save" | "clear">(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const formId = useId();
  const hasExistingGoal = (initialObjective ?? "").trim().length > 0;
  const setPendingGoal = usePendingGoalsStore((state) => state.setPendingGoal);
  const clearPendingGoal = usePendingGoalsStore((state) => state.clearPendingGoal);

  useEffect(() => {
    if (!open) return;
    setDraft(initialObjective ?? "");
    setPending(null);
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, initialObjective]);

  const close = () => {
    if (pending) return;
    onOpenChange(false);
  };

  const save = async () => {
    if (pending) return;
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      if (!hasExistingGoal) {
        onOpenChange(false);
        return;
      }
      return clear();
    }
    if (trimmed === (initialObjective ?? "").trim()) {
      onOpenChange(false);
      return;
    }
    if (!hasActiveCodexSession) {
      // No Codex session to push to yet — buffer the objective locally.
      // ChatView's session watcher will flush this via codexSetThreadGoal
      // once a session is up (typically right after the first turn starts).
      setPendingGoal(scopedThreadKey, trimmed);
      onOpenChange(false);
      return;
    }
    setPending("save");
    try {
      const api = ensureEnvironmentApi(environmentId);
      await api.orchestration.codexSetThreadGoal({ threadId, objective: trimmed });
      onOpenChange(false);
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      onError(`Codex /goal failed: ${message}`);
    } finally {
      setPending(null);
    }
  };

  const clear = async () => {
    if (pending) return;
    if (!hasActiveCodexSession) {
      // Mirror the save() short-circuit: with no session, the only thing to
      // clear is the local pending entry.
      clearPendingGoal(scopedThreadKey);
      onOpenChange(false);
      return;
    }
    setPending("clear");
    try {
      const api = ensureEnvironmentApi(environmentId);
      await api.orchestration.codexClearThreadGoal({ threadId });
      // If the user had a pending entry and a server goal at the same time
      // (shouldn't really happen, but be defensive) — clearing on the server
      // also drops the local pending state.
      clearPendingGoal(scopedThreadKey);
      onOpenChange(false);
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      onError(`Codex /goal clear failed: ${message}`);
    } finally {
      setPending(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TargetIcon className="size-4 text-emerald-500" aria-hidden />
            {hasExistingGoal ? "Edit thread goal" : "Set thread goal"}
          </DialogTitle>
          <DialogDescription>
            Describe what success looks like for this thread. Codex uses the goal
            to focus its work and track time spent.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          <form
            id={formId}
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="e.g. ship Codex skills wiring tonight"
              disabled={pending !== null}
              aria-label="Thread goal objective"
            />
            <p className="text-[11px] text-muted-foreground">
              Press Enter to save · Empty {hasExistingGoal ? "clears" : "cancels"}
            </p>
            {!hasActiveCodexSession ? (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                No Codex session yet — the goal will be applied to Codex when
                you send your first message.
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          {hasExistingGoal ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mr-auto text-muted-foreground hover:text-destructive"
              disabled={pending !== null}
              onClick={() => void clear()}
            >
              {pending === "clear" ? (
                <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Trash2Icon className="size-3.5" aria-hidden />
              )}
              Clear goal
            </Button>
          ) : null}
          <Button type="button" variant="outline" disabled={pending !== null} onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={pending !== null}>
            {pending === "save" ? <LoaderIcon className="size-3.5 animate-spin" aria-hidden /> : null}
            {hasExistingGoal ? "Update" : "Set goal"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
