import type { EnvironmentId, MessageId, ThreadId, UserRef } from "@t3tools/contracts";
import { CheckIcon, EyeIcon } from "lucide-react";
import { useState } from "react";

import { ensureEnvironmentApi } from "../environmentApi";
import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useCurrentUser, useEnsureIdentityLoaded } from "../identity/identityStore";
import { useEnsureUserDirectoryLoaded, useUserDirectoryStore } from "../inbox/userDirectoryStore";
import { mentionHandleForUser } from "../inbox/mentionAutocomplete";
import { cn } from "~/lib/utils";
import { takeALook } from "./takeALookActions";
import {
  pingedToastTitle,
  selectTakeALookCandidates,
  selectedTargetsInOrder,
  sendButtonLabel,
  toggleSelection,
} from "./TakeALookButton.logic";

interface Props {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly environmentId: EnvironmentId;
}

/**
 * "Please take a look" — one-shot ping to selected teammates. Sits next to
 * the {@link SideThreadAnchorButton} on each assistant message; opening the
 * popover reuses the existing user directory (no new server roundtrip) and
 * sending posts a single mention-rich message in the anchored side-thread.
 */
export function TakeALookButton({ threadId, messageId, environmentId }: Props) {
  const api = ensureEnvironmentApi(environmentId);
  useEnsureIdentityLoaded(api);
  useEnsureUserDirectoryLoaded(api);
  const currentUser = useCurrentUser();
  const allUsers = useUserDirectoryStore((store) => store.users);

  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<UserRef["id"]>>(new Set());
  const [sending, setSending] = useState(false);

  const candidates = selectTakeALookCandidates(allUsers, currentUser?.id ?? null);
  const targets = selectedTargetsInOrder(candidates, selectedIds);
  const canSend = !sending && currentUser !== null && targets.length > 0;

  const resetSelection = () => setSelectedIds(new Set());

  const handleSend = async () => {
    if (!canSend || !currentUser) return;
    setSending(true);
    try {
      await takeALook({
        api,
        currentUser,
        targets,
        parentThreadId: threadId,
        quotedMessageId: messageId,
      });
      toastManager.add({
        type: "success",
        title: pingedToastTitle(targets),
      });
      resetSelection();
      setOpen(false);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not send ping",
          description: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) resetSelection();
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={currentUser === null}
            title="Ping a teammate"
            aria-label="Ping a teammate to take a look"
            className={cn(
              "inline-flex items-center rounded p-1 text-[10px] transition-opacity duration-200",
              "text-muted-foreground/45 hover:bg-muted hover:text-foreground",
              "opacity-0 group-hover/assistant:opacity-100 focus-visible:opacity-100",
              open && "opacity-100",
            )}
          />
        }
      >
        <EyeIcon className="size-3.5" aria-hidden />
      </PopoverTrigger>
      <PopoverPopup align="start" side="bottom" className="w-64">
        <div className="flex flex-col gap-1">
          <p className="px-1 text-[11px] font-medium text-muted-foreground">Take a look…</p>
          {candidates.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground/70">No teammates yet.</p>
          ) : (
            <ul
              role="listbox"
              aria-multiselectable="true"
              className="-mx-1 max-h-64 overflow-y-auto"
            >
              {candidates.map((user) => {
                const checked = selectedIds.has(user.id);
                return (
                  <li key={user.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={checked}
                      onClick={() => setSelectedIds((s) => toggleSelection(s, user.id))}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                        "hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none",
                        checked && "bg-accent/40",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-flex size-4 shrink-0 items-center justify-center rounded border",
                          checked
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border/70 bg-background",
                        )}
                        aria-hidden
                      >
                        {checked ? <CheckIcon className="size-3" /> : null}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{user.displayName}</span>
                        <span className="truncate text-[10px] text-muted-foreground/70">
                          @{mentionHandleForUser(user)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {candidates.length > 0 && (
            <div className="mt-1 flex justify-end border-t border-border/40 pt-2">
              <Button type="button" size="xs" disabled={!canSend} onClick={() => void handleSend()}>
                {sendButtonLabel(targets.length)}
              </Button>
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
