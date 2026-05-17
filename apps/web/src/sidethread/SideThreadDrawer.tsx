import {
  CommandId,
  type EnvironmentId,
  type SideThread,
  type SideThreadId,
  type SideThreadMessageId,
  type SideThreadStreamItem,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ensureEnvironmentApi } from "../environmentApi";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "~/lib/utils";
import { getOrPromptUserRef } from "./identity";
import { deriveSideThreadId, useSideThreadStore, type SideThreadAnchor } from "./sideThreadStore";

interface Props {
  readonly environmentId: EnvironmentId;
  readonly mode?: "sidebar" | "sheet";
}

/**
 * Side-thread inline panel. Mounted as a flex sibling of the chat column so it
 * pushes — not overlays — the main content. Mirrors `PlanSidebar` styling.
 *
 * v0: open from an agent-message anchor, post + see live updates. No mentions,
 * no status bar, no typing indicators.
 */
export function SideThreadDrawer({ environmentId, mode = "sidebar" }: Props) {
  const anchor = useSideThreadStore((state) => state.anchor);
  const close = useSideThreadStore((state) => state.close);
  if (!anchor) return null;
  return <DrawerBody environmentId={environmentId} anchor={anchor} onClose={close} mode={mode} />;
}

function DrawerBody({
  environmentId,
  anchor,
  onClose,
  mode,
}: {
  environmentId: EnvironmentId;
  anchor: SideThreadAnchor;
  onClose: () => void;
  mode: "sidebar" | "sheet";
}) {
  const sideThreadId = deriveSideThreadId(anchor) as SideThreadId;
  const [sideThread, setSideThread] = useState<SideThread | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const userRefRef = useRef(getOrPromptUserRef());
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const api = ensureEnvironmentApi(environmentId);
    const userRef = userRefRef.current;
    if (!userRef) {
      setError("Identité requise (recharge la page et donne un nom).");
      return;
    }

    let cancelled = false;

    void api.sideThread
      .dispatchCommand({
        type: "sidethread.create",
        commandId: CommandId.make(`st-create:${sideThreadId}:${Date.now()}`),
        sideThreadId,
        parentThreadId: anchor.parentThreadId,
        anchor: { kind: "message", messageId: anchor.anchorMessageId },
        createdBy: userRef,
      })
      .catch(() => {
        // Already exists → ignore. Other failures will surface via subscribe.
      });

    const unsubscribe = api.sideThread.subscribe({ sideThreadId }, (item: SideThreadStreamItem) => {
      if (cancelled) return;
      if (item.kind === "snapshot") {
        setSideThread(item.snapshot.sideThread);
      } else {
        const event = item.event;
        if (event.type === "sidethread.created") {
          const created = event.payload;
          setSideThread({
            id: created.sideThreadId,
            parentThreadId: created.parentThreadId,
            anchor: created.anchor,
            createdBy: created.createdBy,
            createdAt: event.occurredAt,
            updatedAt: event.occurredAt,
            archivedAt: null,
            messages: [],
          });
        } else if (event.type === "sidethread.message-posted") {
          const posted = event.payload;
          setSideThread((current) =>
            current
              ? {
                  ...current,
                  updatedAt: event.occurredAt,
                  messages: [
                    ...current.messages,
                    {
                      id: posted.messageId,
                      author: posted.author,
                      text: posted.text,
                      createdAt: event.occurredAt,
                      updatedAt: event.occurredAt,
                    },
                  ],
                }
              : current,
          );
        }
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [environmentId, sideThreadId, anchor.parentThreadId, anchor.anchorMessageId]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [sideThread?.messages.length]);

  const send = async () => {
    const userRef = userRefRef.current;
    if (!userRef) return;
    const text = draft.trim();
    if (!text) return;

    setDraft("");
    try {
      const api = ensureEnvironmentApi(environmentId);
      await api.sideThread.dispatchCommand({
        type: "sidethread.message.post",
        commandId: CommandId.make(`st-post:${sideThreadId}:${Date.now()}`),
        sideThreadId,
        messageId: `${sideThreadId}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}` as SideThreadMessageId,
        author: userRef,
        text,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Échec d'envoi");
    }
  };

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar" ? "h-full w-[380px] shrink-0 border-l border-border/70" : "h-full w-full",
      )}
      role="complementary"
      aria-label="Side thread"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant="secondary"
            className="rounded-md bg-amber-500/10 px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide text-amber-500"
          >
            Side thread
          </Badge>
          <span
            className="truncate text-[11px] text-muted-foreground/60"
            title={anchor.anchorMessageId}
          >
            ancré sur message {anchor.anchorMessageId.slice(0, 8)}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label="Fermer le side thread"
          className="text-muted-foreground/60 hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>

      <ul
        ref={listRef}
        className="flex-1 space-y-3 overflow-y-auto px-3 py-3 text-sm"
      >
        {(sideThread?.messages ?? []).map((message) => (
          <li key={message.id} className="space-y-0.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-medium text-foreground/90">
                {message.author.displayName}
              </span>
              <span className="text-[10px] text-muted-foreground/50">
                {new Date(message.createdAt).toLocaleTimeString()}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-foreground/80">{message.text}</p>
          </li>
        ))}
        {sideThread && sideThread.messages.length === 0 ? (
          <li className="text-xs text-muted-foreground/50">Commence la discussion…</li>
        ) : null}
      </ul>

      {error ? (
        <div className="border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <form
        className="flex flex-col gap-2 border-t border-border/60 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Écrire un message…"
          rows={2}
          className="resize-none rounded border border-border/60 bg-background px-2 py-1.5 text-sm placeholder:text-muted-foreground/40 focus:border-border focus:outline-none"
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex justify-end">
          <Button type="submit" size="xs" disabled={!draft.trim()}>
            Envoyer (⌘↩)
          </Button>
        </div>
      </form>
    </div>
  );
}
