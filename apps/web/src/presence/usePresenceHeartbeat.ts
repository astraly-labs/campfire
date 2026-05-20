/**
 * Heartbeat loop — feeds the server with the current user's focus every few
 * seconds plus on every transition (route change, drawer open/close, typing
 * start/stop).
 *
 * Mount once at the `_chat` layout. The hook is intentionally write-only:
 * `usePresenceStore` is the read side and lives in a separate file.
 */
import type {
  EnvironmentApi,
  PresenceHeartbeatInput,
  PresenceTypingFocus,
  SideThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { realtimeLog } from "../rpc/realtimeLog";
import { deriveSideThreadId, useSideThreadStore } from "../sidethread/sideThreadStore";

/** Keepalive cadence. Must be < server PRESENCE_TTL_MS (12 s) by a fat margin. */
const HEARTBEAT_INTERVAL_MS = 4_000;
/**
 * How long we keep treating a user as "typing" after their last keystroke.
 * Slightly shorter than the server's TYPING_TTL_MS so we never have a state
 * where the server clears the flag before the client does.
 */
const TYPING_INDICATOR_TTL_MS = 3_000;

// Module-level typing state — using a ref avoids re-rendering every keystroke
// just to update a transient flag, which would tank the composer's perf.
let lastTypingFocus: PresenceTypingFocus | null = null;
let lastTypingAt = 0;

// Module-level mirror of the currently-mounted heartbeat focus, so non-hook
// callers (e.g. WS resubscribe handlers) can fire an out-of-band heartbeat
// to nudge the server into republishing the presence snapshot.
let lastKnownFocus: { parentThreadId: ThreadId | null; sideThreadId: SideThreadId | null } = {
  parentThreadId: null,
  sideThreadId: null,
};

export async function sendPresenceHeartbeatNow(api: EnvironmentApi): Promise<void> {
  await api.presence.heartbeat({
    parentThreadId: lastKnownFocus.parentThreadId,
    sideThreadId: lastKnownFocus.sideThreadId,
    typingIn: readTypingFocus(Date.now()),
  });
}

/**
 * Called by composers on every keystroke (or input event) to mark the user
 * as typing in a specific surface. Cheap — just two module-level writes,
 * no React work. The heartbeat loop picks the value up on its next tick;
 * surface transitions (parent → side) also trigger an immediate flush so
 * the typing pulse jumps without waiting up to 4 s.
 */
export function notifyTyping(focus: PresenceTypingFocus): void {
  lastTypingFocus = focus;
  lastTypingAt = Date.now();
}

/**
 * Called when the composer is cleared (post-send) so the typing indicator
 * collapses immediately instead of lingering for TYPING_INDICATOR_TTL_MS.
 */
export function clearTyping(focus: PresenceTypingFocus): void {
  if (lastTypingFocus === focus) {
    lastTypingFocus = null;
    lastTypingAt = 0;
  }
}

function readTypingFocus(now: number): PresenceTypingFocus | null {
  if (lastTypingFocus === null) return null;
  if (now - lastTypingAt > TYPING_INDICATOR_TTL_MS) {
    lastTypingFocus = null;
    return null;
  }
  return lastTypingFocus;
}

export interface PresenceHeartbeatHookInput {
  readonly api: EnvironmentApi | undefined;
  readonly parentThreadId: ThreadId | null;
}

/**
 * Mount once. Each render:
 *   · captures the latest focus (parent + drawer + typing) into a ref so the
 *     interval has fresh data without restarting,
 *   · fires a heartbeat *immediately* when focus changes (so other clients
 *     see the avatar move within 100 ms, not on the next 4 s tick),
 *   · runs an interval ticker that re-sends the same heartbeat to refresh
 *     the server-side TTL.
 *
 * We don't await heartbeats — there's no UX dependent on the result, and
 * dropped heartbeats are recovered by the next tick.
 */
export function usePresenceHeartbeat(input: PresenceHeartbeatHookInput): void {
  const { api, parentThreadId } = input;
  const openParentThreadId = useSideThreadStore((state) => state.openParentThreadId);
  const sideThreadId = openParentThreadId
    ? (deriveSideThreadId(openParentThreadId) as SideThreadId)
    : null;

  // The interval below reads the latest focus from this ref so we don't need
  // to tear down and rebuild the timer every time the route changes.
  const focusRef = useRef<{
    parentThreadId: ThreadId | null;
    sideThreadId: SideThreadId | null;
  }>({ parentThreadId, sideThreadId });
  focusRef.current = { parentThreadId, sideThreadId };
  // Mirror the focus to module-level so out-of-band callers (e.g. the WS
  // resubscribe handler in usePresenceLiveSync) can fire a heartbeat without
  // re-reading React state.
  lastKnownFocus = { parentThreadId, sideThreadId };

  // Fire an immediate heartbeat when the surface changes — typing-focus
  // changes are handled by the interval (max 1 s delay because the typing
  // window is short anyway, see HEARTBEAT_INTERVAL_MS / TYPING_INDICATOR_TTL_MS).
  useEffect(() => {
    if (!api) return;
    const body: PresenceHeartbeatInput = {
      parentThreadId,
      sideThreadId,
      typingIn: readTypingFocus(Date.now()),
    };
    void api.presence.heartbeat(body).catch((error) => {
      realtimeLog("presence", "heartbeat.failed-on-focus-change", {
        error: error instanceof Error ? error.message : String(error),
        parentThreadId,
        sideThreadId,
      });
      // Swallow — the next tick will retry.
    });
  }, [api, parentThreadId, sideThreadId]);

  useEffect(() => {
    if (!api) return;
    const id = window.setInterval(() => {
      const { parentThreadId: pTid, sideThreadId: sTid } = focusRef.current;
      const body: PresenceHeartbeatInput = {
        parentThreadId: pTid,
        sideThreadId: sTid,
        typingIn: readTypingFocus(Date.now()),
      };
      void api.presence.heartbeat(body).catch((error) => {
        realtimeLog("presence", "heartbeat.failed-on-tick", {
          error: error instanceof Error ? error.message : String(error),
        });
        // Swallow — heartbeat loss is non-fatal; the server TTL handles it.
      });
    }, HEARTBEAT_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [api]);
}

// Test hooks — exposed for unit tests so they can reset module state.
export const __testPresenceTyping = {
  reset: () => {
    lastTypingFocus = null;
    lastTypingAt = 0;
  },
  read: (now: number) => readTypingFocus(now),
  TYPING_INDICATOR_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
};
