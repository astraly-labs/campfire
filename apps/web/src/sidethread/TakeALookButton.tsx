import {
  SideThreadMessageId,
  type EnvironmentId,
  type MessageId,
  type SideThreadAuthor,
  type ThreadId,
} from "@t3tools/contracts";
import { sideThreadIdForThread } from "@t3tools/shared/sideThread";
import { CheckIcon, EyeIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { GoogleTeamMember } from "../collaboration/googleTeam";
import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { cn, randomUUID } from "../lib/utils";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  buildTakeALookText,
  mentionHandleForGoogleUser,
  toggleTakeALookSelection,
} from "./takeALook";

export function TakeALookButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly team: ReadonlyArray<GoogleTeamMember>;
  readonly currentSubject: string | null;
  readonly onOpenSideThread: (messageId: MessageId) => void;
}) {
  const { environmentId, threadId, messageId, team, currentSubject, onOpenSideThread } = props;
  const candidates = useMemo(
    () => team.filter((member) => member.subject !== currentSubject),
    [currentSubject, team],
  );
  const [open, setOpen] = useState(false);
  const [selectedSubjects, setSelectedSubjects] = useState<ReadonlySet<string>>(new Set());
  const [sending, setSending] = useState(false);
  const create = useAtomCommand(threadEnvironment.createSideThread, {
    reportDefect: false,
    reportFailure: false,
  });
  const post = useAtomCommand(threadEnvironment.postSideThreadMessage, {
    reportDefect: false,
    reportFailure: false,
  });
  const targets = candidates.filter((candidate) => selectedSubjects.has(candidate.subject));

  const reset = () => setSelectedSubjects(new Set());
  const send = async () => {
    if (sending || targets.length === 0 || currentSubject === null) return;
    setSending(true);
    const sideThreadId = sideThreadIdForThread(threadId);
    await create({
      environmentId,
      input: { threadId, sideThreadId, anchorMessageId: messageId },
    });
    const mentions: ReadonlyArray<SideThreadAuthor> = targets.map(({ subject, displayName }) => ({
      subject,
      displayName,
    }));
    const result = await post({
      environmentId,
      input: {
        threadId,
        sideThreadId,
        messageId: SideThreadMessageId.make(randomUUID()),
        text: buildTakeALookText(mentions),
        mentions,
        quotedMessageId: messageId,
      },
    });
    setSending(false);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not send ping",
          description: "The side thread did not accept the message. Please retry.",
        }),
      );
      return;
    }
    toastManager.add({
      type: "success",
      title:
        targets.length === 1
          ? `Pinged ${targets[0]!.displayName}`
          : `Pinged ${targets.length} teammates`,
    });
    reset();
    setOpen(false);
    onOpenSideThread(messageId);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={currentSubject === null}
            aria-label="Ping a teammate to take a look"
          />
        }
      >
        <EyeIcon className="size-3" />
        <span>Take a Look</span>
      </PopoverTrigger>
      <PopoverPopup align="start" side="bottom" className="w-64">
        <div className="flex flex-col gap-1">
          <p className="px-1 text-[11px] font-medium text-muted-foreground">Take a look…</p>
          {candidates.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground/70">No Google teammates yet.</p>
          ) : (
            <ul
              role="listbox"
              aria-multiselectable="true"
              className="-mx-1 max-h-64 overflow-y-auto"
            >
              {candidates.map((user) => {
                const checked = selectedSubjects.has(user.subject);
                return (
                  <li key={user.subject}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={checked}
                      onClick={() =>
                        setSelectedSubjects((current) =>
                          toggleTakeALookSelection(current, user.subject),
                        )
                      }
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none",
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
                      >
                        {checked ? <CheckIcon className="size-3" /> : null}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{user.displayName}</span>
                        <span className="truncate text-[10px] text-muted-foreground/70">
                          @{mentionHandleForGoogleUser(user)}
                          {user.connected ? " · online" : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {candidates.length > 0 ? (
            <div className="mt-1 flex justify-end border-t border-border/40 pt-2">
              <Button
                type="button"
                size="xs"
                disabled={sending || targets.length === 0}
                onClick={() => void send()}
              >
                {targets.length > 0 ? `Send (${targets.length})` : "Send"}
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
