import {
  SideThreadMessageId,
  type ThreadId,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2ThreadProjection,
  type SideThreadMessage,
  type SideThreadPostAttachment,
  type SideThreadQuotedExcerpt,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { sideThreadIdForThread } from "@t3tools/shared/sideThread";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  CornerUpLeftIcon,
  ImageIcon,
  LinkIcon,
  MessageCircleIcon,
  PencilIcon,
  SendIcon,
  SmilePlusIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAssetUrls } from "~/assets/assetUrls";
import { randomUUID } from "~/lib/utils";
import type { GoogleTeamMember } from "../collaboration/googleTeam";
import { CollaborationAvatar } from "../collaboration/CollaborationAvatar";
import { useTimelineMessageRevealStore } from "../components/chat/timelineMessageReveal";
import { Button } from "../components/ui/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useClientSettings } from "../hooks/useSettings";
import { notifyPresenceTyping } from "../presence/presence";
import { useThreadShells } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { GifAttachmentInline } from "./GifAttachmentInline";
import { GifPicker } from "./GifPicker";
import { giphyAttachment } from "./giphyClient";
import { SideThreadComposerInput } from "./SideThreadComposerInput";
import {
  linkedThreadForText,
  mentionedTeammates,
  type PickedThreadLink,
} from "./sideThreadComposerTriggers";
import { readImage, withAddedAttachments } from "./sideThreadImages";
import { SideThreadPendingQuote, SideThreadQuoteCard } from "./SideThreadQuoteCard";
import type { SideThreadDraftQuote } from "./sideThreadQuote";
import { sideThreadMessageTimestamp } from "./sideThreadTimestamp";

const QUICK_REACTIONS = ["👍", "❤️", "👀", "🎉"] as const;

function MessageTime(props: {
  readonly message: SideThreadMessage;
  readonly timestampFormat: TimestampFormat;
  readonly className: string;
}) {
  const { label, title } = sideThreadMessageTimestamp(props.message, props.timestampFormat);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<time dateTime={props.message.createdAt} className={props.className} />}
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup>{title}</TooltipPopup>
    </Tooltip>
  );
}

export function SideThreadDrawer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly thread: Pick<OrchestrationV2ThreadProjection, "sideThreads" | "messages">;
  readonly team: ReadonlyArray<GoogleTeamMember>;
  readonly currentSubject: string | null;
  readonly open: boolean;
  /** Attached to the next message sent, then cleared. */
  readonly quote: SideThreadDraftQuote | null;
  readonly onQuoteChange: (quote: SideThreadDraftQuote | null) => void;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId, thread, team, currentSubject, open, quote } = props;
  const { onQuoteChange, onClose } = props;
  const anchorMessageId = quote?.messageId ?? null;
  const sideThreadId = sideThreadIdForThread(threadId);
  const sideThread = useMemo(
    () => (thread.sideThreads ?? []).find((entry) => entry.id === sideThreadId) ?? null,
    [sideThreadId, thread.sideThreads],
  );
  const parentMessages = useMemo(
    () => new Map(thread.messages.map((message) => [message.id, message] as const)),
    [thread.messages],
  );
  const allThreads = useThreadShells(open);
  const navigate = useNavigate();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const create = useAtomCommand(threadEnvironment.createSideThread, {
    reportDefect: false,
    reportFailure: false,
  });
  const post = useAtomCommand(threadEnvironment.postSideThreadMessage, {
    reportDefect: false,
    reportFailure: false,
  });
  const react = useAtomCommand(threadEnvironment.reactToSideThreadMessage, {
    reportDefect: false,
    reportFailure: false,
  });
  const edit = useAtomCommand(threadEnvironment.editSideThreadMessage, {
    reportDefect: false,
    reportFailure: false,
  });
  const markRead = useAtomCommand(threadEnvironment.markSideThreadRead, {
    reportDefect: false,
    reportFailure: false,
  });
  const createPending = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ReadonlyArray<SideThreadPostAttachment>>([]);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const [threadLinks, setThreadLinks] = useState<ReadonlyArray<PickedThreadLink>>([]);
  const threadTitles = useMemo(
    () =>
      new Map(
        allThreads.flatMap((candidate) =>
          candidate.environmentId === environmentId
            ? [[candidate.id, candidate.title] as const]
            : [],
        ),
      ),
    [allThreads, environmentId],
  );
  // The drawer's backdrop covers the whole timeline, so it closes before the timeline scrolls.
  const revealQuote = (messageId: MessageId, excerpt: SideThreadQuotedExcerpt | undefined) => {
    onClose();
    useTimelineMessageRevealStore
      .getState()
      .reveal(scopedThreadKey(scopeThreadRef(environmentId, threadId)), messageId, excerpt);
  };
  const openThread = (linkedThreadId: ThreadId) => {
    onClose();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, linkedThreadId)),
    });
  };

  const imageAttachmentIds = useMemo(
    () =>
      sideThread?.messages.flatMap((message) =>
        (message.attachments ?? []).flatMap((attachment) =>
          attachment.type === "image" ? [attachment.id] : [],
        ),
      ) ?? [],
    [sideThread],
  );
  const imageUrls = useAssetUrls(
    environmentId,
    imageAttachmentIds.map((attachmentId) => ({ _tag: "attachment", attachmentId })),
  );
  const imageUrlById = useMemo(
    () =>
      new Map(
        imageAttachmentIds.flatMap((id, index) =>
          imageUrls[index] ? [[id, imageUrls[index]!] as const] : [],
        ),
      ),
    [imageAttachmentIds, imageUrls],
  );

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
        ...(anchorMessageId !== null ? { anchorMessageId } : {}),
      },
    }).then((result) => {
      createPending.current = null;
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
  }, [anchorMessageId, create, environmentId, open, sideThread, sideThreadId, threadId]);

  const latestMessageAt = sideThread?.messages.at(-1)?.createdAt ?? null;
  useEffect(() => {
    if (!open || !sideThread || !latestMessageAt || !currentSubject) return;
    const previous = (sideThread.readBy ?? []).find(
      (marker) => marker.user.subject === currentSubject,
    );
    if (previous && previous.lastReadAt >= latestMessageAt) return;
    void markRead({
      environmentId,
      input: { threadId, sideThreadId, lastReadAt: latestMessageAt },
    });
  }, [
    currentSubject,
    environmentId,
    latestMessageAt,
    markRead,
    open,
    sideThread,
    sideThreadId,
    threadId,
  ]);

  const addImages = (files: ReadonlyArray<File>) => {
    void Promise.all(files.map(readImage))
      .then((images) => setAttachments((current) => withAddedAttachments(current, images)))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  const clearComposer = () => {
    setDraft("");
    setReplyToId(null);
    setEditingId(null);
    setAttachments([]);
    setGifPickerOpen(false);
    setThreadLinks([]);
  };

  const send = async () => {
    const text = draft.trim();
    if (!sideThread || sending) return;
    if (editingId !== null) {
      if (!text) return;
      setSending(true);
      const result = await edit({
        environmentId,
        input: {
          threadId,
          sideThreadId,
          messageId: SideThreadMessageId.make(editingId),
          text,
        },
      });
      setSending(false);
      if (result._tag === "Success") clearComposer();
      else setError(String(squashAtomCommandFailure(result)));
      return;
    }

    if (!text && attachments.length === 0) return;
    setSending(true);
    setError(null);
    const mentions = mentionedTeammates(text, team);
    const linkedThreadId = linkedThreadForText(text, threadLinks);
    const result = await post({
      environmentId,
      input: {
        threadId,
        sideThreadId,
        messageId: SideThreadMessageId.make(randomUUID()),
        text,
        ...(mentions.length > 0 ? { mentions } : {}),
        ...(quote !== null ? { quotedMessageId: quote.messageId } : {}),
        ...(quote?.excerpt ? { quotedExcerpt: quote.excerpt } : {}),
        ...(replyToId !== null
          ? { replyToSideThreadMessageId: SideThreadMessageId.make(replyToId) }
          : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(linkedThreadId !== null
          ? { linkedRef: { kind: "agent-thread" as const, threadId: linkedThreadId } }
          : {}),
      },
    });
    setSending(false);
    if (result._tag === "Success") {
      clearComposer();
      onQuoteChange(null);
    } else setError(String(squashAtomCommandFailure(result)));
  };

  return (
    <Sheet open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      {/* The workspace titlebar controls float above sheets (z-50 over --z-sheet), so a
          full-height drawer would hide its own close button under them. */}
      <SheetPopup side="right" className="mt-(--workspace-topbar-height) sm:max-w-[460px]">
        <div className="border-b">
          <SheetHeader>
            <div className="flex items-center gap-2 pr-8">
              <MessageCircleIcon className="size-4 text-muted-foreground" />
              <SheetTitle>Team discussion</SheetTitle>
            </div>
            <SheetDescription>One shared side thread for this agent thread.</SheetDescription>
          </SheetHeader>
        </div>
        <div data-slot="sheet-panel" className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
          <div className="flex min-h-32 flex-1 flex-col gap-3 overflow-y-auto pr-1">
            {!sideThread ? (
              <p className="text-sm text-muted-foreground">Opening discussion…</p>
            ) : sideThread.messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No team messages yet.</p>
            ) : (
              sideThread.messages.map((message, index) => {
                const reply = message.replyToSideThreadMessageId
                  ? sideThread.messages.find(
                      (candidate) => candidate.id === message.replyToSideThreadMessageId,
                    )
                  : null;
                const quotedMessageId = message.quotedMessageId;
                const quoted = quotedMessageId ? parentMessages.get(quotedMessageId) : undefined;
                const own = message.author.subject === currentSubject;
                const linkedThreadId = message.linkedRef?.threadId;
                const continuesPrevious =
                  sideThread.messages[index - 1]?.author.subject === message.author.subject;
                const continuesNext =
                  sideThread.messages[index + 1]?.author.subject === message.author.subject;
                return (
                  <div
                    key={message.id}
                    className={`group border bg-muted/25 p-3 ${
                      continuesPrevious ? "-mt-3 border-t-0 pt-1" : "rounded-t-xl"
                    } ${continuesNext ? "" : "rounded-b-xl"}`}
                  >
                    {!continuesPrevious ? (
                      <div className="mb-2 flex items-center gap-2">
                        <CollaborationAvatar
                          user={message.author}
                          size="xs"
                          labelPrefix="Sent by"
                        />
                        <span className="text-xs font-medium">{message.author.displayName}</span>
                        <MessageTime
                          message={message}
                          timestampFormat={timestampFormat}
                          className="ml-auto text-3xs text-muted-foreground"
                        />
                      </div>
                    ) : (
                      <MessageTime
                        message={message}
                        timestampFormat={timestampFormat}
                        className="float-right ml-2 text-3xs text-muted-foreground"
                      />
                    )}
                    {reply ? (
                      <div className="mb-2 truncate rounded-md border-l-2 border-primary/50 bg-background/55 px-2 py-1 text-2xs text-muted-foreground">
                        Reply to {reply.author.displayName}: {reply.text || "attachment"}
                      </div>
                    ) : null}
                    {quotedMessageId && (quoted || message.quotedExcerpt) ? (
                      <SideThreadQuoteCard
                        excerpt={message.quotedExcerpt}
                        source={quoted}
                        timestampFormat={timestampFormat}
                        onReveal={() => revealQuote(quotedMessageId, message.quotedExcerpt)}
                      />
                    ) : null}
                    {message.text ? (
                      <p className="whitespace-pre-wrap text-sm">{message.text}</p>
                    ) : null}
                    {(message.attachments ?? []).map((attachment) =>
                      attachment.type === "gif" ? (
                        <GifAttachmentInline key={attachment.url} attachment={attachment} />
                      ) : imageUrlById.get(attachment.id) ? (
                        <img
                          key={attachment.id}
                          src={imageUrlById.get(attachment.id)!}
                          alt={attachment.name}
                          className="mt-2 max-h-56 rounded-lg object-contain"
                        />
                      ) : null,
                    )}
                    {linkedThreadId ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        className="mt-2 max-w-full"
                        disabled={!threadTitles.has(linkedThreadId)}
                        onClick={() => openThread(linkedThreadId)}
                      >
                        <LinkIcon />
                        <span className="truncate">
                          {threadTitles.has(linkedThreadId)
                            ? `#${threadTitles.get(linkedThreadId)}`
                            : "Linked agent thread is unavailable"}
                        </span>
                      </Button>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100">
                      {(message.reactions ?? []).map((reaction) => {
                        const reactors = reaction.users.map((user) => user.displayName).join(", ");
                        return (
                          <Tooltip key={reaction.emoji}>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  className="rounded-full border bg-background px-2 py-0.5 text-xs"
                                  aria-label={`${reaction.emoji} from ${reactors}`}
                                  onClick={() =>
                                    void react({
                                      environmentId,
                                      input: {
                                        threadId,
                                        sideThreadId,
                                        messageId: message.id,
                                        emoji: reaction.emoji,
                                      },
                                    })
                                  }
                                />
                              }
                            >
                              {reaction.emoji} {reaction.users.length}
                            </TooltipTrigger>
                            <TooltipPopup>{reactors}</TooltipPopup>
                          </Tooltip>
                        );
                      })}
                      <span className="inline-flex items-center gap-0.5">
                        {QUICK_REACTIONS.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            className="rounded p-0.5 text-xs hover:bg-accent"
                            onClick={() =>
                              void react({
                                environmentId,
                                input: { threadId, sideThreadId, messageId: message.id, emoji },
                              })
                            }
                          >
                            {emoji}
                          </button>
                        ))}
                      </span>
                      <button
                        type="button"
                        className="ml-auto inline-flex items-center gap-1 text-3xs text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          setReplyToId(message.id);
                          setEditingId(null);
                        }}
                      >
                        <CornerUpLeftIcon className="size-3" /> Reply
                      </button>
                      {own ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-3xs text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            setEditingId(message.id);
                            setReplyToId(null);
                            setDraft(message.text);
                          }}
                        >
                          <PencilIcon className="size-3" /> Edit
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          {sideThread?.archivedAt ? (
            <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
              This discussion is archived.
            </p>
          ) : (
            <div className="space-y-2 border-t pt-3">
              {quote && editingId === null ? (
                <SideThreadPendingQuote
                  quote={quote}
                  source={parentMessages.get(quote.messageId)}
                  onRemove={() => onQuoteChange(null)}
                />
              ) : null}
              {replyToId || editingId ? (
                <div className="flex items-center gap-2 rounded-lg bg-muted px-2 py-1 text-xs text-muted-foreground">
                  {editingId ? (
                    <PencilIcon className="size-3" />
                  ) : (
                    <CornerUpLeftIcon className="size-3" />
                  )}
                  <span className="truncate">
                    {editingId ? "Editing message" : "Replying to message"}
                  </span>
                  <button
                    type="button"
                    className="ml-auto"
                    onClick={() => {
                      setReplyToId(null);
                      setEditingId(null);
                    }}
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ) : null}
              <SideThreadComposerInput
                value={draft}
                onValueChange={(value) => {
                  setDraft(value);
                  notifyPresenceTyping(environmentId, threadId);
                }}
                onSubmit={() => void send()}
                suggestionsEnabled={editingId === null}
                environmentId={environmentId}
                threadId={threadId}
                team={team}
                currentSubject={currentSubject}
                onPasteImages={editingId === null ? addImages : undefined}
                onThreadLinkPicked={(link) =>
                  setThreadLinks((current) => [
                    ...current.filter((entry) => entry.threadId !== link.threadId),
                    link,
                  ])
                }
              />
              {attachments.length > 0 ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <CheckIcon className="size-3" /> {attachments.length} attachment(s)
                  <button type="button" className="ml-auto" onClick={() => setAttachments([])}>
                    Clear
                  </button>
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <div className="relative flex items-center gap-1">
                  {!editingId ? (
                    <>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(event) => {
                          addImages([...(event.target.files ?? [])]);
                          event.target.value = "";
                        }}
                      />
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <ImageIcon className="size-3" /> Image
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => setGifPickerOpen((current) => !current)}
                      >
                        GIF
                      </Button>
                      <GifPicker
                        open={gifPickerOpen}
                        onClose={() => setGifPickerOpen(false)}
                        onPick={(gif) => {
                          setAttachments((current) => [
                            ...current.filter((attachment) => attachment.type !== "gif"),
                            giphyAttachment(gif),
                          ]);
                          setGifPickerOpen(false);
                        }}
                      />
                      <span className="inline-flex items-center gap-1 text-3xs text-muted-foreground">
                        <SmilePlusIcon className="size-3" /> reactions enabled
                      </span>
                    </>
                  ) : null}
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    sideThread === null ||
                    sending ||
                    (draft.trim().length === 0 && attachments.length === 0)
                  }
                  onClick={() => void send()}
                >
                  <SendIcon className="size-3.5" />
                  {editingId ? "Save" : "Send"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </SheetPopup>
    </Sheet>
  );
}
