import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atomRegistry";

export type WsConnectionUiState = "connected" | "connecting" | "error" | "offline" | "reconnecting";
export type WsReconnectPhase = "attempting" | "idle" | "waiting";

export const WS_RECONNECT_INITIAL_DELAY_MS = 1_000;
export const WS_RECONNECT_BACKOFF_FACTOR = 2;
/**
 * Ceiling for the reconnect backoff. Deliberately low: a reconnect attempt
 * costs one WebSocket handshake, while every second spent waiting is a
 * second of visible downtime once the network has actually recovered. The
 * team uses Campfire over high-latency / flaky links (remote Mac mini), and
 * browsers only fire `online` for interface-level changes — a link that
 * degrades and recovers without an interface flap gives us no signal, so
 * the periodic retry IS the recovery path and must stay frequent. Retries
 * continue at this cadence forever; there is no terminal "exhausted" state.
 */
export const WS_RECONNECT_MAX_DELAY_MS = 15_000;
/**
 * Minimum continuous time spent in the `connected` phase before we treat a
 * subsequent drop as a fresh failure cycle (reset the reconnect counter).
 *
 * Without this guard the counter resets to 0 on every TCP-level WebSocket
 * open, so a flaky link that gets the socket open for 200ms before another
 * drop ends up re-attempting at the initial 1 s delay forever — visible to
 * the user as continuous "Reconnecting…" churn. With the stability window,
 * repeated quick drops keep the exponential backoff growing
 * (1 s → 2 s → 4 s → 8 s …) so the cycle naturally slows down until either
 * the network actually recovers or the user manually retries. Sized to the
 * backoff ceiling: a link that stays up longer than the worst-case retry
 * wait has proven it can outlive a full backoff cycle.
 */
export const WS_RECONNECT_STABILITY_THRESHOLD_MS = 15_000;

/**
 * Outages shorter than this never raise a toast — the reconnect happens fast
 * enough that the user wouldn't notice the drop without a notification.
 *
 * The reconnect-success toast was firing for every drop, including the
 * sub-second TCP blips a flaky residential/Tailscale link produces several
 * times a minute. Each toast lingered for ~8s, so the user effectively saw
 * uninterrupted "Reconnected to …" notifications even while productively
 * working through the socket. We swallow those brief drops here; a real
 * outage (>5 s without a connection) still surfaces normally so a
 * persistent network issue stays visible.
 */
export const WS_BRIEF_OUTAGE_THRESHOLD_MS = 5_000;

/**
 * The "Reconnecting…" loading toast is deferred this long after the
 * disconnect — if the link recovers before the delay elapses, the toast
 * is never created in the first place. Two reasons:
 *
 * 1. UX. Sub-second drops are invisible to the user, so a momentary toast
 *    flash is pure noise. Deferring removes that flash.
 * 2. base-ui's `ToastTitle` `useIsoLayoutEffect` (1.4.1) cycles its
 *    `setTitleId(id)` on every re-render of the toast root because the
 *    setter from context isn't memoized. Mounting + unmounting toasts in
 *    rapid succession crashes a flaky session with a React "Maximum update
 *    depth exceeded" error in `ToastTitle`. Never mounting the toast for
 *    brief drops dodges the trigger without depending on a library fix.
 */
export const WS_RECONNECTING_TOAST_DELAY_MS = 2_000;

/**
 * Compute whether the most recent reconnect should suppress the success
 * toast. Returns `true` when the gap between `previousDisconnectedAt` and
 * `connectedAt` is short enough to qualify as a brief blip (see
 * {@link WS_BRIEF_OUTAGE_THRESHOLD_MS}). Pure helper so the policy is
 * exercised in `WebSocketConnectionSurface.logic.test`.
 */
export function isBriefWsOutage(
  previousDisconnectedAt: string | null,
  connectedAt: string | null,
): boolean {
  if (!previousDisconnectedAt || !connectedAt) return false;
  const disconnectMs = Date.parse(previousDisconnectedAt);
  const connectMs = Date.parse(connectedAt);
  if (Number.isNaN(disconnectMs) || Number.isNaN(connectMs)) return false;
  const outageMs = connectMs - disconnectMs;
  return outageMs >= 0 && outageMs < WS_BRIEF_OUTAGE_THRESHOLD_MS;
}

export interface WsConnectionStatus {
  readonly attemptCount: number;
  readonly closeCode: number | null;
  readonly closeReason: string | null;
  readonly connectionLabel: string | null;
  readonly connectedAt: string | null;
  readonly disconnectedAt: string | null;
  readonly hasConnected: boolean;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly nextRetryAt: string | null;
  readonly online: boolean;
  readonly phase: "idle" | "connecting" | "connected" | "disconnected";
  readonly reconnectAttemptCount: number;
  readonly reconnectPhase: WsReconnectPhase;
  readonly socketUrl: string | null;
}

const INITIAL_WS_CONNECTION_STATUS = Object.freeze<WsConnectionStatus>({
  attemptCount: 0,
  closeCode: null,
  closeReason: null,
  connectionLabel: null,
  connectedAt: null,
  disconnectedAt: null,
  hasConnected: false,
  lastError: null,
  lastErrorAt: null,
  nextRetryAt: null,
  online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
  phase: "idle",
  reconnectAttemptCount: 0,
  reconnectPhase: "idle",
  socketUrl: null,
});

export const wsConnectionStatusAtom = Atom.make(INITIAL_WS_CONNECTION_STATUS).pipe(
  Atom.keepAlive,
  Atom.withLabel("ws-connection-status"),
);

function isoNow() {
  return new Date().toISOString();
}

function updateWsConnectionStatus(
  updater: (current: WsConnectionStatus) => WsConnectionStatus,
): WsConnectionStatus {
  const nextStatus = updater(getWsConnectionStatus());
  appAtomRegistry.set(wsConnectionStatusAtom, nextStatus);
  return nextStatus;
}

export interface WsConnectionMetadata {
  readonly connectionLabel?: string | null;
  readonly versionMismatchHint?: string | null;
}

function normalizeConnectionLabel(label: string | null | undefined): string | null {
  const normalized = label?.trim();
  return normalized ? normalized : null;
}

export function getWsConnectionStatus(): WsConnectionStatus {
  return appAtomRegistry.get(wsConnectionStatusAtom);
}

export function getWsConnectionUiState(status: WsConnectionStatus): WsConnectionUiState {
  if (status.phase === "connected") {
    return "connected";
  }

  if (!status.online && (status.disconnectedAt !== null || status.phase === "disconnected")) {
    return "offline";
  }

  if (!status.hasConnected) {
    return status.phase === "disconnected" ? "error" : "connecting";
  }

  return "reconnecting";
}

export function recordWsConnectionAttempt(
  socketUrl: string,
  metadata?: WsConnectionMetadata,
): WsConnectionStatus {
  const connectionLabel = normalizeConnectionLabel(metadata?.connectionLabel);
  return updateWsConnectionStatus((current) => ({
    ...current,
    attemptCount: current.attemptCount + 1,
    connectionLabel: connectionLabel ?? current.connectionLabel,
    nextRetryAt: null,
    phase: "connecting",
    reconnectAttemptCount: current.reconnectAttemptCount + 1,
    reconnectPhase: "attempting",
    socketUrl,
  }));
}

export function recordWsConnectionOpened(metadata?: WsConnectionMetadata): WsConnectionStatus {
  const connectionLabel = normalizeConnectionLabel(metadata?.connectionLabel);
  // Note: we intentionally do *not* reset `reconnectAttemptCount` here.
  // The TCP-level open succeeding doesn't yet prove the link is stable —
  // a flaky network often surfaces a successful open followed by an
  // immediate drop. The counter is reset in `applyDisconnectState` only
  // when the previous "connected" interval lasted at least
  // `WS_RECONNECT_STABILITY_THRESHOLD_MS`, so brief opens correctly
  // continue the exponential backoff cycle rather than restarting it.
  return updateWsConnectionStatus((current) => ({
    ...current,
    closeCode: null,
    closeReason: null,
    connectionLabel: connectionLabel ?? current.connectionLabel,
    connectedAt: isoNow(),
    disconnectedAt: null,
    hasConnected: true,
    nextRetryAt: null,
    phase: "connected",
    reconnectPhase: "idle",
  }));
}

function appendHint(message: string | null | undefined, hint: string | null | undefined) {
  const normalizedMessage = message?.trim();
  const normalizedHint = hint?.trim();
  if (!normalizedMessage) {
    return normalizedHint ? `Hint: ${normalizedHint}` : null;
  }
  return normalizedHint ? `${normalizedMessage} Hint: ${normalizedHint}` : normalizedMessage;
}

export function recordWsConnectionErrored(
  message?: string | null,
  metadata?: WsConnectionMetadata,
): WsConnectionStatus {
  return updateWsConnectionStatus((current) =>
    applyDisconnectState(current, {
      lastError:
        appendHint(message, metadata?.versionMismatchHint) ??
        appendHint(current.lastError, metadata?.versionMismatchHint),
      lastErrorAt: isoNow(),
    }),
  );
}

export function recordWsConnectionClosed(
  details?: {
    readonly code?: number;
    readonly reason?: string;
  },
  metadata?: WsConnectionMetadata,
): WsConnectionStatus {
  const connectionLabel = normalizeConnectionLabel(metadata?.connectionLabel);
  return updateWsConnectionStatus((current) =>
    applyDisconnectState(
      current,
      {
        closeCode: details?.code ?? current.closeCode,
        closeReason:
          appendHint(details?.reason, metadata?.versionMismatchHint) ??
          appendHint(current.closeReason, metadata?.versionMismatchHint),
      },
      connectionLabel === null ? undefined : { connectionLabel },
    ),
  );
}

export function setBrowserOnlineStatus(online: boolean): WsConnectionStatus {
  return updateWsConnectionStatus((current) => ({
    ...current,
    online,
  }));
}

export function resetWsReconnectBackoff(): WsConnectionStatus {
  return updateWsConnectionStatus((current) => ({
    ...current,
    nextRetryAt: null,
    reconnectAttemptCount: 0,
    reconnectPhase: "idle",
  }));
}

export function resetWsConnectionStateForTests(): void {
  appAtomRegistry.set(wsConnectionStatusAtom, INITIAL_WS_CONNECTION_STATUS);
}

export function useWsConnectionStatus(): WsConnectionStatus {
  return useAtomValue(wsConnectionStatusAtom);
}

export function getWsReconnectDelayMsForRetry(retryIndex: number): number | null {
  if (!Number.isInteger(retryIndex) || retryIndex < 0) {
    return null;
  }

  // Exponential up to the ceiling, then flat forever — reconnect attempts
  // never stop. `2 ** retryIndex` overflows to Infinity for large indexes,
  // which Math.min safely clamps back to the ceiling.
  return Math.min(
    Math.round(WS_RECONNECT_INITIAL_DELAY_MS * WS_RECONNECT_BACKOFF_FACTOR ** retryIndex),
    WS_RECONNECT_MAX_DELAY_MS,
  );
}

function applyDisconnectState(
  current: WsConnectionStatus,
  updates: Partial<
    Pick<WsConnectionStatus, "closeCode" | "closeReason" | "lastError" | "lastErrorAt">
  >,
  metadata?: WsConnectionMetadata,
): WsConnectionStatus {
  const disconnectedAt = current.disconnectedAt ?? isoNow();

  // Stability check: if the previous `connected` interval lasted at least
  // the stability threshold, treat this disconnect as the start of a fresh
  // failure cycle (counter reset to 0). Otherwise the previous open was
  // unstable — keep the running counter so the next retry delay continues
  // to grow. This is the difference between a one-off blip after an hour
  // of productive work (resets) and continuous churn on a flaky link
  // (keeps slowing down). `connectedAt` is set in
  // `recordWsConnectionOpened`; missing or unparseable means we don't have
  // evidence of stability and we preserve the counter to be safe.
  const connectedAtMs =
    current.connectedAt !== null ? Date.parse(current.connectedAt) : Number.NaN;
  const lastConnectedDurationMs = Number.isNaN(connectedAtMs) ? 0 : Date.now() - connectedAtMs;
  const wasStable =
    current.phase === "connected" &&
    lastConnectedDurationMs >= WS_RECONNECT_STABILITY_THRESHOLD_MS;
  const reconnectAttemptCount = wasStable ? 0 : current.reconnectAttemptCount;

  const nextRetryDelayMs =
    current.nextRetryAt !== null
      ? null
      : getWsReconnectDelayMsForRetry(Math.max(0, reconnectAttemptCount - 1));

  return {
    ...current,
    ...updates,
    connectionLabel: normalizeConnectionLabel(metadata?.connectionLabel) ?? current.connectionLabel,
    disconnectedAt,
    nextRetryAt:
      nextRetryDelayMs === null
        ? current.nextRetryAt
        : new Date(Date.now() + nextRetryDelayMs).toISOString(),
    phase: "disconnected",
    reconnectAttemptCount,
    reconnectPhase: "waiting",
  };
}
