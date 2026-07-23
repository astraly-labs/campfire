import {
  SideThreadId,
  type SideThread,
  type SideThreadMessage,
  type SideThreadReadMarker,
  type ThreadId,
} from "@t3tools/contracts";

const THREAD_SIDE_THREAD_PREFIX = "thread:";

/** One deterministic human discussion channel for every agent thread. */
export function sideThreadIdForThread(threadId: ThreadId): SideThreadId {
  return SideThreadId.make(`${THREAD_SIDE_THREAD_PREFIX}${threadId}`);
}

export function isSideThreadIdForThread(sideThreadId: SideThreadId, threadId: ThreadId): boolean {
  return sideThreadId === sideThreadIdForThread(threadId);
}

function laterMessage(
  current: SideThreadMessage | undefined,
  candidate: SideThreadMessage,
): SideThreadMessage {
  if (current === undefined) return candidate;
  return (candidate.updatedAt ?? candidate.createdAt) >= (current.updatedAt ?? current.createdAt)
    ? candidate
    : current;
}

/**
 * Collapse pre-thread-level SideThreads into the single canonical team discussion.
 *
 * Legacy Campfire builds created one SideThread per selected agent message. This
 * keeps every durable message/read marker while making the projection compatible
 * with the current one-discussion-per-agent-thread invariant.
 */
export function canonicalizeSideThreads(
  threadId: ThreadId,
  sideThreads: ReadonlyArray<SideThread>,
): ReadonlyArray<SideThread> {
  if (sideThreads.length === 0) return [];

  const canonicalId = sideThreadIdForThread(threadId);
  const ordered = [...sideThreads].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const primary = ordered.find((sideThread) => sideThread.id === canonicalId) ?? ordered[0]!;

  const messagesById = new Map<string, SideThreadMessage>();
  const readBySubject = new Map<string, SideThreadReadMarker>();
  for (const sideThread of ordered) {
    for (const message of sideThread.messages) {
      messagesById.set(message.id, laterMessage(messagesById.get(message.id), message));
    }
    for (const marker of sideThread.readBy ?? []) {
      const current = readBySubject.get(marker.user.subject);
      if (current === undefined || marker.lastReadAt >= current.lastReadAt) {
        readBySubject.set(marker.user.subject, marker);
      }
    }
  }

  const anchorMessageId =
    primary.anchorMessageId ??
    ordered.find((sideThread) => sideThread.anchorMessageId !== undefined)?.anchorMessageId;
  const archivedAt = ordered.every((sideThread) => sideThread.archivedAt !== null)
    ? ordered
        .map((sideThread) => sideThread.archivedAt!)
        .sort((left, right) => right.localeCompare(left))[0]!
    : null;
  const messages = [...messagesById.values()].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const readBy = [...readBySubject.values()].sort((left, right) =>
    left.user.subject.localeCompare(right.user.subject),
  );

  return [
    {
      ...primary,
      id: canonicalId,
      ...(anchorMessageId === undefined ? {} : { anchorMessageId }),
      createdAt: ordered[0]!.createdAt,
      updatedAt: ordered
        .map((sideThread) => sideThread.updatedAt)
        .sort((left, right) => right.localeCompare(left))[0]!,
      archivedAt,
      messages,
      ...(readBy.length === 0 ? {} : { readBy }),
    },
  ];
}
