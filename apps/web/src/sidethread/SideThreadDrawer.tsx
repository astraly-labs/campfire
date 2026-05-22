import {
  CommandId,
  type EnvironmentId,
  type MessageId,
  type SideThread,
  type SideThreadId,
  type SideThreadMessage,
  type SideThreadMessageId,
  type SideThreadMessageReaction,
  type SideThreadStreamItem,
  type ThreadId,
  type UserRef,
} from "@t3tools/contracts";
import { CornerUpLeftIcon, ImageIcon, XIcon } from "lucide-react";
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
import { colorIndexForUserId, NAME_TEXT_PALETTE } from "../presence/AvatarStack";
import { useViewersOfSideThread } from "../presence/presenceStore";
import { TypingIndicator } from "../presence/TypingIndicator";
import { useUiStateStore } from "../uiStateStore";
import { clearTyping, notifyTyping } from "../presence/usePresenceHeartbeat";
import { GifAttachmentInline } from "./GifAttachmentInline";
import { GifPicker } from "./GifPicker";
import { MessageReactions } from "./MessageReactions";
import { deriveSideThreadId, useSideThreadStore } from "./sideThreadStore";
import { toAttachment, type GiphyGif } from "./giphyClient";

/**
 * Toggle a single user against a reaction bucket on a specific message,
 * mirroring the server-side delta the projector applies. Kept here (and
 * not in a shared util) because the only client-side consumer is the
 * optimistic update path inside the drawer.
 */
function applyReactionToggleLocally(
  messages: ReadonlyArray<SideThreadMessage>,
  messageId: SideThreadMessageId,
  user: UserRef,
  emoji: string,
  action: "added" | "removed",
  occurredAt: string,
): ReadonlyArray<SideThreadMessage> {
  return messages.map((m) => {
    if (m.id !== messageId) return m;
    const bucketIndex = m.reactions.findIndex((r) => r.emoji === emoji);
    const bucket = bucketIndex >= 0 ? m.reactions[bucketIndex]! : undefined;
    if (action === "added") {
      if (bucket?.users.some((u) => u.id === user.id)) return m;
      const nextBucket: SideThreadMessageReaction = bucket
        ? { ...bucket, users: [...bucket.users, user] }
        : { emoji, users: [user] };
      const nextReactions =
        bucketIndex >= 0
          ? m.reactions.map((r, idx) => (idx === bucketIndex ? nextBucket : r))
          : [...m.reactions, nextBucket];
      return { ...m, updatedAt: occurredAt, reactions: nextReactions };
    }
    if (!bucket) return m;
    const nextUsers = bucket.users.filter((u) => u.id !== user.id);
    if (nextUsers.length === bucket.users.length) return m;
    const nextReactions =
      nextUsers.length === 0
        ? m.reactions.filter((_, idx) => idx !== bucketIndex)
        : m.reactions.map((r, idx) =>
            idx === bucketIndex ? { ...r, users: nextUsers } : r,
          );
    return { ...m, updatedAt: occurredAt, reactions: nextReactions };
  });
}

interface Props {
  readonly environmentId: EnvironmentId;
  readonly mode?: "sidebar" | "sheet";
}

const SIDEBAR_WIDTH = 380;

// Scroll the main timeline to a specific agent message and briefly flash a
// ring around it. We rely on `data-message-id` set by MessagesTimeline
// rows. The timeline is virtualized (LegendList), so if the message isn't
// in the DOM the lookup silently no-ops.
function scrollToMessage(messageId: string) {
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
  const openParentThreadId = useSideThreadStore((state) => state.openParentThreadId);
  const close = useSideThreadStore((state) => state.close);

  if (mode === "sheet") {
    if (!openParentThreadId) return null;
    return (
      <DrawerBody
        environmentId={environmentId}
        parentThreadId={openParentThreadId}
        sideThreadId={deriveSideThreadId(openParentThreadId)}
        onClose={close}
        mode={mode}
      />
    );
  }

  return (
    <InlineSlideDrawer open={openParentThreadId !== null} width={SIDEBAR_WIDTH}>
      {openParentThreadId ? (
        <DrawerBody
          environmentId={environmentId}
          parentThreadId={openParentThreadId}
          sideThreadId={deriveSideThreadId(openParentThreadId)}
          onClose={close}
          mode={mode}
        />
      ) : null}
    </InlineSlideDrawer>
  );
}

/**
 * Side-thread chat body — used both by the per-thread drawer above and the
 * standalone Global chat route. When `parentThreadId` is `null` we render in
 * "global" mode: no quote-to-agent affordances, the header switches label,
 * and the lazy `sidethread.create` dispatch ships `parentThreadId: null` so
 * the server materialises the workspace-wide aggregate.
 */
export function DrawerBody({
  environmentId,
  parentThreadId,
  sideThreadId,
  onClose,
  mode,
}: {
  environmentId: EnvironmentId;
  parentThreadId: ThreadId | null;
  sideThreadId: SideThreadId;
  onClose: () => void;
  mode: "sidebar" | "sheet";
}) {
  const [sideThread, setSideThread] = useState<SideThread | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingMentions, setPendingMentions] = useState<ReadonlyArray<UserRef>>([]);
  const [pendingQuotedMessageId, setPendingQuotedMessageId] = useState<MessageId | null>(null);
  const [activeMention, setActiveMention] = useState<ActiveMentionToken | null>(null);
  const [mentionHighlight, setMentionHighlight] = useState(0);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
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
  // header-button unread dot disappears. We also re-mark on every new
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
          parentThreadId,
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
                        quotedMessageId: posted.quotedMessageId ?? null,
                        attachments: posted.attachments ?? [],
                        reactions: [],
                      },
                    ],
                  }
                : current,
            );
            // Re-mark visited so the header badge doesn't pop back on every new
            // mention while the drawer is open.
            markVisited(sideThreadId, event.occurredAt);
          } else if (event.type === "sidethread.message-reacted") {
            const reacted = event.payload;
            setSideThread((current) =>
              current
                ? {
                    ...current,
                    updatedAt: event.occurredAt,
                    messages: applyReactionToggleLocally(
                      current.messages,
                      reacted.messageId,
                      reacted.user,
                      reacted.emoji,
                      reacted.action,
                      event.occurredAt,
                    ),
                  }
                : current,
            );
          }
        }
      });
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, currentUser, sideThreadId, parentThreadId, markVisited]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [sideThread?.messages.length]);

  // One-shot draft prefill — set by the "Cite excerpt" / "Take a look"
  // affordances via `open(parent, { draftPrefill, quotedMessageId })`.
  // Replace the draft when empty, otherwise prepend so we never silently
  // destroy an in-progress message.
  const pendingDraftPrefill = useSideThreadStore((state) => state.pendingDraftPrefill);
  const pendingQuotedFromStore = useSideThreadStore((state) => state.pendingQuotedMessageId);
  const consumeDraftPrefill = useSideThreadStore((state) => state.consumeDraftPrefill);
  useEffect(() => {
    if (pendingDraftPrefill === null && pendingQuotedFromStore === null) return;
    if (pendingDraftPrefill !== null) {
      setDraft((current) =>
        current.trim().length === 0 ? pendingDraftPrefill : `${pendingDraftPrefill}${current}`,
      );
    }
    if (pendingQuotedFromStore !== null) {
      setPendingQuotedMessageId(pendingQuotedFromStore);
    }
    consumeDraftPrefill();
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  }, [pendingDraftPrefill, pendingQuotedFromStore, consumeDraftPrefill]);

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
    const quotedMessageId = pendingQuotedMessageId;

    setDraft("");
    setPendingMentions([]);
    setPendingQuotedMessageId(null);
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
        quotedMessageId,
        attachments: [],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to send");
    }
  };

  // Telegram-style send: clicking a GIF in the picker ships it as a
  // standalone message immediately — no "preview then send" step. The
  // current draft (if any) is preserved so users don't lose in-progress
  // text while reaching for an emoji-class reply.
  const sendGif = useCallback(
    async (gif: GiphyGif) => {
      if (!currentUser) return;
      const attachment = toAttachment(gif);
      if (!attachment) return;
      setGifPickerOpen(false);
      try {
        await api.sideThread.dispatchCommand({
          type: "sidethread.message.post",
          commandId: CommandId.make(`st-post:${sideThreadId}:${Date.now()}`),
          sideThreadId,
          messageId: `${sideThreadId}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}` as SideThreadMessageId,
          author: currentUser,
          text: "",
          mentions: [],
          quotedMessageId: null,
          attachments: [attachment],
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to send GIF");
      }
    },
    [api, currentUser, sideThreadId],
  );

  const toggleReaction = useCallback(
    (messageId: SideThreadMessageId, emoji: string) => {
      if (!currentUser) return;
      // Optimistic update: we don't know yet whether the server will
      // emit `added` or `removed`, so we infer from the current state.
      // The reconciliation event from the stream will overwrite this if
      // it disagrees (e.g. a concurrent peer beat us to it).
      setSideThread((current) => {
        if (!current) return current;
        const message = current.messages.find((m) => m.id === messageId);
        if (!message) return current;
        const bucket = message.reactions.find((r) => r.emoji === emoji);
        const optimisticAction: "added" | "removed" =
          bucket?.users.some((u) => u.id === currentUser.id) ? "removed" : "added";
        return {
          ...current,
          messages: applyReactionToggleLocally(
            current.messages,
            messageId,
            currentUser,
            emoji,
            optimisticAction,
            new Date().toISOString(),
          ),
        };
      });
      void api.sideThread
        .dispatchCommand({
          type: "sidethread.message.react",
          commandId: CommandId.make(`st-react:${sideThreadId}:${messageId}:${Date.now()}`),
          sideThreadId,
          messageId,
          user: currentUser,
          emoji,
        })
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : "Failed to react");
        });
    },
    [api, currentUser, sideThreadId],
  );

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
        <span className="text-[11px] font-medium text-muted-foreground/80">
          {parentThreadId === null ? "Global chat" : "Side thread"}
        </span>
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

      <ul ref={listRef} className="flex-1 overflow-y-auto px-3 py-3 text-sm">
        {(sideThread?.messages ?? []).map((message, index, allMessages) => {
          const authorColor = NAME_TEXT_PALETTE[colorIndexForUserId(message.author.id)]!;
          const previous = index > 0 ? allMessages[index - 1] : undefined;
          // Group consecutive messages from the same author when they're
          // within a short window — keeps the column quieter and matches
          // Slack/iMessage conventions. 5 min is the usual cutoff.
          const sameAuthorAsPrevious =
            previous !== undefined &&
            previous.author.id === message.author.id &&
            new Date(message.createdAt).getTime() -
              new Date(previous.createdAt).getTime() <
              5 * 60 * 1000;
          return (
          <li
            key={message.id}
            className={cn(
              "group/msg space-y-0.5",
              sameAuthorAsPrevious ? "mt-0.5" : "mt-3 first:mt-0",
            )}
          >
            {sameAuthorAsPrevious ? null : (
              <div className="flex items-baseline justify-between gap-2">
                <span className={cn("text-[11px] font-medium", authorColor)}>
                  {message.author.displayName}
                </span>
                <span className="text-[10px] text-muted-foreground/50">
                  {new Date(message.createdAt).toLocaleTimeString()}
                </span>
              </div>
            )}
            {message.quotedMessageId ? (
              <button
                type="button"
                onClick={() => scrollToMessage(message.quotedMessageId!)}
                title="Go to quoted agent message"
                className="inline-flex items-center gap-1 rounded border border-border/50 bg-background/40 px-1.5 py-0.5 text-[10px] text-muted-foreground/70 hover:text-foreground"
              >
                <CornerUpLeftIcon className="size-3" aria-hidden />
                Quote
              </button>
            ) : null}
            {message.attachments.map((attachment, attachmentIndex) =>
              attachment.kind === "gif" ? (
                <GifAttachmentInline key={attachmentIndex} attachment={attachment} />
              ) : null,
            )}
            {message.text.length > 0 ? (
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
            ) : null}
            <MessageReactions
              reactions={message.reactions}
              currentUserId={currentUser?.id}
              onToggle={(emoji) => toggleReaction(message.id, emoji)}
            />
          </li>
          );
        })}
        {sideThread && sideThread.messages.length === 0 ? (
          <li className="text-xs text-muted-foreground/50">Start the discussion…</li>
        ) : null}
      </ul>

      <SideThreadTypingRow sideThreadId={sideThreadId} currentUserId={currentUser?.id} />

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
        {pendingQuotedMessageId ? (
          <div className="flex items-center justify-between rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300">
            <span>Quoting agent message</span>
            <button
              type="button"
              onClick={() => setPendingQuotedMessageId(null)}
              className="relative text-amber-700/80 hover:text-amber-700 dark:text-amber-300/80 dark:hover:text-amber-300 pointer-coarse:after:absolute pointer-coarse:after:inset-0 pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11"
              aria-label="Remove quoted message"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        ) : null}
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
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setGifPickerOpen((open) => !open)}
            aria-label="Insert GIF"
            aria-pressed={gifPickerOpen}
            className={cn(
              "gap-1 px-2 text-muted-foreground/70 hover:text-foreground",
              gifPickerOpen && "text-amber-600 dark:text-amber-400",
            )}
          >
            <ImageIcon className="size-3.5" />
            <span className="text-[11px] font-medium">GIF</span>
          </Button>
          <Button type="submit" size="xs" disabled={!draft.trim() || !currentUser}>
            Send (⌘↩)
          </Button>
        </div>
        <GifPicker
          open={gifPickerOpen}
          onClose={() => setGifPickerOpen(false)}
          onPick={(gif) => void sendGif(gif)}
        />
      </form>
    </div>
  );
}

// `useViewersOfSideThread` already narrows `isTyping` to `typingIn === "side"`,
// so we only have to strip the current user before handing the list off to
// the shared indicator.
function SideThreadTypingRow({
  sideThreadId,
  currentUserId,
}: {
  sideThreadId: ReturnType<typeof deriveSideThreadId>;
  currentUserId: UserRef["id"] | undefined;
}) {
  const viewers = useViewersOfSideThread(sideThreadId);
  const typingUsers = useMemo(
    () =>
      viewers
        .filter((v) => v.isTyping && v.user.id !== currentUserId)
        .map((v) => v.user),
    [viewers, currentUserId],
  );
  return <TypingIndicator users={typingUsers} />;
}
