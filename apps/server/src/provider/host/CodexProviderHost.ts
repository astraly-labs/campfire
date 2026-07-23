// @effect-diagnostics globalTimers:off
import * as NodeNet from "node:net";
import * as NodeTimers from "node:timers";

import type {
  CodexSettings,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { makeEventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import { makeCodexAdapter } from "../Layers/CodexAdapter.ts";
import {
  CODEX_PROVIDER_HOST_PROTOCOL_VERSION,
  decodeConfigurePayload,
  decodeInterruptTurnPayload,
  decodeProviderHostClientMessage,
  decodeRespondToRequestPayload,
  decodeRespondToUserInputPayload,
  decodeRollbackThreadPayload,
  decodeSendTurnPayload,
  decodeStartSessionPayload,
  decodeThreadPayload,
  type ProviderHostClientMessage,
  type ProviderHostConfigurePayload,
  type ProviderHostServerMessage,
} from "./Protocol.ts";

const ACK_COMMIT_GRACE_MS = 30_000;
const MAX_COMMAND_RECEIPTS = 10_000;

type CodexAdapter = ProviderAdapterShape<ProviderAdapterError>;

export interface HostedCodexAdapter {
  readonly adapter: CodexAdapter;
  readonly close: () => Promise<void>;
}

export interface CodexProviderHostFactoryInput {
  readonly instanceId: ProviderInstanceId;
  readonly config: CodexSettings;
  readonly environment: ProviderInstanceEnvironment;
}

export interface CodexProviderHostServerOptions {
  readonly socketPath: string;
  readonly createAdapter: (input: CodexProviderHostFactoryInput) => Promise<HostedCodexAdapter>;
  readonly ackCommitGraceMs?: number;
  readonly prepareSocket?: () => Promise<void>;
  readonly secureSocket?: () => Promise<void>;
  readonly cleanupSocket?: () => Promise<void>;
}

export interface CodexProviderHostServer {
  readonly socketPath: string;
  readonly close: () => Promise<void>;
}

interface CommandResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly tag: string;
    readonly message: string;
  };
}

interface InstanceState {
  lease: number;
  socket: NodeNet.Socket | undefined;
  adapter: HostedCodexAdapter | undefined;
  adapterConfigKey: string | undefined;
  pendingConfiguration: ProviderHostConfigurePayload | undefined;
  eventFiber: Fiber.Fiber<void, never> | undefined;
  nextSequence: number;
  committedAck: number;
  pendingAck: number;
  ackTimer: NodeJS.Timeout | undefined;
  readonly outbox: Map<number, ProviderRuntimeEvent>;
  readonly commands: Map<string, Promise<CommandResponse>>;
}

const makeInstanceState = (): InstanceState => ({
  lease: 0,
  socket: undefined,
  adapter: undefined,
  adapterConfigKey: undefined,
  pendingConfiguration: undefined,
  eventFiber: undefined,
  nextSequence: 1,
  committedAck: 0,
  pendingAck: 0,
  ackTimer: undefined,
  outbox: new Map(),
  commands: new Map(),
});

const writeMessage = (socket: NodeNet.Socket, message: ProviderHostServerMessage): void => {
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify(message)}\n`);
  }
};

const errorResponse = (error: unknown): CommandResponse => {
  if (error && typeof error === "object") {
    const candidate = error as { readonly _tag?: unknown; readonly message?: unknown };
    return {
      ok: false,
      error: {
        tag: typeof candidate._tag === "string" ? candidate._tag : "ProviderHostError",
        message: typeof candidate.message === "string" ? candidate.message : String(error),
      },
    };
  }
  return {
    ok: false,
    error: {
      tag: "ProviderHostError",
      message: String(error),
    },
  };
};

const configKey = (payload: ProviderHostConfigurePayload): string => JSON.stringify(payload);

const isUnixSocketReachable = (socketPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = NodeNet.createConnection(socketPath);
    const finish = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });

export async function startCodexProviderHostServer(
  options: CodexProviderHostServerOptions,
): Promise<CodexProviderHostServer> {
  if (await isUnixSocketReachable(options.socketPath)) {
    throw new Error(`A Codex provider host is already listening at '${options.socketPath}'.`);
  }
  await options.prepareSocket?.();

  const states = new Map<ProviderInstanceId, InstanceState>();
  const sockets = new Set<NodeNet.Socket>();
  const ackCommitGraceMs = options.ackCommitGraceMs ?? ACK_COMMIT_GRACE_MS;

  const getState = (instanceId: ProviderInstanceId): InstanceState => {
    const existing = states.get(instanceId);
    if (existing) return existing;
    const created = makeInstanceState();
    states.set(instanceId, created);
    return created;
  };

  const publishEvent = (instanceId: ProviderInstanceId, event: ProviderRuntimeEvent): void => {
    const state = getState(instanceId);
    const sequence = state.nextSequence++;
    state.outbox.set(sequence, event);
    if (state.socket) {
      writeMessage(state.socket, {
        type: "event",
        protocolVersion: CODEX_PROVIDER_HOST_PROTOCOL_VERSION,
        instanceId,
        lease: state.lease,
        sequence,
        event,
      });
    }
  };

  const closeAdapter = async (state: InstanceState): Promise<void> => {
    if (state.eventFiber) {
      await Effect.runPromise(Fiber.interrupt(state.eventFiber).pipe(Effect.asVoid));
      state.eventFiber = undefined;
    }
    if (state.adapter) {
      await state.adapter.close();
      state.adapter = undefined;
      state.adapterConfigKey = undefined;
    }
  };

  const configure = async (
    instanceId: ProviderInstanceId,
    payload: ProviderHostConfigurePayload,
  ): Promise<void> => {
    const state = getState(instanceId);
    const nextKey = configKey(payload);
    if (state.adapter && state.adapterConfigKey === nextKey) {
      state.pendingConfiguration = undefined;
      return;
    }

    if (state.adapter) {
      const sessions = await Effect.runPromise(state.adapter.adapter.listSessions());
      if (sessions.length > 0) {
        state.pendingConfiguration = payload;
        return;
      }
      await closeAdapter(state);
    }

    const hosted = await options.createAdapter({
      instanceId,
      config: payload.config,
      environment: payload.environment,
    });
    state.adapter = hosted;
    state.adapterConfigKey = nextKey;
    state.pendingConfiguration = undefined;
    state.eventFiber = Effect.runFork(
      Stream.runForEach(hosted.adapter.streamEvents, (event) =>
        Effect.sync(() => publishEvent(instanceId, event)),
      ),
    );
  };

  const executeCommand = async (
    instanceId: ProviderInstanceId,
    operation: ProviderHostClientMessage & { readonly type: "command" },
  ): Promise<CommandResponse> => {
    try {
      if (operation.operation === "configure") {
        await configure(instanceId, decodeConfigurePayload(operation.payload));
        return { ok: true, result: null };
      }

      const state = getState(instanceId);
      if (operation.operation === "startSession" && state.pendingConfiguration) {
        await configure(instanceId, state.pendingConfiguration);
      }
      const hosted = state.adapter;
      if (!hosted) {
        throw new Error(`Codex instance '${instanceId}' is not configured in the provider host.`);
      }
      const adapter = hosted.adapter;
      switch (operation.operation) {
        case "startSession": {
          const payload = decodeStartSessionPayload(operation.payload);
          if (payload.mcpSession) McpProviderSession.setMcpProviderSession(payload.mcpSession);
          const result = await Effect.runPromise(adapter.startSession(payload.input));
          return { ok: true, result };
        }
        case "sendTurn":
          return {
            ok: true,
            result: await Effect.runPromise(
              adapter.sendTurn(decodeSendTurnPayload(operation.payload)),
            ),
          };
        case "interruptTurn": {
          const payload = decodeInterruptTurnPayload(operation.payload);
          await Effect.runPromise(adapter.interruptTurn(payload.threadId, payload.turnId));
          return { ok: true, result: null };
        }
        case "respondToRequest": {
          const payload = decodeRespondToRequestPayload(operation.payload);
          await Effect.runPromise(
            adapter.respondToRequest(payload.threadId, payload.requestId, payload.decision),
          );
          return { ok: true, result: null };
        }
        case "respondToUserInput": {
          const payload = decodeRespondToUserInputPayload(operation.payload);
          await Effect.runPromise(
            adapter.respondToUserInput(payload.threadId, payload.requestId, payload.answers),
          );
          return { ok: true, result: null };
        }
        case "stopSession": {
          const { threadId } = decodeThreadPayload(operation.payload);
          await Effect.runPromise(adapter.stopSession(threadId));
          McpProviderSession.clearMcpProviderSession(threadId);
          if (state.pendingConfiguration) {
            await configure(instanceId, state.pendingConfiguration);
          }
          return { ok: true, result: null };
        }
        case "listSessions":
          return { ok: true, result: await Effect.runPromise(adapter.listSessions()) };
        case "hasSession": {
          const { threadId } = decodeThreadPayload(operation.payload);
          return { ok: true, result: await Effect.runPromise(adapter.hasSession(threadId)) };
        }
        case "readThread": {
          const { threadId } = decodeThreadPayload(operation.payload);
          return { ok: true, result: await Effect.runPromise(adapter.readThread(threadId)) };
        }
        case "rollbackThread": {
          const payload = decodeRollbackThreadPayload(operation.payload);
          return {
            ok: true,
            result: await Effect.runPromise(
              adapter.rollbackThread(payload.threadId, payload.numTurns),
            ),
          };
        }
        case "stopAll":
          await Effect.runPromise(adapter.stopAll());
          if (state.pendingConfiguration) {
            await configure(instanceId, state.pendingConfiguration);
          }
          return { ok: true, result: null };
      }
    } catch (error) {
      return errorResponse(error);
    }
  };

  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on("error", () => {
      // Connection churn is expected while the backend is being replaced.
    });
    let buffer = "";
    let subscribed: { readonly instanceId: ProviderInstanceId; readonly lease: number } | undefined;

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length === 0) continue;

        let message: ProviderHostClientMessage;
        try {
          message = decodeProviderHostClientMessage(JSON.parse(line));
        } catch {
          socket.destroy(new Error("Invalid Codex provider-host protocol message."));
          return;
        }

        if (message.type === "subscribe") {
          const state = getState(message.instanceId);
          if (state.ackTimer) {
            NodeTimers.clearTimeout(state.ackTimer);
            state.ackTimer = undefined;
            state.pendingAck = state.committedAck;
          }
          state.lease += 1;
          state.socket?.destroy();
          state.socket = socket;
          subscribed = { instanceId: message.instanceId, lease: state.lease };
          writeMessage(socket, {
            type: "subscribed",
            protocolVersion: CODEX_PROVIDER_HOST_PROTOCOL_VERSION,
            instanceId: message.instanceId,
            lease: state.lease,
          });
          for (const [sequence, event] of state.outbox) {
            if (sequence <= state.committedAck) continue;
            writeMessage(socket, {
              type: "event",
              protocolVersion: CODEX_PROVIDER_HOST_PROTOCOL_VERSION,
              instanceId: message.instanceId,
              lease: state.lease,
              sequence,
              event,
            });
          }
          continue;
        }

        const state = getState(message.instanceId);
        if (
          !subscribed ||
          subscribed.instanceId !== message.instanceId ||
          subscribed.lease !== message.lease ||
          state.socket !== socket
        ) {
          socket.destroy(new Error("Stale Codex provider-host lease."));
          return;
        }

        if (message.type === "ack") {
          state.pendingAck = Math.max(state.pendingAck, message.sequence);
          if (state.ackTimer) NodeTimers.clearTimeout(state.ackTimer);
          state.ackTimer = NodeTimers.setTimeout(() => {
            state.committedAck = Math.max(state.committedAck, state.pendingAck);
            for (const sequence of state.outbox.keys()) {
              if (sequence <= state.committedAck) state.outbox.delete(sequence);
            }
            state.ackTimer = undefined;
          }, ackCommitGraceMs);
          continue;
        }

        let response = state.commands.get(message.commandId);
        if (!response) {
          response = executeCommand(message.instanceId, message);
          state.commands.set(message.commandId, response);
          if (state.commands.size > MAX_COMMAND_RECEIPTS) {
            const oldest = state.commands.keys().next().value;
            if (oldest !== undefined) state.commands.delete(oldest);
          }
        }
        void response.then((result) => {
          writeMessage(
            socket,
            result.ok
              ? {
                  type: "response",
                  protocolVersion: CODEX_PROVIDER_HOST_PROTOCOL_VERSION,
                  requestId: message.requestId,
                  ok: true,
                  result: result.result,
                }
              : {
                  type: "response",
                  protocolVersion: CODEX_PROVIDER_HOST_PROTOCOL_VERSION,
                  requestId: message.requestId,
                  ok: false,
                  error: result.error ?? {
                    tag: "ProviderHostError",
                    message: "Unknown provider-host failure.",
                  },
                },
          );
        });
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      if (!subscribed) return;
      const state = states.get(subscribed.instanceId);
      if (state?.socket === socket) state.socket = undefined;
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.socketPath);
  });
  await options.secureSocket?.();
  let closed = false;

  return {
    socketPath: options.socketPath,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const state of states.values()) {
        if (state.ackTimer) NodeTimers.clearTimeout(state.ackTimer);
      }
      for (const socket of sockets) socket.destroy();
      await Promise.all(Array.from(states.values(), closeAdapter));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await options.cleanupSocket?.();
    },
  };
}

export class CodexProviderHostStartupError extends Schema.TaggedErrorClass<CodexProviderHostStartupError>()(
  "CodexProviderHostStartupError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Codex provider host failed to start: ${this.detail}`;
  }
}

export const runCodexProviderHost = Effect.fn("runCodexProviderHost")(function* (
  config: ServerConfig["Service"],
  socketPath: string,
) {
  const runtimeContext = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | ServerConfig
  >();
  const runPromise = Effect.runPromiseWith(runtimeContext);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const nativeEventLogger = yield* makeEventNdjsonLogger(config.providerEventLogPath, {
    stream: "native",
  });
  yield* Effect.addFinalizer(() => nativeEventLogger?.close() ?? Effect.void);

  const createAdapter = async (
    input: CodexProviderHostFactoryInput,
  ): Promise<HostedCodexAdapter> => {
    const scope = await runPromise(Scope.make());
    const adapter = await runPromise(
      makeCodexAdapter(input.config, {
        instanceId: input.instanceId,
        environment: mergeProviderInstanceEnvironment(input.environment),
        ...(nativeEventLogger ? { nativeEventLogger } : {}),
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    return {
      adapter,
      close: () => runPromise(Scope.close(scope, Exit.void)),
    };
  };

  const host = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        startCodexProviderHostServer({
          socketPath,
          createAdapter,
          prepareSocket: () =>
            runPromise(
              fs
                .makeDirectory(path.dirname(socketPath), { recursive: true })
                .pipe(Effect.andThen(fs.remove(socketPath, { force: true }))),
            ),
          secureSocket: () => runPromise(fs.chmod(socketPath, 0o600)),
          cleanupSocket: () => runPromise(fs.remove(socketPath, { force: true })),
        }),
      catch: (cause) =>
        new CodexProviderHostStartupError({
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }),
    (server) => Effect.promise(() => server.close()),
  );
  yield* Effect.logInfo("Codex provider host listening", {
    socketPath: host.socketPath,
    baseDir: config.baseDir,
  });
  return yield* Effect.never;
});
