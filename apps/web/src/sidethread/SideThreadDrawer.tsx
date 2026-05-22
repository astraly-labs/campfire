import {
  CommandId,
  type EnvironmentId,
  type LinkedRef,
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
import {
  CornerUpLeftIcon,
  HashIcon,
  ImageIcon,
  LinkIcon,
  MessageSquareIcon,
  PencilIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
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
import {
  colorIndexForUserId,
  initialsFor,
  NAME_TEXT_PALETTE,
  SOFT_PALETTE,
} from "../presence/AvatarStack";
import { useViewersOfSideThread } from "../presence/presenceStore";
import { TypingIndicator } from "../presence/TypingIndicator";
import { useUiStateStore } from "../uiStateStore";
import { clearTyping, notifyTyping } from "../presence/usePresenceHeartbeat";
import { GifAttachmentInline } from "./GifAttachmentInline";
import { GifPicker } from "./GifPicker";
import {
  dropHashtagToken,
  filterHashtagCandidates,
  findActiveHashtagToken,
  type ActiveHashtagToken,
  type HashtagCandidate,
} from "./hashtagAutocomplete";
import { LinkChatPicker } from "./LinkChatPicker";
import { LinkedRefChip } from "./LinkedRefChip";
import { MessageReactions } from "./MessageReactions";
import { deriveSideThreadId, useSideThreadStore } from "./sideThreadStore";
import { toAttachment, type GiphyGif } from "./giphyClient";
import { useStore } from "../store";
import { usePrimaryEnvironmentId } from "../environments/primary";

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

// Telegram-style time-of-day stamp ("12:36"). Locale-aware but explicitly
// 2-digit hours/minutes so the inline tail in the bubble stays stable.
function formatTimeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Label for the centered date chip that separates conversation days
 * ("Today" / "Yesterday" / "March 12"). Returns `null` when the previous
 * message is on the same calendar day — no chip needed.
 */
function dateDividerLabel(currentIso: string, previousIso: string | null): string | null {
  const current = new Date(currentIso);
  if (previousIso) {
    if (startOfDay(current) === startOfDay(new Date(previousIso))) return null;
  }
  const now = new Date();
  const diffDays = Math.round((startOfDay(now) - startOfDay(current)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) {
    return current.toLocaleDateString([], { weekday: "long" });
  }
  return current.toLocaleDateString([], { month: "long", day: "numeric" });
}

const GROUP_GAP_MS = 5 * 60 * 1000;

function isGroupedWith(
  previous: SideThreadMessage | undefined,
  current: SideThreadMessage,
): boolean {
  if (!previous) return false;
  if (previous.author.id !== current.author.id) return false;
  return (
    new Date(current.createdAt).getTime() - new Date(previous.createdAt).getTime() < GROUP_GAP_MS
  );
}

interface MessageBubbleProps {
  readonly message: SideThreadMessage;
  readonly isMine: boolean;
  readonly isFirstOfGroup: boolean;
  readonly isLastOfGroup: boolean;
  readonly currentUserId: UserRef["id"] | undefined;
  /** Resolved reply target (from `messagesById`), or `null` if not a reply / target unknown. */
  readonly replyTarget: SideThreadMessage | null;
  /**
   * Peers who have read up to this message. Empty array suppresses the
   * "seen by" affordance — DrawerBody only populates this on the last
   * of *my* messages so the affordance doesn't repeat for every bubble.
   */
  readonly seenBy: ReadonlyArray<UserRef>;
  readonly onToggleReaction: (messageId: SideThreadMessageId, emoji: string) => void;
  readonly onStartReply: (message: SideThreadMessage) => void;
  /** Only invoked when `isMine` — DrawerBody enforces. */
  readonly onStartEdit: (message: SideThreadMessage) => void;
}

/**
 * Single chat row: avatar gutter (only on the last bubble of a "from
 * someone else" group, Telegram pattern) + bubble + reactions.
 *
 * The author name lives *inside* the bubble (on the first of a group),
 * not above it, so consecutive bubbles from the same person merge
 * visually. Timestamp floats at the bottom-right of the message text
 * via a CSS float trick — if the last line is short, time sits beside
 * it; if it's long, time wraps to its own line, mirroring Telegram.
 */
function MessageBubble({
  message,
  isMine,
  isFirstOfGroup,
  isLastOfGroup,
  currentUserId,
  replyTarget,
  seenBy,
  onToggleReaction,
  onStartReply,
  onStartEdit,
}: MessageBubbleProps) {
  const colorIndex = colorIndexForUserId(message.author.id);
  const avatarPalette = SOFT_PALETTE[colorIndex]!;
  const nameColor = NAME_TEXT_PALETTE[colorIndex]!;
  const hasText = message.text.length > 0;
  const hasMedia = message.attachments.length > 0;
  const replyTargetColorIndex = replyTarget
    ? colorIndexForUserId(replyTarget.author.id)
    : null;
  const replyTargetPalette =
    replyTargetColorIndex !== null ? SOFT_PALETTE[replyTargetColorIndex]! : null;
  const replyTargetNameColor =
    replyTargetColorIndex !== null ? NAME_TEXT_PALETTE[replyTargetColorIndex]! : null;

  return (
    <div
      data-st-message-id={message.id}
      onDoubleClick={(event) => {
        // Telegram-style shortcut: a double-click anywhere on a bubble
        // stages it as a reply. We swallow text selection that the
        // default double-click would create, since the click landed on
        // the bubble (not the text) and the user clearly meant "reply".
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
        onStartReply(message);
      }}
      onContextMenu={
        isMine
          ? (event) => {
              // Right-click → straight into edit mode (Telegram desktop
              // surfaces a full menu here; we ship the most common
              // action and skip the popover round-trip).
              event.preventDefault();
              onStartEdit(message);
            }
          : undefined
      }
      className={cn(
        "group/msg flex items-end gap-1.5",
        isMine ? "flex-row-reverse pl-10" : "pr-10",
        isLastOfGroup ? "mb-2" : "mb-0.5",
      )}
    >
      {/* Avatar gutter — reserved for "others" so consecutive bubbles
          align even when the avatar is invisible for non-tail rows. */}
      {!isMine ? (
        <div className="w-7 shrink-0">
          {isLastOfGroup ? (
            <span
              className={cn(
                "inline-flex size-7 items-center justify-center rounded-full text-[10px] font-semibold",
                avatarPalette.bg,
                avatarPalette.text,
              )}
              aria-hidden
            >
              {initialsFor(message.author.displayName)}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className={cn("flex max-w-[78%] flex-col", isMine ? "items-end" : "items-start")}>
        <div
          className={cn(
            "relative rounded-2xl px-3 py-1.5 text-sm leading-relaxed shadow-sm",
            isMine
              ? "bg-sky-500 text-white dark:bg-sky-600"
              : "bg-muted text-foreground",
            // Telegram "tail" — collapse one corner radius on the
            // last bubble of a group toward the speaker's side.
            isLastOfGroup && (isMine ? "rounded-br-md" : "rounded-bl-md"),
          )}
        >
          {/* Author name only on the first of a "from someone else"
              group — keeps consecutive bubbles tight. */}
          {!isMine && isFirstOfGroup ? (
            <div className={cn("mb-0.5 text-[11px] font-semibold", nameColor)}>
              {message.author.displayName}
            </div>
          ) : null}

          {/* Reply preview chip: clicking jumps to the cited bubble.
              Vertical bar matches the target *author's* color (not the
              speaker's) so visual identity tracks the cited person. */}
          {replyTarget ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                scrollToSideThreadMessage(replyTarget.id);
              }}
              className={cn(
                "mb-1 flex w-full items-stretch gap-1.5 overflow-hidden rounded-md text-left transition-colors",
                isMine
                  ? "bg-white/10 hover:bg-white/15"
                  : "bg-background/50 hover:bg-background/70",
              )}
            >
              <div
                className={cn(
                  "w-0.5 shrink-0",
                  replyTargetPalette?.bg ?? "bg-muted-foreground/40",
                )}
                aria-hidden
              />
              <div className="min-w-0 px-1.5 py-1">
                <div
                  className={cn(
                    "truncate text-[11px] font-semibold",
                    isMine ? "text-white" : replyTargetNameColor ?? "text-foreground",
                  )}
                >
                  {replyTarget.author.displayName}
                </div>
                <div
                  className={cn(
                    "truncate text-[11px]",
                    isMine ? "text-white/75" : "text-muted-foreground",
                  )}
                >
                  {previewForReply(replyTarget)}
                </div>
              </div>
            </button>
          ) : null}

          {message.quotedMessageId ? (
            <button
              type="button"
              onClick={() => scrollToMessage(message.quotedMessageId!)}
              title="Go to quoted agent message"
              className={cn(
                "mb-1 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]",
                isMine
                  ? "border-white/20 bg-white/10 text-white/80 hover:bg-white/20"
                  : "border-border/50 bg-background/40 text-muted-foreground/80 hover:text-foreground",
              )}
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
          {message.linkedRef ? (
            <div className={cn("mb-1", hasText ? "" : "")}>
              <LinkedRefChip linkedRef={message.linkedRef} />
            </div>
          ) : null}

          {hasText ? (
            <p className="whitespace-pre-wrap break-words">
              {renderTextWithMentions(message.text, message.mentions).map((segment, index) =>
                segment.kind === "text" ? (
                  <span key={index}>{segment.text}</span>
                ) : (
                  <span
                    key={index}
                    className={cn(
                      "rounded px-1 font-medium",
                      isMine
                        ? "bg-white/20 text-white"
                        : segment.user.id === currentUserId
                          ? "bg-amber-500/30 text-amber-700 dark:text-amber-300"
                          : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                    )}
                  >
                    @{segment.handle}
                  </span>
                ),
              )}
              {/* Float trick: timestamp slips next to the last line of
                  text when it fits, otherwise drops below. The leading
                  spaces reserve room so the float never overlaps the
                  last word. The "edited" hint piggybacks on the same
                  float so the bubble grows by exactly one inline-block
                  width. */}
              <span
                className={cn(
                  "float-right ml-2 mt-1 inline-flex select-none items-baseline gap-1 text-[10px] tabular-nums",
                  isMine ? "text-white/70" : "text-muted-foreground/60",
                )}
                aria-hidden
              >
                {message.editedAt ? <span className="italic">edited</span> : null}
                {formatTimeOfDay(message.createdAt)}
              </span>
            </p>
          ) : (
            // Media-only message — no text to float the time alongside,
            // so render the timestamp on its own muted line.
            hasMedia || message.linkedRef ? (
              <div
                className={cn(
                  "mt-1 text-right text-[10px] tabular-nums",
                  isMine ? "text-white/70" : "text-muted-foreground/60",
                )}
              >
                {formatTimeOfDay(message.createdAt)}
              </div>
            ) : null
          )}
        </div>

        {/* Action row just under the bubble: seen-by avatars + reactions
            + reply. Mine bubbles flip the flex direction so everything
            still aligns flush to the speaker's side. The reply button
            uses hover-fade; chips and seen-by render persistently when
            present. */}
        <div
          className={cn(
            "flex items-center gap-1 px-1",
            isMine ? "flex-row-reverse self-end" : "self-start",
          )}
        >
          {seenBy.length > 0 ? (
            <div className="flex items-center pr-0.5" aria-label="Seen by">
              {seenBy.slice(0, 3).map((user, avatarIndex) => {
                const palette = SOFT_PALETTE[colorIndexForUserId(user.id)]!;
                return (
                  <span
                    key={user.id}
                    title={`Seen by ${user.displayName}`}
                    className={cn(
                      "inline-flex size-4 items-center justify-center rounded-full text-[8px] font-semibold ring-1 ring-background",
                      palette.bg,
                      palette.text,
                      avatarIndex > 0 && "-ml-1.5",
                    )}
                  >
                    {initialsFor(user.displayName)}
                  </span>
                );
              })}
              {seenBy.length > 3 ? (
                <span className="ml-1 text-[10px] tabular-nums text-muted-foreground/70">
                  +{seenBy.length - 3}
                </span>
              ) : null}
            </div>
          ) : null}
          <MessageReactions
            reactions={message.reactions}
            currentUserId={currentUserId}
            onToggle={(emoji) => onToggleReaction(message.id, emoji)}
          />
          <button
            type="button"
            onClick={() => onStartReply(message)}
            aria-label="Reply to this message"
            title="Reply"
            className="inline-flex size-5 items-center justify-center rounded-full border border-border/50 bg-background/40 text-muted-foreground/70 opacity-0 transition-opacity hover:text-foreground group-hover/msg:opacity-100"
          >
            <CornerUpLeftIcon className="size-3" />
          </button>
          {isMine ? (
            <button
              type="button"
              onClick={() => onStartEdit(message)}
              aria-label="Edit this message"
              title="Edit"
              className="inline-flex size-5 items-center justify-center rounded-full border border-border/50 bg-background/40 text-muted-foreground/70 opacity-0 transition-opacity hover:text-foreground group-hover/msg:opacity-100"
            >
              <PencilIcon className="size-3" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

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

// Sibling of `scrollToMessage` for *side-thread* messages: jumps to the
// bubble carrying `data-st-message-id`. Used by reply-preview clicks
// inside the drawer. Same flash treatment but with a sky tint to match
// the "mine" bubble palette.
function scrollToSideThreadMessage(messageId: string) {
  const el = document.querySelector<HTMLElement>(`[data-st-message-id="${messageId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("ring-2", "ring-sky-500/60", "rounded-2xl");
  window.setTimeout(() => {
    el.classList.remove("ring-2", "ring-sky-500/60", "rounded-2xl");
  }, 1400);
}

// One-line preview of a message used inside the reply chip — text wins,
// then falls back to a label for media-only / link-only messages.
function previewForReply(message: SideThreadMessage): string {
  const text = message.text.trim();
  if (text.length > 0) return text;
  if (message.attachments.some((a) => a.kind === "gif")) return "GIF";
  if (message.linkedRef) {
    return message.linkedRef.kind === "global-chat" ? "Linked Global chat" : "Linked thread";
  }
  return "Message";
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
  const [pendingLinkedRef, setPendingLinkedRef] = useState<LinkedRef | null>(null);
  const [pendingReplyTo, setPendingReplyTo] = useState<SideThreadMessage | null>(null);
  // When set, the composer is in "edit" mode — Send dispatches a
  // `sidethread.message.edit` for the targeted message instead of a
  // fresh `message.post`. Mutually exclusive with `pendingReplyTo`
  // (a single composer can't be both a reply *and* an in-place edit).
  const [editingMessage, setEditingMessage] = useState<SideThreadMessage | null>(null);
  const [activeMention, setActiveMention] = useState<ActiveMentionToken | null>(null);
  const [mentionHighlight, setMentionHighlight] = useState(0);
  const [activeHashtag, setActiveHashtag] = useState<ActiveHashtagToken | null>(null);
  const [hashtagHighlight, setHashtagHighlight] = useState(0);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const api = ensureEnvironmentApi(environmentId);
  useEnsureIdentityLoaded(api);
  useEnsureUserDirectoryLoaded(api);
  const currentUser = useCurrentUser();
  const identityError = useIdentityStore((store) =>
    store.state.kind === "error" ? store.state.message : null,
  );
  const allUsers = useUserDirectoryStore((store) => store.users);
  const listRef = useRef<HTMLDivElement>(null);

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

  // Hashtag autocomplete data — pulls from the same workspace thread
  // store that `LinkChatPicker` uses, plus the global chat as a stable
  // entry. We compute the full candidate list (sorted by recency) once
  // and filter against the active query in a separate memo so typing
  // doesn't churn the whole shell snapshot.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const threadShellById = useStore((state) =>
    primaryEnvironmentId
      ? state.environmentStateById[primaryEnvironmentId]?.threadShellById ?? null
      : null,
  );
  const allHashtagCandidates = useMemo<ReadonlyArray<HashtagCandidate>>(() => {
    const list: HashtagCandidate[] = [];
    // Suppress global-chat self-link when we *are* the global chat.
    if (parentThreadId !== null) {
      list.push({
        linkedRef: { kind: "global-chat" },
        title: "Global chat",
        subtitle: "workspace",
      });
    }
    if (threadShellById) {
      const sortKey = (s: { updatedAt?: string | undefined; createdAt: string }) =>
        s.updatedAt ?? s.createdAt;
      const sorted = Object.values(threadShellById)
        .filter(
          (s) => s.archivedAt === null && (parentThreadId === null || s.id !== parentThreadId),
        )
        .sort((a, b) => {
          const ka = sortKey(a);
          const kb = sortKey(b);
          return ka < kb ? 1 : ka > kb ? -1 : 0;
        });
      for (const shell of sorted) {
        list.push({
          linkedRef: { kind: "agent-thread", threadId: shell.id },
          title: shell.title,
          threadId: shell.id,
        });
      }
    }
    return list;
  }, [threadShellById, parentThreadId]);
  const hashtagCandidates = useMemo<ReadonlyArray<HashtagCandidate>>(() => {
    if (!activeHashtag) return [];
    return filterHashtagCandidates(allHashtagCandidates, activeHashtag.query).slice(0, 8);
  }, [activeHashtag, allHashtagCandidates]);

  useEffect(() => {
    setHashtagHighlight(0);
  }, [activeHashtag?.query, hashtagCandidates.length]);

  // Mark the side-thread "visited" the moment the drawer opens so the
  // header-button unread dot disappears. We also re-mark on every new
  // message-posted event below — without that the badge would flicker back
  // on every fresh mention while the drawer is open.
  const markVisited = useUiStateStore((state) => state.markThreadVisited);
  useEffect(() => {
    markVisited(sideThreadId);
  }, [sideThreadId, markVisited]);

  // Tracks the most recent timestamp we've dispatched a `mark-read` for,
  // scoped per drawer-open. Lives in a ref (not state) so the subscribe
  // callback can read its current value without triggering re-renders or
  // re-subscribes. Reset every time the side-thread changes.
  const lastMarkedReadAtRef = useRef<string>("");

  useEffect(() => {
    if (!currentUser) return;

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    lastMarkedReadAtRef.current = "";

    // Fire-and-forget read-marker dispatch. We dedupe by timestamp via
    // `lastMarkedReadAtRef` and rely on the decider/projector taking the
    // monotonic max — duplicates are cheap but rude to the event log.
    const markRead = (at: string) => {
      if (!currentUser) return;
      if (at <= lastMarkedReadAtRef.current) return;
      lastMarkedReadAtRef.current = at;
      void api.sideThread
        .dispatchCommand({
          type: "sidethread.mark-read",
          commandId: CommandId.make(`st-mark-read:${sideThreadId}:${Date.now()}`),
          sideThreadId,
          user: currentUser,
          lastReadAt: at as SideThread["createdAt"],
        })
        .catch(() => {
          // Read markers are best-effort — a network blip shouldn't
          // surface as a user-visible error.
        });
    };

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
          // On opening, ack everything we've already received. The
          // dispatch is deferred a tick so the snapshot setState wins
          // the render race — purely cosmetic, but it prevents a flash
          // where "vu par moi" shows up before the bubble does.
          const msgs = item.snapshot.sideThread.messages;
          const latest = msgs[msgs.length - 1];
          if (latest) {
            queueMicrotask(() => markRead(latest.createdAt));
          }
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
              readBy: [],
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
                        linkedRef: posted.linkedRef ?? null,
                        replyToSideThreadMessageId:
                          posted.replyToSideThreadMessageId ?? null,
                        editedAt: null,
                      },
                    ],
                  }
                : current,
            );
            // Re-mark visited so the header badge doesn't pop back on every new
            // mention while the drawer is open.
            markVisited(sideThreadId, event.occurredAt);
            // Ack inbound messages (from someone else) so peers can see the
            // ✓✓ update on their side. We skip self-posts: I obviously
            // "saw" what I just typed.
            if (posted.author.id !== currentUser.id) {
              markRead(event.occurredAt);
            }
          } else if (event.type === "sidethread.marked-read") {
            const marked = event.payload;
            setSideThread((current) => {
              if (!current) return current;
              const userId = marked.user.id;
              const existingIndex = current.readBy.findIndex((m) => m.user.id === userId);
              const nextMarker = { user: marked.user, lastReadAt: marked.lastReadAt };
              let nextReadBy: SideThread["readBy"];
              if (existingIndex < 0) {
                nextReadBy = [...current.readBy, nextMarker];
              } else {
                const existing = current.readBy[existingIndex]!;
                if (existing.lastReadAt >= marked.lastReadAt) return current;
                nextReadBy = current.readBy.map((m, idx) =>
                  idx === existingIndex ? nextMarker : m,
                );
              }
              return {
                ...current,
                updatedAt: event.occurredAt,
                readBy: nextReadBy,
              };
            });
          } else if (event.type === "sidethread.message-edited") {
            const edited = event.payload;
            setSideThread((current) =>
              current
                ? {
                    ...current,
                    updatedAt: event.occurredAt,
                    messages: current.messages.map((m) =>
                      m.id === edited.messageId
                        ? {
                            ...m,
                            text: edited.text,
                            updatedAt: event.occurredAt,
                            editedAt: event.occurredAt,
                          }
                        : m,
                    ),
                  }
                : current,
            );
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
    // A "Cite excerpt" / "Take a look" affordance always starts a new
    // message — bail out of edit mode if we happened to be mid-edit.
    setEditingMessage(null);
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

  // Recompute the active mention / hashtag tokens whenever the draft or
  // caret moves. Also prune `pendingMentions` whose handle no longer
  // appears in the text — if the user deletes the `@matthias` token we
  // shouldn't still ship the mention to the server.
  const refreshMentionContext = useCallback((text: string, caret: number) => {
    setActiveMention(findActiveMentionToken(text, caret));
    setActiveHashtag(findActiveHashtagToken(text, caret));
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

  // Picking a hashtag candidate strips the `#<query>` token from the
  // draft and stages the LinkedRef in the same `pendingLinkedRef` slot
  // the button-picker uses. We deliberately overwrite any prior
  // pending link — a message ships at most one LinkedRef today.
  const selectHashtagCandidate = useCallback(
    (candidate: HashtagCandidate) => {
      if (!activeHashtag) return;
      const { nextText, nextCaret } = dropHashtagToken(draft, activeHashtag);
      setDraft(nextText);
      setPendingLinkedRef(candidate.linkedRef);
      setActiveHashtag(null);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [activeHashtag, draft],
  );

  const send = async () => {
    if (!currentUser) return;
    const text = draft.trim();
    if (!text) return;

    // Edit mode short-circuits the normal post path entirely: we keep
    // mentions/quotes/links/replies intact on the original (the decider
    // only rewrites `text`) and just ship the edit command.
    if (editingMessage) {
      const target = editingMessage;
      setDraft("");
      setEditingMessage(null);
      setActiveMention(null);
      clearTyping("side");
      if (text === target.text) return;
      try {
        await api.sideThread.dispatchCommand({
          type: "sidethread.message.edit",
          commandId: CommandId.make(`st-edit:${sideThreadId}:${target.id}:${Date.now()}`),
          sideThreadId,
          messageId: target.id,
          editor: currentUser,
          text,
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to edit");
      }
      return;
    }

    // Only keep mentions whose handle still appears in the trimmed text —
    // mirror the same prune we do during typing so a stale entry doesn't
    // hit the server.
    const mentions = pendingMentions.filter((mention) =>
      text.includes(`@${mentionHandleForUser(mention)}`),
    );
    const quotedMessageId = pendingQuotedMessageId;
    const linkedRef = pendingLinkedRef;
    const replyToSideThreadMessageId = pendingReplyTo?.id ?? null;

    setDraft("");
    setPendingMentions([]);
    setPendingQuotedMessageId(null);
    setPendingLinkedRef(null);
    setPendingReplyTo(null);
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
        linkedRef,
        replyToSideThreadMessageId,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to send");
    }
  };

  // Telegram-style send: clicking a GIF in the picker ships it as a
  // standalone message immediately — no "preview then send" step. The
  // current draft (if any) is preserved so users don't lose in-progress
  // text while reaching for an emoji-class reply. We *do* honour any
  // pending reply target so a GIF can be sent as a reply (TG allows it).
  const sendGif = useCallback(
    async (gif: GiphyGif) => {
      if (!currentUser) return;
      const attachment = toAttachment(gif);
      if (!attachment) return;
      const replyToSideThreadMessageId = pendingReplyTo?.id ?? null;
      setPendingReplyTo(null);
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
          linkedRef: null,
          replyToSideThreadMessageId,
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to send GIF");
      }
    },
    [api, currentUser, pendingReplyTo, sideThreadId],
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
    // While an autocomplete popover is open, arrow keys navigate it,
    // Enter/Tab accept the highlighted entry, Escape dismisses it.
    // Hashtag wins precedence over mention only because the two never
    // co-exist (a token is either `@…` or `#…`, never both).
    if (activeHashtag && hashtagCandidates.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHashtagHighlight((h) => (h + 1) % hashtagCandidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHashtagHighlight(
          (h) => (h - 1 + hashtagCandidates.length) % hashtagCandidates.length,
        );
        return;
      }
      if ((event.key === "Enter" || (event.key === "Tab" && !event.shiftKey))) {
        event.preventDefault();
        const choice = hashtagCandidates[hashtagHighlight];
        if (choice) selectHashtagCandidate(choice);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setActiveHashtag(null);
        return;
      }
    }
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
    // Telegram/Slack/Discord convention: Enter sends, Shift+Enter inserts
    // a newline. Cmd/Ctrl+Enter also sends (legacy power-user habit).
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
      return;
    }
    // Escape exits edit mode (and only that — don't steal Escape from
    // the mention popover or the host page).
    if (event.key === "Escape" && editingMessage) {
      event.preventDefault();
      cancelEditing();
      return;
    }
    // ArrowUp on an empty composer loads the most recent own message
    // into edit mode — same affordance Telegram, Slack and iMessage
    // ship. We only fire when the caret is at position 0 to avoid
    // hijacking normal "move up a line" navigation inside multi-line
    // drafts.
    if (
      event.key === "ArrowUp" &&
      !editingMessage &&
      draft.length === 0 &&
      event.currentTarget.selectionStart === 0 &&
      currentUser
    ) {
      const lastMine = [...(sideThread?.messages ?? [])]
        .reverse()
        .find((m) => m.author.id === currentUser.id && m.text.trim().length > 0);
      if (lastMine) {
        event.preventDefault();
        startEditing(lastMine);
      }
    }
  };

  const messages = sideThread?.messages ?? [];
  const readBy = sideThread?.readBy ?? [];
  const canSend = draft.trim().length > 0 && Boolean(currentUser);
  const messagesById = useMemo(() => {
    const m = new Map<SideThreadMessageId, SideThreadMessage>();
    for (const msg of messages) m.set(msg.id, msg);
    return m;
  }, [messages]);
  // Telegram only renders the "seen by" affordance on the *last* of my
  // own messages — anything below it implicitly inherits the same audience.
  // We pre-compute that index here so MessageBubble's render path stays
  // pure and just renders what it's told.
  const lastSeenMineIndex = useMemo(() => {
    if (!currentUser || messages.length === 0 || readBy.length === 0) return -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.author.id !== currentUser.id) continue;
      const seenByOthers = readBy.some(
        (marker) => marker.user.id !== currentUser.id && marker.lastReadAt >= msg.createdAt,
      );
      if (seenByOthers) return i;
    }
    return -1;
  }, [messages, readBy, currentUser]);
  // Focus the composer when a reply is staged so the user can start
  // typing immediately — mirrors Telegram's tap-to-reply UX.
  const startReply = useCallback((message: SideThreadMessage) => {
    setPendingReplyTo(message);
    setEditingMessage(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // Enter edit mode: pre-fills the composer with the existing text and
  // moves the caret to the end (matches Telegram's "press ↑" behaviour).
  // Cancels any pending reply — the composer can't be in both states.
  const startEditing = useCallback((message: SideThreadMessage) => {
    setEditingMessage(message);
    setPendingReplyTo(null);
    setDraft(message.text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  }, []);

  const cancelEditing = useCallback(() => {
    setEditingMessage(null);
    setDraft("");
  }, []);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-background",
        mode === "sidebar"
          ? "h-full w-[380px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
      role="complementary"
      aria-label="Side thread"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">
            {parentThreadId === null ? "Global chat" : "Side thread"}
          </span>
        </div>
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

      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3">
        {messages.map((message, index) => {
          const previous = index > 0 ? messages[index - 1] : undefined;
          const next = index < messages.length - 1 ? messages[index + 1] : undefined;
          const grouped = isGroupedWith(previous, message);
          const groupedNext = next ? isGroupedWith(message, next) : false;
          const dividerLabel = dateDividerLabel(
            message.createdAt,
            previous ? previous.createdAt : null,
          );
          const isMine = currentUser?.id === message.author.id;
          return (
            <div key={message.id}>
              {dividerLabel ? (
                <div className="my-3 flex items-center justify-center">
                  <span className="rounded-full bg-muted/70 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                    {dividerLabel}
                  </span>
                </div>
              ) : null}
              <MessageBubble
                message={message}
                isMine={isMine}
                isFirstOfGroup={!grouped}
                isLastOfGroup={!groupedNext}
                currentUserId={currentUser?.id}
                replyTarget={
                  message.replyToSideThreadMessageId
                    ? messagesById.get(message.replyToSideThreadMessageId) ?? null
                    : null
                }
                seenBy={
                  index === lastSeenMineIndex
                    ? readBy
                        .filter(
                          (m) =>
                            m.user.id !== currentUser?.id &&
                            m.lastReadAt >= message.createdAt,
                        )
                        .map((m) => m.user)
                    : []
                }
                onToggleReaction={toggleReaction}
                onStartReply={startReply}
                onStartEdit={startEditing}
              />
            </div>
          );
        })}
        {sideThread && messages.length === 0 ? (
          <div className="mt-6 flex flex-col items-center gap-1 text-center text-muted-foreground/60">
            <span className="text-sm">No messages yet</span>
            <span className="text-[11px]">Say hi to kick things off.</span>
          </div>
        ) : null}
      </div>

      <SideThreadTypingRow sideThreadId={sideThreadId} currentUserId={currentUser?.id} />

      {(identityError ?? error) ? (
        <div className="border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {identityError ?? error}
        </div>
      ) : null}

      <form
        className="relative flex flex-col gap-2 border-t border-border/60 px-3 py-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {pendingQuotedMessageId ? (
          <div className="flex items-center justify-between rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300">
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
        {editingMessage ? (
          <div className="flex items-stretch gap-1.5 overflow-hidden rounded-md border border-sky-500/30 bg-sky-500/10 pr-1.5">
            <div className="w-0.5 shrink-0 bg-sky-500" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col py-1">
              <span className="truncate text-[11px] font-semibold text-sky-600 dark:text-sky-300">
                Editing message
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {previewForReply(editingMessage)}
              </span>
            </div>
            <button
              type="button"
              onClick={cancelEditing}
              aria-label="Cancel edit"
              className="self-center text-muted-foreground/60 hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        ) : null}
        {pendingReplyTo ? (
          (() => {
            // Same color treatment as in-bubble reply chips: bar &
            // displayName tint match the *target author's* hue.
            const targetIdx = colorIndexForUserId(pendingReplyTo.author.id);
            const targetBg = SOFT_PALETTE[targetIdx]!.bg;
            const targetName = NAME_TEXT_PALETTE[targetIdx]!;
            return (
              <div className="flex items-stretch gap-1.5 overflow-hidden rounded-md border border-border/60 bg-muted/40 pr-1.5">
                <div className={cn("w-0.5 shrink-0", targetBg)} aria-hidden />
                <div className="flex min-w-0 flex-1 flex-col py-1">
                  <span className={cn("truncate text-[11px] font-semibold", targetName)}>
                    Replying to {pendingReplyTo.author.displayName}
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {previewForReply(pendingReplyTo)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setPendingReplyTo(null)}
                  aria-label="Cancel reply"
                  className="self-center text-muted-foreground/60 hover:text-foreground"
                >
                  <XIcon className="size-3.5" />
                </button>
              </div>
            );
          })()
        ) : null}
        {pendingLinkedRef ? (
          <LinkedRefChip
            linkedRef={pendingLinkedRef}
            onRemove={() => setPendingLinkedRef(null)}
          />
        ) : null}
        <LinkChatPicker
          open={linkPickerOpen}
          onPick={(ref) => setPendingLinkedRef(ref)}
          onClose={() => setLinkPickerOpen(false)}
          excludeThreadId={parentThreadId}
        />
        {activeHashtag && hashtagCandidates.length > 0 ? (
          <ul
            role="listbox"
            aria-label="Link a conversation"
            className="absolute bottom-[calc(100%-0.25rem)] left-3 right-3 z-10 max-h-64 overflow-y-auto rounded-md border border-border/70 bg-popover shadow-lg"
          >
            {hashtagCandidates.map((candidate, index) => {
              const isGlobal = candidate.linkedRef.kind === "global-chat";
              const Icon = isGlobal ? HashIcon : MessageSquareIcon;
              return (
                <li
                  key={isGlobal ? "global" : candidate.threadId}
                  role="option"
                  aria-selected={index === hashtagHighlight}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    selectHashtagCandidate(candidate);
                  }}
                  onMouseEnter={() => setHashtagHighlight(index)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm",
                    index === hashtagHighlight
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50",
                  )}
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{candidate.title}</span>
                  {candidate.subtitle ? (
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">
                      {candidate.subtitle}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
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

        {/* Telegram-style pill composer: textarea sits inside a rounded
            container with attachment icons inline; the round Send button
            floats to the right and only lights up when there's content. */}
        <div className="flex items-end gap-2">
          <div className="flex flex-1 items-end gap-1 rounded-3xl border border-border/60 bg-card/60 px-2 py-1 focus-within:border-border focus-within:bg-card">
            <div className="flex shrink-0 items-center gap-0.5 pb-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setGifPickerOpen((open) => !open)}
                aria-label="Insert GIF"
                aria-pressed={gifPickerOpen}
                className={cn(
                  "size-7 text-muted-foreground/70 hover:text-foreground",
                  gifPickerOpen && "text-sky-500 dark:text-sky-400",
                )}
              >
                <ImageIcon className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setLinkPickerOpen((open) => !open)}
                aria-label="Link a chat"
                aria-pressed={linkPickerOpen}
                className={cn(
                  "size-7 text-muted-foreground/70 hover:text-foreground",
                  (linkPickerOpen || pendingLinkedRef !== null) &&
                    "text-sky-500 dark:text-sky-400",
                )}
              >
                <LinkIcon className="size-4" />
              </Button>
            </div>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={handleDraftChange}
              onSelect={(event) => {
                const el = event.currentTarget;
                refreshMentionContext(el.value, el.selectionStart ?? el.value.length);
              }}
              placeholder="Message"
              rows={1}
              className="max-h-32 min-h-7 flex-1 resize-none border-0 bg-transparent px-1 py-1 text-sm leading-snug placeholder:text-muted-foreground/50 focus:outline-none focus:ring-0"
              onKeyDown={onKeyDown}
            />
          </div>
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            title="Send (Enter — Shift+Enter for newline)"
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-full transition-all",
              canSend
                ? "bg-sky-500 text-white shadow-sm hover:bg-sky-600 dark:bg-sky-600 dark:hover:bg-sky-500"
                : "bg-muted text-muted-foreground/50",
            )}
          >
            <SendIcon className="size-4 -translate-x-px translate-y-px" />
          </button>
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
