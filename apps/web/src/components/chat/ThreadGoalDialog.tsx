import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { LoaderIcon, TargetIcon, Trash2Icon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";
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
}: Props) {
  const [draft, setDraft] = useState(initialObjective ?? "");
  const [pending, setPending] = useState<null | "save" | "clear">(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const formId = useId();
  const hasExistingGoal = (initialObjective ?? "").trim().length > 0;

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
    setPending("clear");
    try {
      const api = ensureEnvironmentApi(environmentId);
      await api.orchestration.codexClearThreadGoal({ threadId });
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
