import {
  MessageId,
  SideThreadId,
  SideThreadMessageId,
  type EnvironmentId,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ArchiveIcon, CornerUpLeftIcon, SendIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "../components/ui/button";
import { notifyPresenceTyping } from "../presence/presence";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";

export function sideThreadIdForMessage(messageId: MessageId): SideThreadId {
  return SideThreadId.make(`message:${messageId}`);
}

export function SideThreadDrawer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly thread: OrchestrationThread;
  readonly anchorMessageId: MessageId | null;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId, thread, anchorMessageId, onClose } = props;
  const sideThreadId = anchorMessageId ? sideThreadIdForMessage(anchorMessageId) : null;
  const sideThread = useMemo(
    () =>
      sideThreadId === null
        ? null
        : ((thread.sideThreads ?? []).find((entry) => entry.id === sideThreadId) ?? null),
    [sideThreadId, thread.sideThreads],
  );
  const anchor = useMemo(
    () =>
      anchorMessageId === null
        ? null
        : (thread.messages.find((message) => message.id === anchorMessageId) ?? null),
    [anchorMessageId, thread.messages],
  );
  const create = useAtomCommand(threadEnvironment.createSideThread, {
    reportDefect: false,
    reportFailure: false,
  });
  const post = useAtomCommand(threadEnvironment.postSideThreadMessage, {
    reportDefect: false,
    reportFailure: false,
  });
  const archive = useAtomCommand(threadEnvironment.archiveSideThread, {
    reportDefect: false,
    reportFailure: false,
  });
  const createPending = useRef<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (anchorMessageId === null || sideThreadId === null || sideThread !== null) {
      if (sideThread !== null) setError(null);
      return;
    }
    if (createPending.current === sideThreadId) return;
    createPending.current = sideThreadId;
    void create({
      environmentId,
      input: { threadId, sideThreadId, anchorMessageId },
    }).then((result) => {
      createPending.current = null;
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
  }, [anchorMessageId, create, environmentId, sideThread, sideThreadId, threadId]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sideThreadId === null || sideThread === null || sending) return;
    setSending(true);
    setError(null);
    const result = await post({
      environmentId,
      input: {
        threadId,
        sideThreadId,
        messageId: SideThreadMessageId.make(randomUUID()),
        text,
      },
    });
    setSending(false);
    if (result._tag === "Success") {
      setDraft("");
      return;
    }
    const cause = squashAtomCommandFailure(result);
    setError(cause instanceof Error ? cause.message : String(cause));
  };

  const archiveCurrent = async () => {
    if (sideThreadId === null || sideThread === null) return;
    const result = await archive({ environmentId, input: { threadId, sideThreadId } });
    if (result._tag === "Success") {
      onClose();
      return;
    }
    const cause = squashAtomCommandFailure(result);
    setError(cause instanceof Error ? cause.message : String(cause));
  };

  return (
    <Sheet open={anchorMessageId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetPopup side="right" className="sm:max-w-[420px]">
        <SheetHeader className="border-b pb-4">
          <div className="flex items-center gap-2 pr-8">
            <CornerUpLeftIcon className="size-4 text-muted-foreground" />
            <SheetTitle className="text-base">Team discussion</SheetTitle>
          </div>
          <SheetDescription className="line-clamp-3">
            {anchor?.text || "Discussion attached to this message"}
          </SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex min-h-0 flex-1 flex-col gap-4 py-4">
          <div className="flex min-h-32 flex-1 flex-col gap-3">
            {sideThread === null ? (
              <p className="text-sm text-muted-foreground">Opening discussion…</p>
            ) : sideThread.messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No team messages yet.</p>
            ) : (
              sideThread.messages.map((message) => (
                <div key={message.id} className="rounded-xl border bg-muted/35 p-3">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{message.author.displayName}</span>
                    <time className="text-[10px] text-muted-foreground">
                      {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                  <p className="whitespace-pre-wrap text-sm">{message.text}</p>
                </div>
              ))
            )}
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          {sideThread?.archivedAt ? (
            <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
              This discussion is archived.
            </p>
          ) : (
            <div className="space-y-2 border-t pt-4">
              <textarea
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  notifyPresenceTyping(environmentId, threadId);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void send();
                  }
                }}
                maxLength={20_000}
                rows={4}
                placeholder="Write to the team…"
                className="w-full resize-none rounded-xl border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="flex items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={sideThread === null}
                  onClick={() => void archiveCurrent()}
                >
                  <ArchiveIcon className="size-3.5" />
                  Archive
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={sideThread === null || sending || draft.trim().length === 0}
                  onClick={() => void send()}
                >
                  <SendIcon className="size-3.5" />
                  Send
                </Button>
              </div>
            </div>
          )}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
