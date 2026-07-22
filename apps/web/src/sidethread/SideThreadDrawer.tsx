import {
  SideThreadMessageId,
  type EnvironmentId,
  type MessageId,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { sideThreadIdForThread } from "@t3tools/shared/sideThread";
import { MessageCircleIcon, SendIcon } from "lucide-react";
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

export function SideThreadDrawer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly thread: OrchestrationThread;
  readonly open: boolean;
  readonly contextMessageId: MessageId | null;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId, thread, open, contextMessageId, onClose } = props;
  const sideThreadId = sideThreadIdForThread(threadId);
  const sideThread = useMemo(
    () => (thread.sideThreads ?? []).find((entry) => entry.id === sideThreadId) ?? null,
    [sideThreadId, thread.sideThreads],
  );
  const contextMessage = useMemo(
    () =>
      contextMessageId === null
        ? null
        : (thread.messages.find((message) => message.id === contextMessageId) ?? null),
    [contextMessageId, thread.messages],
  );
  const create = useAtomCommand(threadEnvironment.createSideThread, {
    reportDefect: false,
    reportFailure: false,
  });
  const post = useAtomCommand(threadEnvironment.postSideThreadMessage, {
    reportDefect: false,
    reportFailure: false,
  });
  const createPending = useRef<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open || sideThread !== null) {
      if (sideThread !== null) setError(null);
      return;
    }
    if (createPending.current === sideThreadId) return;
    createPending.current = sideThreadId;
    void create({
      environmentId,
      input: {
        threadId,
        sideThreadId,
        ...(contextMessageId !== null ? { anchorMessageId: contextMessageId } : {}),
      },
    }).then((result) => {
      createPending.current = null;
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
  }, [contextMessageId, create, environmentId, open, sideThread, sideThreadId, threadId]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sideThread === null || sending) return;
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

  return (
    <Sheet open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <SheetPopup side="right" className="sm:max-w-[420px]">
        <SheetHeader className="border-b pb-4">
          <div className="flex items-center gap-2 pr-8">
            <MessageCircleIcon className="size-4 text-muted-foreground" />
            <SheetTitle className="text-base">Side thread</SheetTitle>
          </div>
          <SheetDescription className="line-clamp-3">
            {contextMessage?.text || "One shared team discussion for this agent thread"}
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
                <span className="text-[11px] text-muted-foreground">⌘/Ctrl + Enter to send</span>
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
