import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  SideThreadMessageId,
  ThreadId,
  type EnvironmentId,
  type MessageId,
  type OrchestrationThread,
  type SideThreadAuthor,
  type SideThreadPostAttachment,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { sideThreadIdForThread } from "@t3tools/shared/sideThread";
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
import { Button } from "../components/ui/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";
import { notifyPresenceTyping } from "../presence/presence";
import { useThreadShells } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { mentionHandleForGoogleUser } from "./takeALook";
import { GifAttachmentInline } from "./GifAttachmentInline";
import { GifPicker } from "./GifPicker";
import { giphyAttachment } from "./giphyClient";

const QUICK_REACTIONS = ["👍", "❤️", "👀", "🎉"] as const;

function mentionsInText(
  text: string,
  team: ReadonlyArray<GoogleTeamMember>,
): ReadonlyArray<SideThreadAuthor> {
  const normalized = text.toLocaleLowerCase();
  return team
    .filter((member) =>
      normalized.includes(`@${mentionHandleForGoogleUser(member).toLocaleLowerCase()}`),
    )
    .map(({ subject, displayName }) => ({ subject, displayName }));
}

function readImage(file: File): Promise<SideThreadPostAttachment> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/") || file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      reject(new Error("Choose an image smaller than 10 MB."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read this image."));
    reader.onload = () =>
      resolve({
        type: "image",
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        dataUrl: String(reader.result),
      });
    reader.readAsDataURL(file);
  });
}

export function SideThreadDrawer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly thread: OrchestrationThread;
  readonly team: ReadonlyArray<GoogleTeamMember>;
  readonly currentSubject: string | null;
  readonly open: boolean;
  readonly contextMessageId: MessageId | null;
  readonly draftPrefill: string;
  readonly onClose: () => void;
}) {
  const {
    environmentId,
    threadId,
    thread,
    team,
    currentSubject,
    open,
    contextMessageId,
    draftPrefill,
    onClose,
  } = props;
  const sideThreadId = sideThreadIdForThread(threadId);
  const sideThread = useMemo(
    () => (thread.sideThreads ?? []).find((entry) => entry.id === sideThreadId) ?? null,
    [sideThreadId, thread.sideThreads],
  );
  const parentMessages = useMemo(
    () => new Map(thread.messages.map((message) => [message.id, message] as const)),
    [thread.messages],
  );
  const allThreads = useThreadShells();
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
  const [gifUrl, setGifUrl] = useState("");
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const [linkedThreadId, setLinkedThreadId] = useState("");

  useEffect(() => {
    if (open && draftPrefill) setDraft(draftPrefill);
  }, [draftPrefill, open]);

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

  const clearComposer = () => {
    setDraft("");
    setReplyToId(null);
    setEditingId(null);
    setAttachments([]);
    setGifUrl("");
    setGifPickerOpen(false);
    setLinkedThreadId("");
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

    const gifAttachment: SideThreadPostAttachment | null = gifUrl.trim()
      ? {
          type: "gif",
          url: gifUrl.trim(),
          previewUrl: gifUrl.trim(),
          width: 0,
          height: 0,
        }
      : null;
    const outgoingAttachments = gifAttachment ? [...attachments, gifAttachment] : attachments;
    if (!text && outgoingAttachments.length === 0) return;
    setSending(true);
    setError(null);
    const mentions = mentionsInText(text, team);
    const result = await post({
      environmentId,
      input: {
        threadId,
        sideThreadId,
        messageId: SideThreadMessageId.make(randomUUID()),
        text,
        ...(mentions.length > 0 ? { mentions } : {}),
        ...(contextMessageId !== null ? { quotedMessageId: contextMessageId } : {}),
        ...(replyToId !== null
          ? { replyToSideThreadMessageId: SideThreadMessageId.make(replyToId) }
          : {}),
        ...(outgoingAttachments.length > 0 ? { attachments: outgoingAttachments } : {}),
        ...(linkedThreadId
          ? {
              linkedRef: { kind: "agent-thread" as const, threadId: ThreadId.make(linkedThreadId) },
            }
          : {}),
      },
    });
    setSending(false);
    if (result._tag === "Success") clearComposer();
    else setError(String(squashAtomCommandFailure(result)));
  };

  return (
    <Sheet open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <SheetPopup side="right" className="sm:max-w-[460px]">
        <SheetHeader className="border-b pb-4">
          <div className="flex items-center gap-2 pr-8">
            <MessageCircleIcon className="size-4 text-muted-foreground" />
            <SheetTitle className="text-base">Team discussion</SheetTitle>
          </div>
          <SheetDescription>One shared side thread for this agent thread.</SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex min-h-0 flex-1 flex-col gap-3 py-4">
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
                const quoted = message.quotedMessageId
                  ? parentMessages.get(message.quotedMessageId)
                  : null;
                const own = message.author.subject === currentSubject;
                const continuesPrevious =
                  sideThread.messages[index - 1]?.author.subject === message.author.subject;
                const continuesNext =
                  sideThread.messages[index + 1]?.author.subject === message.author.subject;
                const timestamp = new Date(message.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });
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
                        <time className="ml-auto text-[10px] text-muted-foreground">
                          {timestamp}
                          {message.editedAt ? " · edited" : ""}
                        </time>
                      </div>
                    ) : (
                      <time className="float-right ml-2 text-[10px] text-muted-foreground">
                        {timestamp}
                        {message.editedAt ? " · edited" : ""}
                      </time>
                    )}
                    {reply ? (
                      <div className="mb-2 truncate rounded-md border-l-2 border-primary/50 bg-background/55 px-2 py-1 text-[11px] text-muted-foreground">
                        Reply to {reply.author.displayName}: {reply.text || "attachment"}
                      </div>
                    ) : null}
                    {quoted ? (
                      <div className="mb-2 line-clamp-2 rounded-md border-l-2 border-sky-400 bg-background/55 px-2 py-1 text-[11px] text-muted-foreground">
                        Agent thread: {quoted.text}
                      </div>
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
                    {message.linkedRef ? (
                      <div className="mt-2 flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground">
                        <LinkIcon className="size-3" /> Linked agent thread:{" "}
                        {message.linkedRef.threadId}
                      </div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100">
                      {(message.reactions ?? []).map((reaction) => (
                        <button
                          key={reaction.emoji}
                          type="button"
                          className="rounded-full border bg-background px-2 py-0.5 text-xs"
                          title={reaction.users.map((user) => user.displayName).join(", ")}
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
                        >
                          {reaction.emoji} {reaction.users.length}
                        </button>
                      ))}
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
                        className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
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
                          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
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
              {!editingId && team.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {team
                    .filter((member) => member.subject !== currentSubject)
                    .map((member) => (
                      <button
                        key={member.subject}
                        type="button"
                        className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                        onClick={() =>
                          setDraft(
                            (current) =>
                              `${current}${current && !current.endsWith(" ") ? " " : ""}@${mentionHandleForGoogleUser(member)} `,
                          )
                        }
                      >
                        @{mentionHandleForGoogleUser(member)}
                      </button>
                    ))}
                </div>
              ) : null}
              {!editingId ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <input
                    value={gifUrl}
                    onChange={(event) => setGifUrl(event.target.value)}
                    placeholder="Paste a GIF URL"
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                  />
                  <select
                    value={linkedThreadId}
                    onChange={(event) => setLinkedThreadId(event.target.value)}
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                  >
                    <option value="">Link another chat…</option>
                    {allThreads
                      .filter(
                        (candidate) =>
                          candidate.environmentId === environmentId && candidate.id !== threadId,
                      )
                      .map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.title}
                        </option>
                      ))}
                  </select>
                </div>
              ) : null}
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
                          const files = [...(event.target.files ?? [])];
                          void Promise.all(files.map(readImage))
                            .then((images) =>
                              setAttachments((current) => [...current, ...images].slice(0, 8)),
                            )
                            .catch((cause: unknown) =>
                              setError(cause instanceof Error ? cause.message : String(cause)),
                            );
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
                          setGifUrl("");
                          setGifPickerOpen(false);
                        }}
                      />
                      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
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
                    (draft.trim().length === 0 && attachments.length === 0 && !gifUrl.trim())
                  }
                  onClick={() => void send()}
                >
                  <SendIcon className="size-3.5" />
                  {editingId ? "Save" : "Send"}
                </Button>
              </div>
            </div>
          )}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
