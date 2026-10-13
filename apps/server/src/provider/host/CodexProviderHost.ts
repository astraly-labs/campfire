// The Unix socket is the process boundary; native I/O stays in this module.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as Net from "node:net";
import * as Timers from "node:timers";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderSessionId,
} from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Protocol from "./Protocol.ts";

const CODEX = ProviderDriverKind.make("codex");
const protocolError = (detail: string, payload?: unknown) =>
  new Adapter.ProviderAdapterProtocolError({
    driver: CODEX,
    detail,
    ...(payload === undefined ? {} : { payload }),
  });
const isAdapterError = Schema.is(Adapter.ProviderAdapterV2Error);
type HostEvent = Extract<Protocol.ServerMessage, { readonly sequence: number }>;
type Command = Extract<Protocol.ClientMessage, { readonly type: "command" }>;
type SessionDescription = typeof Protocol.SessionDescription.Type;

export interface HostedCodexAdapter {
  readonly adapter: Adapter.ProviderAdapterV2["Service"];
  readonly setMcpSessions: (
    sessions: ReadonlyArray<typeof Protocol.McpSession.Type>,
  ) => Promise<void>;
  readonly openSession: (
    input: typeof Protocol.OpenSession.Type,
    runtime: typeof Protocol.EffectiveRuntime.Type | undefined,
    scope: Scope.Closeable,
  ) => Promise<Adapter.ProviderAdapterV2SessionRuntime>;
  readonly close: () => Promise<void>;
}
export interface CodexProviderHostServerOptions {
  readonly socketPath: string;
  readonly createAdapter: (
    input: typeof Protocol.Configuration.Type & { readonly instanceId: ProviderInstanceId },
    hooks: {
      readonly usage: (update: typeof Protocol.UsageLimits.Type) => Effect.Effect<void>;
      readonly continuation: (request: typeof Protocol.Continuation.Type) => Effect.Effect<void>;
    },
  ) => Promise<HostedCodexAdapter>;
  readonly ackCommitGraceMs?: number;
  readonly maxBufferBytes?: number;
  readonly prepareSocket?: () => Promise<void>;
  readonly secureSocket?: () => Promise<void>;
  readonly cleanupSocket?: () => Promise<void>;
}
interface HostedSession {
  readonly input: typeof Protocol.OpenSession.Type;
  readonly runtime: Adapter.ProviderAdapterV2SessionRuntime;
  readonly scope: Scope.Closeable;
  readonly turns: Map<string, typeof Protocol.Turn.Type>;
  readonly starts: Map<string, Promise<void>>;
  eventFiber?: Fiber.Fiber<void, never>;
}
interface InstanceState {
  lease: number;
  socket?: Net.Socket;
  replay: boolean;
  adapter?: HostedCodexAdapter;
  configuring?: Promise<void>;
  configKey?: string;
  pendingConfig?: typeof Protocol.Configuration.Type;
  readonly sessions: Map<ProviderSessionId, HostedSession>;
  readonly openingSessions: Map<ProviderSessionId, Promise<HostedSession>>;
  readonly commands: Map<string, Promise<Protocol.ServerMessage>>;
  readonly mcpSessions: Map<string, typeof Protocol.McpSession.Type>;
  readonly outbox: Map<number, { event: HostEvent; bytes: number }>;
  bytes: number;
  nextSequence: number;
  committedAck: number;
  pendingAck: number;
  ackTimer?: NodeJS.Timeout;
  failed?: string;
}
function sessionDescription(state: InstanceState, session: HostedSession): SessionDescription {
  return {
    input: session.input,
    mcpSessions: Array.from(state.mcpSessions.values()).filter(
      (config) =>
        config.threadId === session.input.threadId ||
        Array.from(session.turns.values()).some((turn) => turn.threadId === config.threadId),
    ),
    session: session.runtime.providerSession,
    turns: Array.from(session.turns.values()),
    methods: [
      "compactThread",
      "injectHistory",
      "unloadThread",
      "stopTask",
      "stopSubagent",
      "uploadFeedback",
      "mcpApps",
    ].filter((method) => Reflect.get(session.runtime, method) !== undefined),
  };
}
function write(socket: Net.Socket | undefined, message: Protocol.ServerMessage): void {
  if (!socket || socket.destroyed) return;
  const frame = Protocol.encodeServer(message);
  if (socket.writableLength + Buffer.byteLength(frame) > Protocol.MAX_BUFFER_BYTES) {
    socket.destroy(new Error("Provider-host socket backpressure limit reached."));
    return;
  }
  socket.write(frame);
}
export async function startCodexProviderHostServer(options: CodexProviderHostServerOptions) {
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = Net.createConnection(options.socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
  if (reachable) throw new Error(`A provider host already listens at ${options.socketPath}.`);
  await options.prepareSocket?.();
  const states = new Map<ProviderInstanceId, InstanceState>();
  const sockets = new Set<Net.Socket>();
  const maxBufferBytes = options.maxBufferBytes ?? Protocol.MAX_BUFFER_BYTES;
  const getState = (id: ProviderInstanceId): InstanceState => {
    let state = states.get(id);
    if (!state) {
      state = {
        lease: 0,
        replay: false,
        sessions: new Map(),
        openingSessions: new Map(),
        commands: new Map(),
        mcpSessions: new Map(),
        outbox: new Map(),
        bytes: 0,
        nextSequence: 1,
        committedAck: 0,
        pendingAck: 0,
      };
      states.set(id, state);
    }
    return state;
  };
  const stopSession = async (state: InstanceState, id: ProviderSessionId) => {
    const session = state.sessions.get(id) ?? (await state.openingSessions.get(id));
    if (!session) return;
    state.sessions.delete(id);
    for (const [threadId, config] of state.mcpSessions)
      if (config.providerSessionId === id) state.mcpSessions.delete(threadId);
    if (session.eventFiber) await Effect.runPromise(Fiber.interrupt(session.eventFiber));
    await Effect.runPromise(Scope.close(session.scope, Exit.void));
  };
  const failInstance = (state: InstanceState, detail: string) => {
    state.failed = detail;
    write(state.socket, { type: "fatal", detail });
    // Never discard unacknowledged output and continue running invisibly.
    for (const id of state.sessions.keys()) void stopSession(state, id);
  };
  const publish = (state: InstanceState, make: (sequence: number) => HostEvent) => {
    if (state.failed) return;
    const event = make(state.nextSequence++);
    const bytes = Buffer.byteLength(Protocol.encodeServer(event));
    if (bytes > Protocol.MAX_FRAME_BYTES || state.bytes + bytes > maxBufferBytes) {
      failInstance(
        state,
        "Provider-host replay buffer exhausted; runtime stopped without dropping acknowledged state.",
      );
      return;
    }
    state.outbox.set(event.sequence, { event, bytes });
    state.bytes += bytes;
    if (state.replay) write(state.socket, event);
  };
  const applyConfiguration = async (
    instanceId: ProviderInstanceId,
    configuration: typeof Protocol.Configuration.Type,
  ) => {
    const state = getState(instanceId);
    const key = JSON.stringify(configuration);
    if (state.configKey === key) return;
    if (state.sessions.size > 0 || state.openingSessions.size > 0) {
      state.pendingConfig = configuration;
      return;
    }
    await state.adapter?.close();
    state.adapter = await options.createAdapter(
      { ...configuration, instanceId },
      {
        usage: (update) =>
          Effect.sync(() =>
            publish(state, (sequence) => ({ type: "usage", lease: state.lease, sequence, update })),
          ),
        continuation: (request) =>
          Effect.sync(() =>
            publish(state, (sequence) => ({
              type: "continuation",
              lease: state.lease,
              sequence,
              request,
            })),
          ),
      },
    );
    state.configKey = key;
    delete state.pendingConfig;
  };
  const configure = (
    instanceId: ProviderInstanceId,
    configuration: typeof Protocol.Configuration.Type,
  ) => {
    const state = getState(instanceId);
    const configuring = (state.configuring ?? Promise.resolve()).then(() =>
      applyConfiguration(instanceId, configuration),
    );
    state.configuring = configuring;
    return configuring.finally(() => {
      if (state.configuring === configuring) delete state.configuring;
    });
  };
  const scheduleAckCommit = (state: InstanceState) => {
    if (state.ackTimer || state.pendingAck <= state.committedAck) return;
    // Capture this batch now: frames acknowledged during the timer must receive
    // their own full grace period before a backend restart can lose the replay.
    const acknowledged = state.pendingAck;
    state.ackTimer = Timers.setTimeout(() => {
      state.committedAck = acknowledged;
      for (const [sequence, entry] of state.outbox)
        if (sequence <= acknowledged) {
          state.bytes -= entry.bytes;
          state.outbox.delete(sequence);
        }
      delete state.ackTimer;
      scheduleAckCommit(state);
    }, options.ackCommitGraceMs ?? 30_000);
  };
  const execute = async (
    instanceId: ProviderInstanceId,
    command: Command,
  ): Promise<Protocol.ServerMessage> => {
    const state = getState(instanceId);
    const response = <A, I>(schema: Schema.Codec<A, I>, value: A): Protocol.ServerMessage => ({
      type: "response",
      requestId: command.requestId,
      result: Protocol.encode(schema, value),
    });
    try {
      if (state.failed) throw protocolError(state.failed);
      if (command.operation === "configure") {
        await configure(instanceId, Protocol.decode(Protocol.Configuration, command.payload));
        return response(Schema.Void, undefined);
      }
      await state.configuring;
      if (state.pendingConfig && state.sessions.size === 0)
        await configure(instanceId, state.pendingConfig);
      const hosted = state.adapter;
      if (!hosted) throw protocolError("Codex provider host has not been configured.");
      if (command.mcpSessions) {
        await hosted.setMcpSessions(command.mcpSessions);
        for (const config of command.mcpSessions) state.mcpSessions.set(config.threadId, config);
      }
      if (command.operation === "capabilities")
        return response(
          Protocol.Capabilities,
          await Effect.runPromise(hosted.adapter.getCapabilities()),
        );
      if (command.operation === "listSessions")
        return response(
          Protocol.Sessions,
          Array.from(state.sessions.values())
            .filter((session) => session.input.lifetime !== "ephemeral")
            .map((session) => sessionDescription(state, session)),
        );
      if (command.operation === "openSession") {
        const input = Protocol.decode(Protocol.OpenSession, command.payload);
        const existing = state.sessions.get(input.providerSessionId);
        if (existing)
          return response(Protocol.SessionDescription, sessionDescription(state, existing));
        let opening = state.openingSessions.get(input.providerSessionId);
        if (!opening) {
          opening = (async () => {
            const scope = await Effect.runPromise(Scope.make());
            let runtime: Adapter.ProviderAdapterV2SessionRuntime;
            try {
              runtime = await hosted.openSession(input, command.effectiveRuntime, scope);
              if (state.failed) throw protocolError(state.failed);
              if (input.lifetime === "ephemeral" && command.lease !== state.lease)
                throw protocolError("The private Codex session owner detached during startup.");
            } catch (error) {
              await Effect.runPromise(Scope.close(scope, Exit.void));
              throw error;
            }
            const session: HostedSession = {
              input,
              runtime,
              scope,
              turns: new Map(),
              starts: new Map(),
            };
            state.sessions.set(input.providerSessionId, session);
            session.eventFiber = Effect.runFork(
              runtime.events.pipe(
                Stream.runForEach((event) =>
                  Effect.sync(() =>
                    publish(state, (sequence) => ({
                      type: "event",
                      lease: state.lease,
                      sequence,
                      sessionId: input.providerSessionId,
                      event,
                    })),
                  ),
                ),
                Effect.catchCause((cause) =>
                  Effect.sync(() =>
                    failInstance(state, `Codex provider stream failed: ${String(cause)}`),
                  ),
                ),
              ),
            );
            return session;
          })();
          state.openingSessions.set(input.providerSessionId, opening);
        }
        const session = await opening.finally(() =>
          state.openingSessions.delete(input.providerSessionId),
        );
        return response(Protocol.SessionDescription, sessionDescription(state, session));
      }
      const id = command.sessionId;
      if (!id) throw protocolError("A provider session id is required.");
      if (command.operation === "closeSession") {
        await stopSession(state, id);
        return response(Schema.Void, undefined);
      }
      const session = state.sessions.get(id);
      if (!session) throw protocolError(`Hosted Codex session ${id} is not alive.`);
      const runtime = session.runtime;
      const required = <A>(value: A | undefined, operation: string): A => {
        if (value === undefined) throw protocolError(`Hosted Codex does not support ${operation}.`);
        return value;
      };
      switch (command.operation) {
        case "ensureThread":
          return response(
            Protocol.ProviderThread,
            await Effect.runPromise(
              runtime.ensureThread(Protocol.decode(Protocol.EnsureThread, command.payload)),
            ),
          );
        case "resumeThread":
          return response(
            Protocol.ProviderThread,
            await Effect.runPromise(
              runtime.resumeThread(Protocol.decode(Protocol.ResumeThread, command.payload)),
            ),
          );
        case "startTurn":
        case "compactThread": {
          const turn = Protocol.decode(Protocol.Turn, command.payload);
          const key = `${command.operation}:${turn.attemptId}`;
          let started = session.starts.get(key);
          if (!started) {
            if (session.turns.size >= Protocol.MAX_COMMAND_RECEIPTS)
              throw protocolError(
                "Hosted session turn history limit reached; close this session before starting more turns.",
              );
            session.turns.set(turn.attemptId, turn);
            started = Effect.runPromise(
              command.operation === "startTurn"
                ? runtime.startTurn(turn)
                : required(runtime.compactThread, "compaction")(turn),
            );
            session.starts.set(key, started);
          }
          await started;
          return response(Schema.Void, undefined);
        }
        case "steerTurn":
          await Effect.runPromise(
            runtime.steerTurn(Protocol.decode(Protocol.Steer, command.payload)),
          );
          break;
        case "interruptTurn":
          await Effect.runPromise(
            runtime.interruptTurn(Protocol.decode(Protocol.Interrupt, command.payload)),
          );
          break;
        case "respondToRuntimeRequest":
          await Effect.runPromise(
            runtime.respondToRuntimeRequest(Protocol.decode(Protocol.Respond, command.payload)),
          );
          break;
        case "readThreadSnapshot":
          return response(
            Protocol.ThreadSnapshot,
            await Effect.runPromise(
              runtime.readThreadSnapshot(Protocol.decode(Protocol.Thread, command.payload)),
            ),
          );
        case "rollbackThread":
          return response(
            Protocol.ThreadSnapshot,
            await Effect.runPromise(
              runtime.rollbackThread(Protocol.decode(Protocol.Rollback, command.payload)),
            ),
          );
        case "forkThread":
          return response(
            Protocol.ProviderThread,
            await Effect.runPromise(
              runtime.forkThread(Protocol.decode(Protocol.Fork, command.payload)),
            ),
          );
        case "injectHistory":
          return response(
            Schema.Boolean,
            await Effect.runPromise(
              required(
                runtime.injectHistory,
                "history injection",
              )(Protocol.decode(Protocol.InjectHistory, command.payload)),
            ),
          );
        case "unloadThread":
          await Effect.runPromise(
            required(
              runtime.unloadThread,
              "unload",
            )(Protocol.decode(Protocol.Thread, command.payload)),
          );
          break;
        case "stopTask":
          await Effect.runPromise(
            required(
              runtime.stopTask,
              "task stop",
            )(Protocol.decode(Protocol.StopTask, command.payload)),
          );
          break;
        case "stopSubagent":
          return response(
            Protocol.SubagentOutcome,
            await Effect.runPromise(
              required(
                runtime.stopSubagent,
                "subagent stop",
              )(Protocol.decode(Protocol.StopSubagent, command.payload)),
            ),
          );
        case "uploadFeedback":
          return response(
            Schema.Struct({ feedbackId: Schema.String }),
            await Effect.runPromise(
              required(
                runtime.uploadFeedback,
                "feedback",
              )(Protocol.decode(Protocol.Feedback, command.payload)),
            ),
          );
        case "hasPendingBackgroundWork":
          return response(
            Schema.Boolean,
            await Effect.runPromise(runtime.hasPendingBackgroundWork ?? Effect.succeed(false)),
          );
        case "hasPendingBackgroundWorkForThread":
          return response(
            Schema.Boolean,
            await Effect.runPromise(
              runtime.hasPendingBackgroundWorkForThread?.(
                Protocol.decode(Protocol.Thread, command.payload).providerThread,
              ) ?? Effect.succeed(false),
            ),
          );
        case "mcp.listTools":
          return response(
            Protocol.McpTools,
            await Effect.runPromise(
              required(runtime.mcpApps, "MCP apps").listTools(
                Protocol.decode(Protocol.McpToolsInput, command.payload),
              ),
            ),
          );
        case "mcp.callTool":
          return response(
            Protocol.McpResult,
            await Effect.runPromise(
              required(runtime.mcpApps, "MCP apps").callTool(
                Protocol.decode(Protocol.McpCallInput, command.payload),
              ),
            ),
          );
        case "mcp.readResource":
          return response(
            Protocol.McpResource,
            await Effect.runPromise(
              required(runtime.mcpApps, "MCP apps").readResource(
                Protocol.decode(Protocol.McpResourceInput, command.payload),
              ),
            ),
          );
      }
      return response(Schema.Void, undefined);
    } catch (error) {
      return {
        type: "error",
        requestId: command.requestId,
        error: isAdapterError(error)
          ? error
          : protocolError("Provider host command failed.", error),
      };
    }
  };
  const server = Net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    let buffer = "";
    let subscription: { instanceId: ProviderInstanceId; lease: number } | undefined;
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > Protocol.MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: Protocol.ClientMessage;
        try {
          message = Protocol.decode(Protocol.ClientMessage, JSON.parse(line));
        } catch {
          socket.destroy();
          return;
        }
        if (message.type === "subscribe") {
          if (subscription) {
            socket.destroy();
            return;
          }
          const state = getState(message.instanceId);
          if (message.previousLease !== undefined && message.previousLease !== state.lease) {
            socket.end(
              Protocol.encodeServer({
                type: "fatal",
                detail: "Provider-host owner has been superseded.",
              }),
            );
            continue;
          }
          if (state.ackTimer) Timers.clearTimeout(state.ackTimer);
          delete state.ackTimer;
          state.pendingAck = state.committedAck;
          state.socket?.end(
            Protocol.encodeServer({
              type: "fatal",
              detail: "Provider-host owner has been superseded.",
            }),
          );
          state.socket = socket;
          state.lease += 1;
          if (message.previousLease === undefined)
            for (const [id, session] of state.sessions)
              if (session.input.lifetime === "ephemeral") void stopSession(state, id);
          state.replay = false;
          subscription = { instanceId: message.instanceId, lease: state.lease };
          write(socket, {
            type: "subscribed",
            protocolVersion: Protocol.PROTOCOL_VERSION,
            lease: state.lease,
            committed: state.committedAck,
          });
          continue;
        }
        if (!subscription) {
          socket.destroy();
          return;
        }
        const state = getState(subscription.instanceId);
        if (message.lease !== subscription.lease || state.socket !== socket) {
          socket.destroy();
          return;
        }
        if (message.type === "replay") {
          state.replay = true;
          for (const { event } of state.outbox.values())
            write(socket, { ...event, lease: state.lease });
          continue;
        }
        if (message.type === "ack") {
          if (message.sequence >= state.nextSequence || message.sequence < 0) {
            socket.destroy();
            return;
          }
          state.pendingAck = Math.max(state.pendingAck, message.sequence);
          scheduleAckCommit(state);
          continue;
        }
        let result = state.commands.get(message.commandId);
        if (!result) {
          result = execute(subscription.instanceId, message);
          state.commands.set(message.commandId, result);
          if (state.commands.size > Protocol.MAX_COMMAND_RECEIPTS) {
            const first = state.commands.keys().next().value;
            if (first !== undefined) state.commands.delete(first);
          }
        }
        const requestId = message.requestId;
        void result.then((response) =>
          write(socket, {
            ...response,
            ...(response.type === "response" || response.type === "error" ? { requestId } : {}),
          }),
        );
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      if (!subscription) return;
      const state = getState(subscription.instanceId);
      if (state.socket !== socket) return;
      delete state.socket;
      state.replay = false;
      if (state.ackTimer) Timers.clearTimeout(state.ackTimer);
      delete state.ackTimer;
      state.pendingAck = state.committedAck;
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, resolve);
  });
  await options.secureSocket?.();
  return {
    socketPath: options.socketPath,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      for (const state of states.values()) {
        if (state.ackTimer) Timers.clearTimeout(state.ackTimer);
        await state.configuring?.catch(() => {});
        await Promise.allSettled(state.openingSessions.values());
        await Promise.all(Array.from(state.sessions.keys(), (id) => stopSession(state, id)));
        await state.adapter?.close();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await options.cleanupSocket?.();
    },
  };
}
