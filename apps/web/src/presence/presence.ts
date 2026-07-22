import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PresenceEntry, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";

import { useAtomCommand } from "../state/use-atom-command";
import { presenceEnvironment } from "../state/presence";

const HEARTBEAT_INTERVAL_MS = 2_000;
const TYPING_TTL_MS = 3_000;

interface TypingState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly lastTypedAt: number;
}

let typingState: TypingState | null = null;
const typingStartedListeners = new Set<() => void>();

function isTypingIn(environmentId: EnvironmentId, threadId: ThreadId, now = Date.now()): boolean {
  return (
    typingState !== null &&
    typingState.environmentId === environmentId &&
    typingState.threadId === threadId &&
    now - typingState.lastTypedAt <= TYPING_TTL_MS
  );
}

export function notifyPresenceTyping(environmentId: EnvironmentId, threadId: ThreadId): void {
  const wasTyping = isTypingIn(environmentId, threadId);
  typingState = { environmentId, threadId, lastTypedAt: Date.now() };
  if (!wasTyping) {
    for (const listener of typingStartedListeners) listener();
  }
}

export function viewersForThread(
  entries: ReadonlyArray<PresenceEntry>,
  threadId: ThreadId,
): ReadonlyArray<PresenceEntry> {
  return entries
    .filter((entry) => entry.threadId === threadId)
    .toSorted(
      (left, right) =>
        left.user.displayName.localeCompare(right.user.displayName) ||
        left.user.subject.localeCompare(right.user.subject),
    );
}

export function useThreadPresence(environmentId: EnvironmentId, threadId: ThreadId) {
  const result = useAtomValue(presenceEnvironment.snapshot({ environmentId, input: {} }));
  const snapshot = Option.getOrNull(AsyncResult.value(result));
  const viewers = useMemo(
    () => viewersForThread(snapshot?.entries ?? [], threadId),
    [snapshot, threadId],
  );
  const heartbeat = useAtomCommand(presenceEnvironment.heartbeat, {
    reportDefect: false,
    reportFailure: false,
  });

  useEffect(() => {
    let disposed = false;
    const send = () => {
      if (disposed) return;
      void heartbeat({
        environmentId,
        input: {
          threadId,
          typing: isTypingIn(environmentId, threadId),
        },
      });
    };
    send();
    typingStartedListeners.add(send);
    const interval = window.setInterval(send, HEARTBEAT_INTERVAL_MS);
    return () => {
      disposed = true;
      typingStartedListeners.delete(send);
      window.clearInterval(interval);
    };
  }, [environmentId, heartbeat, threadId]);

  return viewers;
}

export const presenceTiming = {
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  typingTtlMs: TYPING_TTL_MS,
} as const;
