import type {
  CollaborationUser,
  SideThread,
  SideThreadEvent,
  SideThreadShellSummary,
  ThreadId,
} from "@t3tools/contracts";
import { canonicalizeSideThreads, sideThreadIdForThread } from "./sideThread.ts";

export function applySideThreadEvent(
  current: ReadonlyArray<SideThread>,
  event: SideThreadEvent,
): ReadonlyArray<SideThread> {
  const { payload } = event;
  if (event.type === "sidethread.imported") {
    return canonicalizeSideThreads(payload.threadId, [...current, event.payload.sideThread]);
  }
  if (event.type === "sidethread.created") {
    const created = event.payload;
    return canonicalizeSideThreads(created.threadId, [
      ...current,
      {
        id: created.sideThreadId,
        ...(created.anchorMessageId === undefined
          ? {}
          : { anchorMessageId: created.anchorMessageId }),
        createdBy: created.createdBy,
        createdAt: created.createdAt,
        updatedAt: created.createdAt,
        archivedAt: null,
        messages: [],
      },
    ]);
  }
  return canonicalizeSideThreads(payload.threadId, current).map((sideThread) => {
    if (sideThread.id !== event.payload.sideThreadId) return sideThread;
    switch (event.type) {
      case "sidethread.message-posted": {
        const posted = event.payload;
        if (sideThread.messages.some((message) => message.id === posted.messageId))
          return sideThread;
        return {
          ...sideThread,
          updatedAt: posted.createdAt,
          messages: [
            ...sideThread.messages,
            {
              id: posted.messageId,
              author: posted.author,
              text: posted.text,
              createdAt: posted.createdAt,
              ...(posted.mentions === undefined ? {} : { mentions: posted.mentions }),
              ...(posted.quotedMessageId === undefined
                ? {}
                : { quotedMessageId: posted.quotedMessageId }),
              ...(posted.attachments === undefined ? {} : { attachments: posted.attachments }),
              ...(posted.linkedRef === undefined ? {} : { linkedRef: posted.linkedRef }),
              ...(posted.replyToSideThreadMessageId === undefined
                ? {}
                : { replyToSideThreadMessageId: posted.replyToSideThreadMessageId }),
            },
          ],
        };
      }
      case "sidethread.message-reacted": {
        const reacted = event.payload;
        return {
          ...sideThread,
          updatedAt: reacted.createdAt,
          messages: sideThread.messages.map((message) => {
            if (message.id !== reacted.messageId) return message;
            const previous = message.reactions?.find(
              (reaction) => reaction.emoji === reacted.emoji,
            );
            const users = (previous?.users ?? []).filter(
              (user) => user.subject !== reacted.user.subject,
            );
            if (reacted.action === "added") users.push(reacted.user);
            const reactions = (message.reactions ?? []).filter(
              (reaction) => reaction.emoji !== reacted.emoji,
            );
            if (users.length > 0) reactions.push({ emoji: reacted.emoji, users });
            return { ...message, reactions, updatedAt: reacted.createdAt };
          }),
        };
      }
      case "sidethread.message-edited": {
        const edited = event.payload;
        return {
          ...sideThread,
          updatedAt: edited.editedAt,
          messages: sideThread.messages.map((message) =>
            message.id === edited.messageId
              ? {
                  ...message,
                  text: edited.text,
                  updatedAt: edited.editedAt,
                  editedAt: edited.editedAt,
                }
              : message,
          ),
        };
      }
      case "sidethread.marked-read": {
        const read = event.payload;
        const previous = sideThread.readBy?.find(
          (marker) => marker.user.subject === read.user.subject,
        );
        const lastReadAt =
          previous && previous.lastReadAt > read.lastReadAt ? previous.lastReadAt : read.lastReadAt;
        return {
          ...sideThread,
          readBy: [
            ...(sideThread.readBy ?? []).filter(
              (marker) => marker.user.subject !== read.user.subject,
            ),
            { user: read.user, lastReadAt },
          ],
        };
      }
      case "sidethread.archived":
        return {
          ...sideThread,
          archivedAt: event.payload.archivedAt,
          updatedAt: event.payload.archivedAt,
        };
    }
  });
}

export const sideThreadShellSummary = (
  threadId: ThreadId,
  sideThreads: ReadonlyArray<SideThread>,
): SideThreadShellSummary | undefined => {
  const sideThread =
    sideThreads.find((candidate) => candidate.id === sideThreadIdForThread(threadId)) ??
    sideThreads[0];
  if (!sideThread) return undefined;

  const participants = new Map<string, CollaborationUser>();
  const addParticipant = (user: CollaborationUser) => participants.set(user.subject, user);
  addParticipant(sideThread.createdBy);
  for (const message of sideThread.messages) {
    addParticipant(message.author);
    for (const mention of message.mentions ?? []) addParticipant(mention);
    for (const reaction of message.reactions ?? []) {
      for (const user of reaction.users) addParticipant(user);
    }
  }
  for (const marker of sideThread.readBy ?? []) addParticipant(marker.user);

  const previewMessage = (message: SideThread["messages"][number]) => ({
    id: message.id,
    author: message.author,
    text: message.text.slice(0, 500),
    mentions: [...(message.mentions ?? [])],
    hasAttachments: (message.attachments?.length ?? 0) > 0,
    createdAt: message.createdAt,
    ...(message.editedAt ? { editedAt: message.editedAt } : {}),
  });
  const latestMentionBySubject = new Map<string, SideThread["messages"][number]>();
  for (const message of sideThread.messages) {
    for (const mention of message.mentions ?? []) {
      latestMentionBySubject.set(mention.subject, message);
    }
  }

  return {
    id: sideThread.id,
    ...(sideThread.anchorMessageId ? { anchorMessageId: sideThread.anchorMessageId } : {}),
    createdBy: sideThread.createdBy,
    updatedAt: sideThread.updatedAt,
    archivedAt: sideThread.archivedAt,
    messageCount: sideThread.messages.length,
    latestMessage: sideThread.messages.at(-1) ? previewMessage(sideThread.messages.at(-1)!) : null,
    latestMentions: [...latestMentionBySubject.values()].map(previewMessage),
    participants: [...participants.values()],
    readBy: [...(sideThread.readBy ?? [])],
  };
};
