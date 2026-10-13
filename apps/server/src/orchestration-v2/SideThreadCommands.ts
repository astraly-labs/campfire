import type {
  OrchestrationV2ThreadProjection,
  SideThreadCommand,
  SideThreadEvent,
} from "@t3tools/contracts";
import { isSideThreadIdForThread } from "@t3tools/shared/sideThread";

type PlannedSideThreadCommand = { readonly event: SideThreadEvent } | { readonly error: string };

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Called under the thread command lock; the resulting event commits with its receipt. */
export function planSideThreadCommand(input: {
  readonly command: SideThreadCommand;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly linkedThreadExists: boolean;
}): PlannedSideThreadCommand {
  const { command, projection } = input;
  const user = command.collaborationUser;
  if (!user) return { error: "Team discussion requires an authenticated Google account." };
  if (projection.thread.deletedAt !== null || projection.thread.archivedAt !== null) {
    return { error: "This thread cannot accept a side conversation." };
  }
  if (!isSideThreadIdForThread(command.sideThreadId, command.threadId)) {
    return { error: "This is not the canonical team discussion for this thread." };
  }
  const common = { threadId: command.threadId, sideThreadId: command.sideThreadId };
  const sideThread = projection.sideThreads?.find((side) => side.id === command.sideThreadId);
  if (command.type === "sidethread.create") {
    if (sideThread)
      return {
        event: { type: "sidethread.imported", payload: { threadId: command.threadId, sideThread } },
      };
    if (
      command.anchorMessageId !== undefined &&
      !projection.messages.some((message) => message.id === command.anchorMessageId)
    ) {
      return { error: "The anchor message no longer exists." };
    }
    return {
      event: {
        type: "sidethread.created",
        payload: {
          ...common,
          ...(command.anchorMessageId === undefined
            ? {}
            : { anchorMessageId: command.anchorMessageId }),
          createdBy: user,
          createdAt: command.createdAt,
        },
      },
    };
  }
  if (!sideThread) return { error: "This team discussion does not exist." };
  if (command.type === "sidethread.mark-read") {
    const previous = sideThread.readBy?.find((marker) => marker.user.subject === user.subject);
    const lastReadAt =
      previous && previous.lastReadAt > command.lastReadAt
        ? previous.lastReadAt
        : command.lastReadAt;
    return {
      event: {
        type: "sidethread.marked-read",
        payload: { ...common, user, lastReadAt, createdAt: command.createdAt },
      },
    };
  }
  if (sideThread.archivedAt !== null) return { error: "This team discussion is archived." };
  if (command.type === "sidethread.archive") {
    return {
      event: { type: "sidethread.archived", payload: { ...common, archivedAt: command.createdAt } },
    };
  }
  if (command.type === "sidethread.message.post") {
    if (sideThread.messages.some((message) => message.id === command.messageId))
      return { error: "This message already exists." };
    if (sideThread.messages.length >= 500)
      return { error: "This team discussion reached the 500 message limit." };
    if (!command.text.trim() && !command.attachments?.length)
      return { error: "A message needs text or an attachment." };
    if ((command.attachments?.length ?? 0) > 8)
      return { error: "A message cannot contain more than 8 attachments." };
    if (
      command.attachments?.some(
        (attachment) =>
          attachment.type === "gif" &&
          (!isHttpsUrl(attachment.url) || !isHttpsUrl(attachment.previewUrl)),
      )
    )
      return { error: "GIF attachments must use HTTPS URLs." };
    const mentions = [
      ...new Map((command.mentions ?? []).map((mention) => [mention.subject, mention])).values(),
    ];
    if (mentions.length > 20) return { error: "A message cannot mention more than 20 teammates." };
    if (
      command.quotedMessageId !== undefined &&
      !projection.messages.some((message) => message.id === command.quotedMessageId)
    )
      return { error: "The quoted message no longer exists." };
    if (
      command.replyToSideThreadMessageId !== undefined &&
      !sideThread.messages.some((message) => message.id === command.replyToSideThreadMessageId)
    )
      return { error: "The reply target no longer exists." };
    if (command.linkedRef !== undefined && !input.linkedThreadExists)
      return { error: "The linked thread no longer exists." };
    return {
      event: {
        type: "sidethread.message-posted",
        payload: {
          ...common,
          messageId: command.messageId,
          author: user,
          text: command.text,
          mentions,
          ...(command.quotedMessageId === undefined
            ? {}
            : { quotedMessageId: command.quotedMessageId }),
          ...(command.attachments === undefined ? {} : { attachments: command.attachments }),
          ...(command.linkedRef === undefined ? {} : { linkedRef: command.linkedRef }),
          ...(command.replyToSideThreadMessageId === undefined
            ? {}
            : { replyToSideThreadMessageId: command.replyToSideThreadMessageId }),
          createdAt: command.createdAt,
        },
      },
    };
  }
  const message = sideThread.messages.find((candidate) => candidate.id === command.messageId);
  if (!message) return { error: "This message no longer exists." };
  if (command.type === "sidethread.message.edit") {
    if (message.author.subject !== user.subject)
      return { error: "Only the original Google account can edit this message." };
    return {
      event: {
        type: "sidethread.message-edited",
        payload: {
          ...common,
          messageId: message.id,
          editor: user,
          text: command.text,
          editedAt: command.createdAt,
        },
      },
    };
  }
  const alreadyReacted = message.reactions?.some(
    (reaction) =>
      reaction.emoji === command.emoji &&
      reaction.users.some((candidate) => candidate.subject === user.subject),
  );
  return {
    event: {
      type: "sidethread.message-reacted",
      payload: {
        ...common,
        messageId: message.id,
        user,
        emoji: command.emoji,
        action: alreadyReacted ? "removed" : "added",
        createdAt: command.createdAt,
      },
    },
  };
}
