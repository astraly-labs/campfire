// @effect-diagnostics globalTimers:off
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeTimers from "node:timers";

import {
  ProviderDriverKind,
  ProviderSession,
  ProviderTurnStartResult,
  type CodexSettings,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { ProviderAdapterRequestError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import {
  CODEX_PROVIDER_HOST_PROTOCOL_VERSION,
  decodeProviderHostServerMessage,
  type ProviderHostConfigurePayload,
  type ProviderHostOperation,
  type ProviderHostServerMessage,
} from "./Protocol.ts";

const PROVIDER = ProviderDriverKind.make("codex");
const INITIAL_CONNECT_TIMEOUT_MS = 5_000;
const RECONNECT_DELAY_MS = 250;

const decodeProviderSession = Schema.decodeUnknownSync(ProviderSession);
const decodeProviderSessions = Schema.decodeUnknownSync(Schema.Array(ProviderSession));
const decodeTurnStartResult = Schema.decodeUnknownSync(ProviderTurnStartResult);

class ProviderHostRemoteError extends Error {
  readonly tag: string;

  constructor(tag: string, message: string) {
    super(message);
    this.name = "ProviderHostRemoteError";
    this.tag = tag;
  }
}

interface PendingRequest {
  readonly frame: {
    readonly type: "command";
    readonly protocolVersion: 1;
    readonly instanceId: ProviderInstanceId;
    lease: number;
    readonly requestId: string;
    readonly commandId: string;
    readonly operation: ProviderHostOperation;
    readonly payload: unknown;
  };
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => NodeTimers.setTimeout(resolve, milliseconds));

class CodexProviderHostClient {
  private socket: NodeNet.Socket | undefined;
  private lease = 0;
  private closed = false;
  private connectedOnce = false;
  private connectPromise: Promise<void> | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly socketPath: string;
  private readonly instanceId: ProviderInstanceId;
  private readonly configurePayload: ProviderHostConfigurePayload;
  private readonly onEvent: (sequence: number, event: ProviderRuntimeEvent) => void;

  constructor(
    socketPath: string,
    instanceId: ProviderInstanceId,
    configurePayload: ProviderHostConfigurePayload,
    onEvent: (sequence: number, event: ProviderRuntimeEvent) => void,
  ) {
    this.socketPath = socketPath;
    this.instanceId = instanceId;
    this.configurePayload = configurePayload;
    this.onEvent = onEvent;
  }

  start(): Promise<void> {
    return this.ensureConnected(INITIAL_CONNECT_TIMEOUT_MS);
  }

  private write(socket: NodeNet.Socket, value: unknown): void {
    socket.write(`${JSON.stringify(value)}\n`);
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = NodeNet.createConnection(this.socketPath);
      socket.setNoDelay(true);
      this.socket = socket;
      let buffer = "";
      let settled = false;
      let handshakeRequestId: string | undefined;

      const failHandshake = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      socket.once("connect", () => {
        this.write(socket, {
          type: "subscribe",
          protocolVersion: CODEX_PROVIDER_HOST_PROTOCOL_VERSION,
          instanceId: this.instanceId,
        });
      });

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim().length === 0) continue;

          let message: ProviderHostServerMessage;
          try {
            message = decodeProviderHostServerMessage(JSON.parse(line));
          } catch {
            socket.destroy(new Error("Invalid response from Codex provider host."));
            return;
          }

          if (message.type === "subscribed") {
            this.lease = message.lease;
            handshakeRequestId = NodeCrypto.randomUUID();
            this.write(socket, {
              type: "command",
              protocolVersion: CODEX_PROVIDER_HOST_PROTOCOL_VERSION,
              instanceId: this.instanceId,
              lease: this.lease,
              requestId: handshakeRequestId,
              commandId: NodeCrypto.randomUUID(),
              operation: "configure",
              payload: this.configurePayload,
            });
            continue;
          }

          if (message.type === "event") {
            if (message.lease !== this.lease) continue;
            this.onEvent(message.sequence, message.event);
            this.write(socket, {
              type: "ack",
              protocolVersion: CODEX_PROVIDER_HOST_PROTOCOL_VERSION,
              instanceId: this.instanceId,
              lease: this.lease,
              sequence: message.sequence,
            });
            continue;
          }

          if (message.requestId === handshakeRequestId) {
            if (!message.ok) {
              failHandshake(new ProviderHostRemoteError(message.error.tag, message.error.message));
              socket.destroy();
              return;
            }
            if (!settled) {
              settled = true;
              this.connectedOnce = true;
              for (const pending of this.pending.values()) {
                pending.frame.lease = this.lease;
                this.write(socket, pending.frame);
              }
              resolve();
            }
            continue;
          }

          const pending = this.pending.get(message.requestId);
          if (!pending) continue;
          this.pending.delete(message.requestId);
          if (message.ok) {
            pending.resolve(message.result);
          } else {
            pending.reject(new ProviderHostRemoteError(message.error.tag, message.error.message));
          }
        }
      });

      socket.once("error", (error) => failHandshake(error));
      socket.once("close", () => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.connectPromise = undefined;
        }
        failHandshake(new Error("Codex provider-host socket closed."));
        if (this.connectedOnce && !this.closed) {
          NodeTimers.setTimeout(
            () => void this.ensureConnected(Number.POSITIVE_INFINITY).catch(() => undefined),
            RECONNECT_DELAY_MS,
          );
        }
      });
    });
  }

  private async ensureConnected(timeoutMs: number): Promise<void> {
    let attemptsRemaining = Number.isFinite(timeoutMs)
      ? Math.max(1, Math.ceil(timeoutMs / RECONNECT_DELAY_MS))
      : Number.POSITIVE_INFINITY;
    while (!this.closed) {
      if (this.socket && !this.socket.destroyed && this.connectPromise === undefined) return;
      if (!this.connectPromise) {
        this.connectPromise = this.connectOnce().finally(() => {
          if (!this.socket || this.socket.destroyed) this.connectPromise = undefined;
        });
      }
      try {
        await this.connectPromise;
        this.connectPromise = undefined;
        return;
      } catch (error) {
        attemptsRemaining -= 1;
        if (attemptsRemaining <= 0) throw error;
        await delay(RECONNECT_DELAY_MS);
      }
    }
    throw new Error("Codex provider-host client is closed.");
  }

  async request(operation: ProviderHostOperation, payload: unknown): Promise<unknown> {
    if (this.closed) throw new Error("Codex provider-host client is closed.");
    const requestId = NodeCrypto.randomUUID();
    const frame: PendingRequest["frame"] = {
      type: "command",
      protocolVersion: CODEX_PROVIDER_HOST_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      lease: this.lease,
      requestId,
      commandId: NodeCrypto.randomUUID(),
      operation,
      payload,
    };
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, { frame, resolve, reject });
    });
    try {
      await this.ensureConnected(Number.POSITIVE_INFINITY);
      const socket = this.socket;
      if (!socket) throw new Error("Codex provider-host socket is unavailable.");
      frame.lease = this.lease;
      this.write(socket, frame);
    } catch (error) {
      this.pending.delete(requestId);
      throw error;
    }
    return result;
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
    const error = new Error("Codex provider-host client detached.");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

const requestError = (operation: string, error: unknown): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: `provider-host/${operation}`,
    detail: error instanceof Error ? error.message : String(error),
    cause: error,
  });

export const makeRemoteCodexAdapter = Effect.fn("makeRemoteCodexAdapter")(function* (input: {
  readonly socketPath: string;
  readonly instanceId: ProviderInstanceId;
  readonly config: CodexSettings;
  readonly environment: ProviderInstanceEnvironment;
}) {
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const runtimeContext = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(runtimeContext);
  const client = new CodexProviderHostClient(
    input.socketPath,
    input.instanceId,
    { config: input.config, environment: input.environment },
    (_sequence, event) => {
      runFork(Queue.offer(events, event));
    },
  );
  yield* Effect.tryPromise({
    try: () => client.start(),
    catch: (error) => requestError("connect", error),
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => client.close()).pipe(Effect.andThen(Queue.shutdown(events))),
  );

  const request = <A>(
    operation: ProviderHostOperation,
    payload: unknown,
    decode: (value: unknown) => A,
  ): Effect.Effect<A, ProviderAdapterRequestError> =>
    Effect.tryPromise({
      try: () => client.request(operation, payload),
      catch: (error) => requestError(operation, error),
    }).pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => decode(value),
          catch: (error) => requestError(operation, error),
        }),
      ),
    );

  const voidResult = () => undefined;
  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      processOwnership: "external",
    },
    startSession: (sessionInput: ProviderSessionStartInput) =>
      request(
        "startSession",
        {
          input: sessionInput,
          mcpSession: McpProviderSession.readMcpProviderSession(sessionInput.threadId),
        },
        decodeProviderSession,
      ),
    sendTurn: (turnInput: ProviderSendTurnInput) =>
      request("sendTurn", turnInput, decodeTurnStartResult),
    interruptTurn: (threadId: ThreadId, turnId?: TurnId) =>
      request("interruptTurn", { threadId, ...(turnId ? { turnId } : {}) }, voidResult),
    respondToRequest: (threadId, requestId, decision) =>
      request("respondToRequest", { threadId, requestId, decision }, voidResult),
    respondToUserInput: (threadId, requestId, answers) =>
      request("respondToUserInput", { threadId, requestId, answers }, voidResult),
    stopSession: (threadId) => request("stopSession", { threadId }, voidResult),
    listSessions: () => request("listSessions", {}, decodeProviderSessions),
    hasSession: (threadId) =>
      request("hasSession", { threadId }, (value) => {
        if (typeof value !== "boolean") throw new Error("Expected a boolean hasSession response.");
        return value;
      }),
    readThread: (threadId) =>
      request("readThread", { threadId }, (value) => value as ProviderThreadSnapshot),
    rollbackThread: (threadId, numTurns) =>
      request("rollbackThread", { threadId, numTurns }, (value) => value as ProviderThreadSnapshot),
    stopAll: () => request("stopAll", {}, voidResult),
    streamEvents: Stream.fromQueue(events),
  };
  return adapter;
});
