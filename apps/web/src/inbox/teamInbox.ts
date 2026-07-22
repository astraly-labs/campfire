import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  SideThreadShellMessagePreview,
  SideThreadShellSummary,
} from "@t3tools/contracts";

export interface TeamInboxItem {
  readonly thread: EnvironmentThreadShell;
  readonly discussion: SideThreadShellSummary;
  readonly preview: SideThreadShellMessagePreview;
  readonly isMention: boolean;
  readonly unread: boolean;
}

function isAfter(left: string, right: string | null): boolean {
  return right === null || left > right;
}

export function deriveTeamInboxItems(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly currentSubject: string | null;
}): ReadonlyArray<TeamInboxItem> {
  if (!input.environmentId || !input.currentSubject) return [];

  const items: TeamInboxItem[] = [];
  for (const thread of input.threads) {
    if (thread.environmentId !== input.environmentId || thread.archivedAt !== null) continue;
    const discussion = thread.teamDiscussion;
    const latestMessage = discussion?.latestMessage;
    if (!discussion || discussion.archivedAt !== null || !latestMessage) continue;

    const participates = discussion.participants.some(
      (participant) => participant.subject === input.currentSubject,
    );
    const latestMention = discussion.latestMentions
      .filter((message) =>
        message.mentions.some((mention) => mention.subject === input.currentSubject),
      )
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!participates && !latestMention) continue;

    const lastReadAt =
      discussion.readBy.find((marker) => marker.user.subject === input.currentSubject)
        ?.lastReadAt ?? null;
    const latestUnread =
      latestMessage.author.subject !== input.currentSubject &&
      isAfter(latestMessage.createdAt, lastReadAt);
    const mentionUnread =
      latestMention !== undefined &&
      latestMention.author.subject !== input.currentSubject &&
      isAfter(latestMention.createdAt, lastReadAt);

    items.push({
      thread,
      discussion,
      preview: mentionUnread ? latestMention : latestMessage,
      isMention: mentionUnread,
      unread: mentionUnread || latestUnread,
    });
  }

  return items.toSorted(
    (left, right) =>
      right.preview.createdAt.localeCompare(left.preview.createdAt) ||
      left.thread.id.localeCompare(right.thread.id),
  );
}

export function countUnreadTeamInboxItems(items: ReadonlyArray<TeamInboxItem>): number {
  return items.reduce((total, item) => total + Number(item.unread), 0);
}
