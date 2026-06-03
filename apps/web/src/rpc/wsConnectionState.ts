import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atomRegistry";

export type WsConnectionUiState = "connected" | "connecting" | "error" | "offline" | "reconnecting";
export type WsReconnectPhase = "attempting" | "exhausted" | "idle" | "waiting";

export const WS_RECONNECT_INITIAL_DELAY_MS = 1_000;
export const WS_RECONNECT_BACKOFF_FACTOR = 2;
export const WS_RECONNECT_MAX_DELAY_MS = 64_000;
export const WS_RECONNECT_MAX_RETRIES = 7;
export const WS_RECONNECT_MAX_ATTEMPTS = WS_RECONNECT_MAX_RETRIES + 1;
/**
 * Minimum continuous time spent in the `connected` phase before we treat a
 * subsequent drop as a fresh failure cycle (reset the reconnect counter).
 *
 * Without this guard the counter resets to 0 on every TCP-level WebSocket
 * open, so a flaky link that gets the socket open for 200ms before another
 * drop ends up re-attempting at the initial 1 s delay forever — visible to
 * the user as continuous "Reconnecting…" churn. With a 30 s stability
 * window, repeated quick drops keep the exponential backoff growing
 * (1 s → 2 s → 4 s → 8 s …) so the cycle naturally slows down until either
 * the network actually recovers or the user manually retries.
 */
export const WS_RECONNECT_STABILITY_THRESHOLD_MS = 30_000;

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
  readonly reconnectMaxAttempts: number;
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
  reconnectMaxAttempts: WS_RECONNECT_MAX_ATTEMPTS,
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
  if (!Number.isInteger(retryIndex) || retryIndex < 0 || retryIndex >= WS_RECONNECT_MAX_RETRIES) {
    return null;
  }

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
    current.nextRetryAt !== null || current.reconnectPhase === "exhausted"
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
    reconnectPhase:
      current.reconnectPhase === "waiting" || current.reconnectPhase === "exhausted"
        ? current.reconnectPhase
        : nextRetryDelayMs === null
          ? "exhausted"
          : "waiting",
  };
}
