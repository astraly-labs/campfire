import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getWsConnectionStatus,
  getWsReconnectDelayMsForRetry,
  getWsConnectionUiState,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
  setBrowserOnlineStatus,
  WS_RECONNECT_MAX_ATTEMPTS,
  WS_RECONNECT_STABILITY_THRESHOLD_MS,
} from "./wsConnectionState";

describe("wsConnectionState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-03T20:30:00.000Z"));
    resetWsConnectionStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats a disconnected browser as offline once the websocket drops", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    recordWsConnectionClosed({ code: 1006, reason: "offline" });
    setBrowserOnlineStatus(false);

    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("offline");
  });

  it("stays in the initial connecting state until the first disconnect", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");

    expect(getWsConnectionStatus()).toMatchObject({
      attemptCount: 1,
      hasConnected: false,
      phase: "connecting",
    });
    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("connecting");
  });

  it("schedules the next retry after a failed websocket attempt", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws", {
      connectionLabel: "Remote Mac",
    });
    recordWsConnectionErrored("Unable to connect to the T3 server WebSocket.");

    const firstRetryDelayMs = getWsReconnectDelayMsForRetry(0);
    if (firstRetryDelayMs === null) {
      throw new Error("Expected an initial retry delay.");
    }

    expect(getWsConnectionStatus()).toMatchObject({
      connectionLabel: "Remote Mac",
      nextRetryAt: new Date(Date.now() + firstRetryDelayMs).toISOString(),
      reconnectAttemptCount: 1,
      reconnectPhase: "waiting",
    });
  });

  it("adds a version mismatch hint to websocket errors when metadata includes one", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws", {
      connectionLabel: "Remote Mac",
    });
    recordWsConnectionErrored("Unable to connect to the T3 server WebSocket.", {
      versionMismatchHint: "Version mismatch. Try syncing the client and server.",
    });

    expect(getWsConnectionStatus()).toMatchObject({
      lastError:
        "Unable to connect to the T3 server WebSocket. Hint: Version mismatch. Try syncing the client and server.",
    });
  });

  it("adds a version mismatch hint to websocket close reasons when metadata includes one", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    recordWsConnectionClosed(
      { code: 1006, reason: "socket closed" },
      {
        versionMismatchHint: "Version mismatch. Try syncing the client and server.",
      },
    );

    expect(getWsConnectionStatus()).toMatchObject({
      closeReason: "socket closed Hint: Version mismatch. Try syncing the client and server.",
    });
  });

  it("marks the reconnect cycle as exhausted after the final attempt fails", () => {
    for (let attempt = 0; attempt < WS_RECONNECT_MAX_ATTEMPTS; attempt += 1) {
      recordWsConnectionAttempt("ws://localhost:3020/ws");
      recordWsConnectionErrored("Unable to connect to the T3 server WebSocket.");
    }

    expect(getWsConnectionStatus()).toMatchObject({
      nextRetryAt: null,
      reconnectAttemptCount: WS_RECONNECT_MAX_ATTEMPTS,
      reconnectPhase: "exhausted",
    });
  });

  it("keeps the backoff growing when the socket drops within the stability window", () => {
    // Cycle 1: attempt → connecting → open (brief) → close fast → still bad
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    // 200 ms into the "connected" interval — well under the stability threshold
    vi.advanceTimersByTime(200);
    recordWsConnectionClosed({ code: 1006, reason: "network blip" });

    const afterFirstCycle = getWsConnectionStatus();
    const expectedFirstDelay = getWsReconnectDelayMsForRetry(0);
    expect(afterFirstCycle).toMatchObject({
      reconnectAttemptCount: 1,
      reconnectPhase: "waiting",
    });
    expect(expectedFirstDelay).not.toBeNull();

    // Cycle 2: simulate the retry firing → attempt → connecting → open → close fast again.
    // The counter must KEEP growing here — the previous open was unstable.
    vi.advanceTimersByTime(expectedFirstDelay ?? 0);
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    vi.advanceTimersByTime(500);
    recordWsConnectionClosed({ code: 1006, reason: "network blip" });

    const afterSecondCycle = getWsConnectionStatus();
    const expectedSecondDelay = getWsReconnectDelayMsForRetry(1);
    expect(afterSecondCycle.reconnectAttemptCount).toBe(2);
    expect(afterSecondCycle.nextRetryAt).toBe(
      new Date(Date.now() + (expectedSecondDelay ?? 0)).toISOString(),
    );
    // The second delay should be strictly larger than the first — proof that
    // the backoff is not collapsing back to 1 s on each transient open.
    expect(expectedSecondDelay ?? 0).toBeGreaterThan(expectedFirstDelay ?? 0);
  });

  it("resets the backoff after the connection has been stable for the threshold", () => {
    // Failed attempt 1: counter goes to 1.
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionErrored("Unable to connect to the T3 server WebSocket.");
    expect(getWsConnectionStatus().reconnectAttemptCount).toBe(1);

    // Retry succeeds and stays connected past the stability threshold.
    vi.advanceTimersByTime(getWsReconnectDelayMsForRetry(0) ?? 0);
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    // Important: the counter must not be reset on open — `applyDisconnectState`
    // is the only place that decides whether the previous interval was stable.
    expect(getWsConnectionStatus().reconnectAttemptCount).toBe(2);

    // Spend more than the stability threshold in the connected phase.
    vi.advanceTimersByTime(WS_RECONNECT_STABILITY_THRESHOLD_MS + 1_000);
    recordWsConnectionClosed({ code: 1006, reason: "later blip" });

    // Counter resets to 0; next delay drops back to the initial value.
    const afterDrop = getWsConnectionStatus();
    expect(afterDrop).toMatchObject({
      reconnectAttemptCount: 0,
      nextRetryAt: new Date(Date.now() + (getWsReconnectDelayMsForRetry(0) ?? 0)).toISOString(),
      reconnectPhase: "waiting",
    });
  });
});
