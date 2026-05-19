import {
  CommandId,
  type EnvironmentId,
  type SideThread,
  type SideThreadId,
  type SideThreadMessageId,
  type SideThreadStreamItem,
  type UserRef,
} from "@t3tools/contracts";
import { CornerUpLeftIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ensureEnvironmentApi } from "../environmentApi";
import { Button } from "../components/ui/button";
import { InlineSlideDrawer } from "../components/ui/inline-slide-drawer";
import { cn } from "~/lib/utils";
import {
  useCurrentUser,
  useEnsureIdentityLoaded,
  useIdentityStore,
} from "../identity/identityStore";
import {
  applyMentionSelection,
  findActiveMentionToken,
  mentionHandleForUser,
  renderTextWithMentions,
  type ActiveMentionToken,
} from "../inbox/mentionAutocomplete";
import {
  filterUsersForMention,
  useEnsureUserDirectoryLoaded,
  useUserDirectoryStore,
} from "../inbox/userDirectoryStore";
import { useUiStateStore } from "../uiStateStore";
import { clearTyping, notifyTyping } from "../presence/usePresenceHeartbeat";
import { deriveSideThreadId, useSideThreadStore, type SideThreadAnchor } from "./sideThreadStore";

interface Props {
  readonly environmentId: EnvironmentId;
  readonly mode?: "sidebar" | "sheet";
}

const SIDEBAR_WIDTH = 380;

// Scroll the main timeline to the anchor message and briefly flash a ring
// around it. We rely on `data-message-id` set by MessagesTimeline rows. The
// timeline is virtualized (LegendList), so if the anchor isn't in the DOM
// the lookup silently no-ops — acceptable for now since the anchor is
// typically near the open side thread.
function scrollToCheckpoint(messageId: string) {
  const el = document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("ring-2", "ring-amber-500/50", "rounded-md");
  window.setTimeout(() => {
    el.classList.remove("ring-2", "ring-amber-500/50", "rounded-md");
  }, 1400);
}

/**
 * Side-thread inline panel. Mounted as a flex sibling of the chat column so it
 * pushes — not overlays — the main content. Mirrors `PlanSidebar` styling.
 */
export function SideThreadDrawer({ environmentId, mode = "sidebar" }: Props) {
  const anchor = useSideThreadStore((state) => state.anchor);
  const close = useSideThreadStore((state) => state.close);

  if (mode === "sheet") {
    if (!anchor) return null;
    return <DrawerBody environmentId={environmentId} anchor={anchor} onClose={close} mode={mode} />;
  }

  return (
    <InlineSlideDrawer open={anchor !== null} width={SIDEBAR_WIDTH}>
      {anchor ? (
        <DrawerBody environmentId={environmentId} anchor={anchor} onClose={close} mode={mode} />
      ) : null}
    </InlineSlideDrawer>
  );
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
  const [pendingMentions, setPendingMentions] = useState<ReadonlyArray<UserRef>>([]);
  const [activeMention, setActiveMention] = useState<ActiveMentionToken | null>(null);
  const [mentionHighlight, setMentionHighlight] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const api = ensureEnvironmentApi(environmentId);
  useEnsureIdentityLoaded(api);
  useEnsureUserDirectoryLoaded(api);
  const currentUser = useCurrentUser();
  const identityError = useIdentityStore((store) =>
    store.state.kind === "error" ? store.state.message : null,
  );
  const allUsers = useUserDirectoryStore((store) => store.users);
  const listRef = useRef<HTMLUListElement>(null);

  // The list of mention candidates to show in the popover. We exclude the
  // current user — mentioning yourself is noisy and not what people expect
  // from a Slack-style `@`.
  const mentionCandidates = useMemo(() => {
    if (!activeMention) return [];
    const eligible = allUsers.filter((u) => u.id !== currentUser?.id);
    return filterUsersForMention(eligible, activeMention.query);
  }, [activeMention, allUsers, currentUser]);

  useEffect(() => {
    setMentionHighlight(0);
  }, [activeMention?.query, mentionCandidates.length]);

  // Mark the side-thread "visited" the moment the drawer opens so the
  // anchor-button unread dot disappears. We also re-mark on every new
  // message-posted event below — without that the badge would flicker back
  // on every fresh mention while the drawer is open.
  const markVisited = useUiStateStore((state) => state.markThreadVisited);
  useEffect(() => {
    markVisited(sideThreadId);
  }, [sideThreadId, markVisited]);

  useEffect(() => {
    if (!currentUser) return;

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    // Await the create dispatch before opening the subscription. The two
    // calls take different server paths — dispatchCommand goes through a
    // serialized command queue, subscribe reads the in-memory read model
    // synchronously. If subscribe wins the race, the server can't find the
    // aggregate yet and the stream dies with a fatal error (no retry), so
    // subsequent message events never reach the client until a refresh.
    void (async () => {
      try {
        await api.sideThread.dispatchCommand({
          type: "sidethread.create",
          commandId: CommandId.make(`st-create:${sideThreadId}:${Date.now()}`),
          sideThreadId,
          parentThreadId: anchor.parentThreadId,
          anchor: { kind: "message", messageId: anchor.anchorMessageId },
          createdBy: currentUser,
        });
      } catch {
        // Already exists (re-opening) → ignore. Other failures will surface
        // via subscribe below.
      }

      if (cancelled) return;

      unsubscribe = api.sideThread.subscribe({ sideThreadId }, (item: SideThreadStreamItem) => {
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
                        mentions: posted.mentions ?? [],
                      },
                    ],
                  }
                : current,
            );
            // Re-mark visited so the anchor badge doesn't pop back on every new
            // mention while the drawer is open.
            markVisited(sideThreadId, event.occurredAt);
          }
        }
      });
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, currentUser, sideThreadId, anchor.parentThreadId, anchor.anchorMessageId, markVisited]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [sideThread?.messages.length]);

  // One-shot draft prefill — set by the "Cite excerpt" affordance via
  // `open(anchor, { draftPrefill })`. Replace the draft when empty, otherwise
  // prepend so we never silently destroy an in-progress message.
  const pendingDraftPrefill = useSideThreadStore((state) => state.pendingDraftPrefill);
  const consumeDraftPrefill = useSideThreadStore((state) => state.consumeDraftPrefill);
  useEffect(() => {
    if (pendingDraftPrefill === null) return;
    setDraft((current) =>
      current.trim().length === 0 ? pendingDraftPrefill : `${pendingDraftPrefill}${current}`,
    );
    consumeDraftPrefill();
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  }, [pendingDraftPrefill, consumeDraftPrefill]);

  // Recompute the active mention token whenever the draft or caret moves.
  // Also prune `pendingMentions` whose handle no longer appears in the
  // text — if the user deletes the `@matthias` token we shouldn't still
  // ship the mention to the server.
  const refreshMentionContext = useCallback((text: string, caret: number) => {
    setActiveMention(findActiveMentionToken(text, caret));
    setPendingMentions((current) =>
      current.filter((mention) => text.includes(`@${mentionHandleForUser(mention)}`)),
    );
  }, []);

  const handleDraftChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    setDraft(next);
    refreshMentionContext(next, event.target.selectionStart ?? next.length);
    if (next.length > 0) {
      notifyTyping("side");
    } else {
      clearTyping("side");
    }
  };

  const selectMentionCandidate = useCallback(
    (user: UserRef) => {
      if (!activeMention) return;
      const { nextText, nextCaret } = applyMentionSelection(draft, activeMention, user);
      setDraft(nextText);
      setPendingMentions((current) =>
        current.some((m) => m.id === user.id) ? current : [...current, user],
      );
      setActiveMention(null);
      // Defer caret/focus update until React flushes the controlled value.
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [activeMention, draft],
  );

  const send = async () => {
    if (!currentUser) return;
    const text = draft.trim();
    if (!text) return;

    // Only keep mentions whose handle still appears in the trimmed text —
    // mirror the same prune we do during typing so a stale entry doesn't
    // hit the server.
    const mentions = pendingMentions.filter((mention) =>
      text.includes(`@${mentionHandleForUser(mention)}`),
    );

    setDraft("");
    setPendingMentions([]);
    setActiveMention(null);
    clearTyping("side");
    try {
      await api.sideThread.dispatchCommand({
        type: "sidethread.message.post",
        commandId: CommandId.make(`st-post:${sideThreadId}:${Date.now()}`),
        sideThreadId,
        messageId: `${sideThreadId}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}` as SideThreadMessageId,
        author: currentUser,
        text,
        mentions,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to send");
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While the autocomplete popover is open, arrow keys navigate it and
    // Enter accepts the highlighted entry. Escape dismisses it without
    // mutating the draft.
    if (activeMention && mentionCandidates.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionHighlight((h) => (h + 1) % mentionCandidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionHighlight((h) => (h - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        const choice = mentionCandidates[mentionHighlight];
        if (choice) selectMentionCandidate(choice);
        return;
      }
      if (event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        const choice = mentionCandidates[mentionHighlight];
        if (choice) selectMentionCandidate(choice);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setActiveMention(null);
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar"
          ? "h-full w-[380px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
      role="complementary"
      aria-label="Side thread"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => scrollToCheckpoint(anchor.anchorMessageId)}
          title="Go to thread checkpoint"
          aria-label="Go to thread checkpoint"
          className="text-muted-foreground/60 hover:text-foreground"
        >
          <CornerUpLeftIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label="Close side thread"
          className="text-muted-foreground/60 hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>

      <ul ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3 text-sm">
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
            <p className="whitespace-pre-wrap text-foreground/80">
              {renderTextWithMentions(message.text, message.mentions).map((segment, index) =>
                segment.kind === "text" ? (
                  <span key={index}>{segment.text}</span>
                ) : (
                  <span
                    key={index}
                    className={cn(
                      "rounded px-1 font-medium",
                      segment.user.id === currentUser?.id
                        ? "bg-amber-500/30 text-amber-700 dark:text-amber-300"
                        : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                    )}
                  >
                    @{segment.handle}
                  </span>
                ),
              )}
            </p>
          </li>
        ))}
        {sideThread && sideThread.messages.length === 0 ? (
          <li className="text-xs text-muted-foreground/50">Start the discussion…</li>
        ) : null}
      </ul>

      {(identityError ?? error) ? (
        <div className="border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {identityError ?? error}
        </div>
      ) : null}

      <form
        className="relative flex flex-col gap-2 border-t border-border/60 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {activeMention && mentionCandidates.length > 0 ? (
          <ul
            role="listbox"
            aria-label="Mention a teammate"
            className="absolute bottom-[calc(100%-0.25rem)] left-3 right-3 z-10 max-h-48 overflow-y-auto rounded-md border border-border/70 bg-popover shadow-lg"
          >
            {mentionCandidates.map((user, index) => (
              <li
                key={user.id}
                role="option"
                aria-selected={index === mentionHighlight}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectMentionCandidate(user);
                }}
                onMouseEnter={() => setMentionHighlight(index)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm",
                  index === mentionHighlight
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50",
                )}
              >
                <span className="font-medium">{user.displayName}</span>
                <span className="text-[10px] text-muted-foreground/60">
                  @{mentionHandleForUser(user)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={handleDraftChange}
          onSelect={(event) => {
            const el = event.currentTarget;
            refreshMentionContext(el.value, el.selectionStart ?? el.value.length);
          }}
          placeholder="Write a message…"
          rows={2}
          className="resize-none rounded border border-border/60 bg-background px-2 py-1.5 text-sm placeholder:text-muted-foreground/40 focus:border-border focus:outline-none"
          onKeyDown={onKeyDown}
        />
        <div className="flex justify-end">
          <Button type="submit" size="xs" disabled={!draft.trim() || !currentUser}>
            Send (⌘↩)
          </Button>
        </div>
      </form>
    </div>
  );
}
