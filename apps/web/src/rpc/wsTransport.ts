import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcClient } from "effect/unstable/rpc";

import { ClientTracingLive } from "../observability/clientTracing";
import {
  createWsRpcProtocolLayer,
  makeWsRpcProtocolClient,
  type WsProtocolLifecycleHandlers,
  type WsRpcProtocolClient,
  type WsRpcProtocolSocketUrlProvider,
} from "./protocol";
import { realtimeLog } from "./realtimeLog";
import { clearAllTrackedRpcRequests } from "./requestLatencyState";
import { isTransportConnectionErrorMessage } from "./transportError";
import { getWsConnectionStatus } from "./wsConnectionState";

interface SubscribeOptions {
  readonly retryDelay?: Duration.Input;
  readonly onResubscribe?: () => void;
  readonly tag?: string;
  /**
   * Fires once when the subscription terminates due to a non-transport
   * (i.e. domain / RPC-level) error — e.g. server-side "Thread X was not
   * found". After this fires, the subscription will not auto-retry.
   *
   * Transport disconnect errors are handled separately via the reconnect
   * loop and do NOT invoke this callback.
   */
  readonly onError?: (error: unknown) => void;
}

/**
 * How a unary request behaves when it fails with a transport-class error
 * (socket dropped mid-request, ping timeout, open-then-immediate-close):
 *
 * - `"wait-for-reconnect"` (default): re-issue the request once the transport
 *   reports a connected phase again, waiting out the reconnect backoff in
 *   between. This is what makes "click send during a network blip" simply
 *   work on flaky links instead of erroring after a few blind retries while
 *   the reconnect loop is still waiting out an 8 s backoff window.
 * - `"brief"`: the legacy behavior — a few quick blind retries (~4 s total).
 *   For non-idempotent, latency-sensitive calls (terminal keystrokes) where
 *   replaying input long after the user typed it would be worse than
 *   dropping it.
 * - `"none"`: a single attempt. For fire-and-forget calls re-issued on a
 *   timer anyway (presence heartbeats) — queueing those during an outage
 *   would replay a stale burst at reconnect for zero benefit.
 */
export type RequestRetryMode = "brief" | "none" | "wait-for-reconnect";

interface RequestOptions {
  readonly retry?: RequestRetryMode;
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = Duration.millis(250);
const NOOP: () => void = () => undefined;

/**
 * Maximum number of attempts for a `"brief"`-mode unary RPC request before we
 * propagate the transport error to the caller. Picked to be small enough that
 * a permanently broken link surfaces quickly, large enough that a flaky
 * residential link's sub-second TCP blips are absorbed without the caller
 * noticing.
 */
const REQUEST_MAX_ATTEMPTS = 4;

/**
 * Delay between retried `"brief"`-mode attempts when the previous one failed
 * with a transport-class error. The first retry waits this long; each
 * subsequent retry doubles the wait, capped at a sensible ceiling so a
 * multi-second outage still recovers within a typical user-perceptible
 * "loading" window.
 */
const REQUEST_RETRY_INITIAL_DELAY_MS = 250;
const REQUEST_RETRY_MAX_DELAY_MS = 2_000;

/**
 * Upper bound on how long a `"wait-for-reconnect"` request will wait, across
 * all reconnect cycles, before surfacing the transport error. Generous on
 * purpose: while the request waits, the reconnect toast is already telling
 * the user what is happening, and a queued command landing after a 60 s
 * outage is far better than a lost one. Bounded so a genuinely dead server
 * does not hold UI promises open forever.
 */
const REQUEST_WAIT_FOR_RECONNECT_DEADLINE_MS = 90_000;

/**
 * Attempt cap for `"wait-for-reconnect"` mode. Each attempt normally costs a
 * full reconnect cycle, so this mostly guards against a pathological server
 * that accepts sockets and instantly drops every request.
 */
const REQUEST_WAIT_FOR_RECONNECT_MAX_ATTEMPTS = 12;

/** Poll cadence while waiting for the transport to report `connected`. */
const REQUEST_WAIT_POLL_INTERVAL_MS = 250;

/**
 * Small settle delay after the transport reports `connected` before the
 * request is re-issued, so the RPC handshake has a moment to finish and the
 * retry does not race the socket open.
 */
const REQUEST_WAIT_RECONNECT_SETTLE_MS = 250;

interface TransportSession {
  readonly clientPromise: Promise<WsRpcProtocolClient>;
  readonly clientScope: Scope.Closeable;
  readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
}

interface StreamRequestStartInfo {
  readonly id: string;
  readonly tag: string;
  readonly stream: boolean;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export class WsTransport {
  private readonly url: WsRpcProtocolSocketUrlProvider;
  private readonly lifecycleHandlers: WsProtocolLifecycleHandlers | undefined;
  private disposed = false;
  private hasReportedTransportDisconnect = false;
  private intentionalCloseDepth = 0;
  private reconnectChain: Promise<void> = Promise.resolve();
  private nextSessionId = 0;
  private activeSessionId = 0;
  private session: TransportSession;
  private lastHeartbeatPongAt = 0;
  private readonly streamRequestStartListeners = new Set<(info: StreamRequestStartInfo) => void>();

  constructor(
    url: WsRpcProtocolSocketUrlProvider,
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
  ) {
    this.url = url;
    this.lifecycleHandlers = lifecycleHandlers;
    this.session = this.createSession();
  }

  async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
    options?: RequestOptions,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const retryMode = options?.retry ?? "wait-for-reconnect";
    const maxAttempts =
      retryMode === "none"
        ? 1
        : retryMode === "brief"
          ? REQUEST_MAX_ATTEMPTS
          : REQUEST_WAIT_FOR_RECONNECT_MAX_ATTEMPTS;
    const deadlineAtMs =
      retryMode === "wait-for-reconnect"
        ? Date.now() + REQUEST_WAIT_FOR_RECONNECT_DEADLINE_MS
        : Number.POSITIVE_INFINITY;

    // Mirrors the retry loop in `subscribe`: a transport-class failure (the
    // WS dropped mid-request, ping timed out, the socket was open then
    // immediately closed) is treated as a transient blip and re-issued
    // against whatever session is current, while a domain-level failure
    // (server-side validation, "thread not found", …) is surfaced
    // immediately so callers do not see slow, magical recoveries from
    // genuine errors. Domain errors are detected via the same
    // `isTransportConnectionErrorMessage` classifier the subscribe loop uses,
    // which keeps the two paths in sync.
    let lastError: unknown;
    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
      if (this.disposed) {
        throw new Error("Transport disposed");
      }
      const session = this.session;
      try {
        const client = await session.clientPromise;
        return await session.runtime.runPromise(Effect.suspend(() => execute(client)));
      } catch (error) {
        lastError = error;
        if (this.disposed) throw error;
        const formattedError = formatErrorMessage(error);
        const isTransportError = isTransportConnectionErrorMessage(formattedError);
        const sessionWasRolled = session !== this.session;
        // Domain errors propagate immediately. A session swap (e.g. an
        // explicit `reconnect()` call ran between dispatch and the failure)
        // is treated as transport-class even if the underlying error text
        // does not match the classifier, since the request never had a
        // chance to land on the new session.
        if (!isTransportError && !sessionWasRolled) {
          throw error;
        }
        if (attemptIndex === maxAttempts - 1) {
          break;
        }
        if (retryMode === "wait-for-reconnect") {
          realtimeLog("transport", "request.wait-for-reconnect", {
            attemptIndex,
            error: formattedError,
          });
          const reconnected = await this.waitUntilConnected(deadlineAtMs);
          if (!reconnected) {
            break;
          }
          continue;
        }
        const delayMs = Math.min(
          REQUEST_RETRY_INITIAL_DELAY_MS * 2 ** attemptIndex,
          REQUEST_RETRY_MAX_DELAY_MS,
        );
        realtimeLog("transport", "request.retry-after-disconnect", {
          attemptIndex,
          delayMs,
          error: formattedError,
        });
        await sleep(delayMs);
      }
    }
    throw lastError;
  }

  /**
   * Resolve `true` once the connection state reports a `connected` phase
   * (plus a short settle delay), or `false` when the deadline passes, the
   * transport is disposed, or the link is in its initial never-connected
   * failure state (a cold connect to a dead server should fail fast rather
   * than hold every startup request open for the full deadline).
   */
  private async waitUntilConnected(deadlineAtMs: number): Promise<boolean> {
    for (;;) {
      if (this.disposed || Date.now() >= deadlineAtMs) {
        return false;
      }
      const status = getWsConnectionStatus();
      if (status.phase === "connected") {
        await sleep(REQUEST_WAIT_RECONNECT_SETTLE_MS);
        return true;
      }
      if (!status.hasConnected && status.phase === "disconnected") {
        return false;
      }
      await sleep(REQUEST_WAIT_POLL_INTERVAL_MS);
    }
  }

  async requestStream<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const session = this.session;
    const client = await session.clientPromise;
    await session.runtime.runPromise(
      Stream.runForEach(connect(client), (value) =>
        Effect.sync(() => {
          try {
            listener(value);
          } catch {
            // Swallow listener errors so the stream can finish cleanly.
          }
        }),
      ),
    );
  }

  subscribe<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: SubscribeOptions,
  ): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    let active = true;
    let hasReceivedValue = false;
    const retryDelayMs = Duration.toMillis(
      Duration.fromInputUnsafe(options?.retryDelay ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS),
    );
    let cancelCurrentStream: () => void = NOOP;

    void (async () => {
      for (;;) {
        if (!active || this.disposed) {
          return;
        }

        const session = this.session;
        try {
          const runningStream = this.runStreamOnSession(
            session,
            connect,
            listener,
            {
              ...(options?.tag === undefined ? {} : { tag: options.tag }),
              ...(hasReceivedValue
                ? {
                    onStarted: () => {
                      realtimeLog("transport", "subscribe.resubscribed", { tag: options?.tag });
                      try {
                        options?.onResubscribe?.();
                      } catch {
                        // Swallow reconnect hook errors so the stream can recover.
                      }
                    },
                  }
                : {}),
            },
            () => active,
            () => {
              this.hasReportedTransportDisconnect = false;
              hasReceivedValue = true;
            },
          );
          cancelCurrentStream = runningStream.cancel;
          await runningStream.completed;
          cancelCurrentStream = NOOP;
        } catch (error) {
          cancelCurrentStream = NOOP;
          if (!active || this.disposed) {
            return;
          }

          if (session !== this.session) {
            continue;
          }

          const formattedError = formatErrorMessage(error);
          if (!isTransportConnectionErrorMessage(formattedError)) {
            console.warn("WebSocket RPC subscription failed", {
              error: formattedError,
            });
            try {
              options?.onError?.(error);
            } catch {
              // Swallow error-hook errors so we always exit the retry loop cleanly.
            }
            return;
          }

          if (!this.hasReportedTransportDisconnect) {
            console.warn("WebSocket RPC subscription disconnected", {
              error: formattedError,
            });
          }
          this.hasReportedTransportDisconnect = true;
          realtimeLog("transport", "subscribe.retry-after-disconnect", {
            tag: options?.tag,
            retryDelayMs,
            error: formattedError,
          });
          await sleep(retryDelayMs);
        }
      }
    })();

    return () => {
      active = false;
      cancelCurrentStream();
    };
  }

  async reconnect() {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const reconnectOperation = this.reconnectChain.then(async () => {
      if (this.disposed) {
        throw new Error("Transport disposed");
      }

      realtimeLog("transport", "reconnect.begin");
      clearAllTrackedRpcRequests();
      this.lastHeartbeatPongAt = 0;
      const previousSession = this.session;
      this.session = this.createSession();
      await this.closeSession(previousSession);
      realtimeLog("transport", "reconnect.session-rebuilt", {
        sessionId: this.activeSessionId,
      });
    });

    this.reconnectChain = reconnectOperation.catch(() => undefined);
    await reconnectOperation;
  }

  isHeartbeatFresh(maxAgeMs = 15_000): boolean {
    return this.lastHeartbeatPongAt > 0 && Date.now() - this.lastHeartbeatPongAt <= maxAgeMs;
  }

  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.closeSession(this.session);
  }

  private closeSession(session: TransportSession) {
    this.intentionalCloseDepth += 1;
    return session.runtime.runPromise(Scope.close(session.clientScope, Exit.void)).finally(() => {
      this.intentionalCloseDepth -= 1;
      session.runtime.dispose();
    });
  }

  private createSession(): TransportSession {
    const sessionId = this.nextSessionId + 1;
    this.nextSessionId = sessionId;
    this.activeSessionId = sessionId;
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        createWsRpcProtocolLayer(this.url, {
          ...this.lifecycleHandlers,
          isActive: () => !this.disposed && this.activeSessionId === sessionId,
          isCloseIntentional: () =>
            this.disposed ||
            this.intentionalCloseDepth > 0 ||
            this.lifecycleHandlers?.isCloseIntentional?.() === true,
          onHeartbeatPong: () => {
            this.lastHeartbeatPongAt = Date.now();
            this.lifecycleHandlers?.onHeartbeatPong?.();
          },
          onRequestStart: (info) => {
            this.lifecycleHandlers?.onRequestStart?.(info);
            if (!info.stream) {
              return;
            }
            for (const listener of this.streamRequestStartListeners) {
              listener(info);
            }
          },
        }),
        ClientTracingLive,
      ),
    );
    const clientScope = runtime.runSync(Scope.make());
    return {
      runtime,
      clientScope,
      clientPromise: runtime.runPromise(Scope.provide(clientScope)(makeWsRpcProtocolClient)),
    };
  }

  private runStreamOnSession<TValue>(
    session: TransportSession,
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    requestStart: {
      readonly tag?: string;
      readonly onStarted?: () => void;
    },
    isActive: () => boolean,
    markValueReceived: () => void,
  ): {
    readonly cancel: () => void;
    readonly completed: Promise<void>;
  } {
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: unknown) => void;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    let requestStartListener: ((info: StreamRequestStartInfo) => void) | null = null;
    if (requestStart.onStarted) {
      requestStartListener = (info) => {
        if (!isActive() || !info.stream) {
          return;
        }
        if (requestStart.tag !== undefined && info.tag !== requestStart.tag) {
          return;
        }
        requestStart.onStarted?.();
        if (requestStartListener) {
          this.streamRequestStartListeners.delete(requestStartListener);
          requestStartListener = null;
        }
      };
      this.streamRequestStartListeners.add(requestStartListener);
    }
    const cancel = session.runtime.runCallback(
      Effect.promise(() => session.clientPromise).pipe(
        Effect.flatMap((client) =>
          Stream.runForEach(connect(client), (value) =>
            Effect.sync(() => {
              if (!isActive()) {
                return;
              }

              markValueReceived();
              try {
                listener(value);
              } catch {
                // Swallow listener errors so the stream stays live.
              }
            }),
          ),
        ),
      ),
      {
        onExit: (exit) => {
          if (requestStartListener) {
            this.streamRequestStartListeners.delete(requestStartListener);
            requestStartListener = null;
          }
          if (Exit.isSuccess(exit)) {
            resolveCompleted();
            return;
          }

          rejectCompleted(Cause.squash(exit.cause));
        },
      },
    );

    return {
      cancel,
      completed,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
