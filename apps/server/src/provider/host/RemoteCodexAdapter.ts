// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeNet from "node:net";
import * as NodeTimers from "node:timers";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import {
  managedCodexRuntimeProblem,
  type CodexEffectiveRuntime,
  type ManagedCodexIdentity,
} from "../CodexManagedRuntime.ts";
import type { ProviderSetupError } from "@t3tools/contracts";
import * as Protocol from "./Protocol.ts";

const CODEX = ProviderDriverKind.make("codex");
const isAdapterError = Schema.is(Adapter.ProviderAdapterV2Error);
const error = (detail: string, payload?: unknown) =>
  new Adapter.ProviderAdapterProtocolError({
    driver: CODEX,
    detail,
    ...(payload === undefined ? {} : { payload }),
  });
type Command = Extract<Protocol.ClientMessage, { readonly type: "command" }>;
type SessionDescription = typeof Protocol.SessionDescription.Type;
interface PendingCommand {
  readonly command: Omit<Command, "lease">;
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: Adapter.ProviderAdapterV2Error) => void;
  // A reattach asks for a session of the host that sent the session list.
  readonly reattach: boolean;
  // The host process that received the command, if any did.
  sentTo?: string;
}
export interface RemoteCodexAdapterOptions {
  readonly socketPath: string;
  readonly instanceId: ProviderInstanceId;
  readonly configuration: typeof Protocol.Configuration.Type;
  readonly onUsageLimits?: (update: typeof Protocol.UsageLimits.Type) => Effect.Effect<void>;
  readonly onContinuation: (request: typeof Protocol.Continuation.Type) => Effect.Effect<void>;
  readonly resolveRuntime?: Effect.Effect<CodexEffectiveRuntime, ProviderSetupError, Scope.Scope>;
  /** A managed instance sends only a runtime that matches its owning server's identity. */
  readonly managedIdentity?: Effect.Effect<ManagedCodexIdentity, ProviderSetupError>;
  readonly canReuseContextUsage: NonNullable<
    Adapter.ProviderAdapterV2SessionRuntime["canReuseContextUsage"]
  >;
}

export const makeRemoteCodexAdapter = Effect.fn("makeRemoteCodexAdapter")(function* (
  options: RemoteCodexAdapterOptions,
) {
  const random = yield* SecureRandom.SecureRandom;
  const mcp = yield* McpProviderSessions.McpProviderSessions;
  const prefix = yield* random.uuidV4();
  const services = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(services);
  const runPromise = Effect.runPromiseWith(services);
  const queues = new Map<
    ProviderSessionId,
    Queue.Queue<Adapter.ProviderAdapterV2Event, Adapter.ProviderAdapterV2Error>
  >();
  const reattachable = new Map<ProviderSessionId, SessionDescription>();
  // The last host frame before each fresh session: earlier frames belong to a session it replaced.
  const freshAfter = new Map<ProviderSessionId, number>();
  // The launch of each hosted session that this adapter started or verified.
  const launches = new Map<ProviderSessionId, string>();
  const managed = options.configuration.config.setupMode === "managed";
  const pending = new Map<string, PendingCommand>();
  let counter = 0;
  let socket: NodeNet.Socket | undefined;
  let lease: number | undefined;
  let hostId: string | undefined;
  let ready = false;
  let replay = false;
  let closed = false;
  let terminalError: Adapter.ProviderAdapterV2Error | undefined;
  let cursor = 0;
  let receivedCursor = 0;
  let pendingDeliveryBytes = 0;
  let delivery = Promise.resolve();
  let reconnect: NodeJS.Timeout | undefined;
  let hungUp = false;
  let markConfigured: (() => void) | undefined;
  let failStartup: ((cause: Adapter.ProviderAdapterV2Error) => void) | undefined;
  const configured = new Promise<void>((resolve, reject) => {
    markConfigured = resolve;
    failStartup = reject;
  });
  const send = (message: Protocol.ClientMessage) => socket?.write(Protocol.encodeClient(message));
  const dispatch = (entry: PendingCommand) => {
    if (!ready || lease === undefined || hostId === undefined) return;
    entry.sentTo = hostId;
    send({ ...entry.command, lease });
  };
  const request = (
    command: Omit<Command, "lease" | "requestId" | "commandId"> & { readonly commandId?: string },
    resolve: PendingCommand["resolve"],
    reject: PendingCommand["reject"],
    reattach = false,
  ) => {
    const requestId = `${prefix}:${++counter}`;
    const queued = { ...command, commandId: command.commandId ?? requestId, requestId };
    const entry: PendingCommand = { command: queued, resolve, reject, reattach };
    pending.set(requestId, entry);
    dispatch(entry);
  };
  // A rejection handler can queue or reject commands itself, so empty the map first.
  const rejectAll = (cause: Adapter.ProviderAdapterV2Error) => {
    const commands = [...pending.values()];
    pending.clear();
    for (const command of commands) command.reject(cause);
  };
  const fail = (cause: Adapter.ProviderAdapterV2Error) => {
    if (terminalError !== undefined) return;
    terminalError = cause;
    runFork(
      Effect.logError("[🔌 Provider host] Codex stopped using the provider host.", {
        instanceId: options.instanceId,
        reason: cause.message,
      }),
    );
    failStartup?.(cause);
    rejectAll(cause);
    for (const queue of queues.values()) runFork(Queue.fail(queue, cause));
    socket?.destroy();
  };
  // Only the answer of the host process that this client still talks to counts.
  const configure = (target: string) =>
    request(
      {
        type: "command",
        operation: "configure",
        payload: Protocol.encode(Protocol.Configuration, options.configuration),
      },
      () => {
        if (hostId === target) markConfigured?.();
      },
      (cause) => {
        if (hostId === target && !closed) fail(cause);
      },
    );
  const connect = () => {
    if (closed || terminalError) return;
    const next = NodeNet.createConnection(options.socketPath);
    socket = next;
    next.setNoDelay(true);
    next.setEncoding("utf8");
    let buffer = "";
    let connected = false;
    let answered = false;
    next.once("connect", () => {
      connected = true;
      send({
        type: "subscribe",
        protocolVersion: Protocol.PROTOCOL_VERSION,
        instanceId: options.instanceId,
        after: cursor,
        ...(lease === undefined || hostId === undefined
          ? {}
          : { previousLease: { hostId, lease } }),
      });
    });
    next.on("error", () => {});
    next.on("data", (chunk: string) => {
      answered = true;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > Protocol.MAX_FRAME_BYTES) {
        fail(error("Provider-host frame exceeded its size limit."));
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let raw: unknown;
        let message: Protocol.ServerMessage;
        try {
          raw = JSON.parse(line);
          message = Protocol.decode(Protocol.ServerMessage, raw);
        } catch (cause) {
          const other = Protocol.otherProtocolVersion(raw);
          fail(
            other === undefined
              ? error("Invalid provider-host message.", cause)
              : error(
                  `The Codex provider host runs protocol ${other}, but this T3 server runs protocol ${Protocol.PROTOCOL_VERSION}. Restart the provider host so it runs the same release as this server.`,
                ),
          );
          return;
        }
        if (message.type === "fatal") {
          fail(error(message.detail));
          return;
        }
        if (message.type === "subscribed") {
          const firstHost = hostId === undefined;
          const restarted = !firstHost && message.hostId !== hostId;
          hostId = message.hostId;
          lease = message.lease;
          ready = true;
          if (restarted) {
            const commands = [...pending.entries()];
            const lostQueues = [...queues.values()];
            pending.clear();
            reattachable.clear();
            cursor = message.committed;
            receivedCursor = cursor;
            // A callback of the lost host must not hold up the frames of this one.
            delivery = Promise.resolve();
            // Configure first: ending a lost session can start its replacement synchronously.
            configure(message.hostId);
            const lost = error("The Codex provider host restarted, so its sessions ended.");
            for (const [requestId, entry] of commands) {
              const { operation, sessionId } = entry.command;
              // The restart already ended every session of the old host.
              if (operation === "closeSession")
                entry.resolve(Protocol.encode(Schema.Void, undefined));
              else if (
                entry.sentTo !== undefined ||
                entry.reattach ||
                (sessionId !== undefined && operation !== "openSession")
              )
                entry.reject(lost);
              else {
                pending.set(requestId, entry);
                dispatch(entry);
              }
            }
            for (const queue of lostQueues) runFork(Queue.fail(queue, lost));
          } else {
            cursor = Math.max(cursor, message.committed);
            receivedCursor = Math.max(receivedCursor, cursor);
            for (const entry of pending.values()) dispatch(entry);
            if (firstHost) configure(message.hostId);
          }
          if (replay) send({ type: "replay", lease });
          continue;
        }
        if (message.type === "response" || message.type === "error") {
          const command = pending.get(message.requestId);
          if (command) {
            pending.delete(message.requestId);
            if (message.type === "error") command.reject(message.error);
            else command.resolve(message.result);
          }
          continue;
        }
        if (message.lease !== lease || message.sequence <= receivedCursor) continue;
        const bytes = Buffer.byteLength(line);
        pendingDeliveryBytes += bytes;
        if (pendingDeliveryBytes > Protocol.MAX_BUFFER_BYTES) {
          fail(error("Provider-host client delivery buffer exhausted."));
          return;
        }
        receivedCursor = message.sequence;
        const from = hostId;
        const deliver =
          message.type === "event"
            ? Effect.gen(function* () {
                const queue = queues.get(message.sessionId);
                if (queue === undefined) return;
                if (message.sequence <= (freshAfter.get(message.sessionId) ?? 0)) return;
                yield* Queue.offer(queue, message.event);
              })
            : message.type === "usage"
              ? (options.onUsageLimits?.(message.update) ?? Effect.void)
              : options.onContinuation(message.request);
        // Serialize delivery so a later frame cannot acknowledge an earlier blocked
        // callback. The host retains acknowledged frames for its restart grace window.
        const current = () => !closed && !terminalError && from === hostId;
        delivery = delivery
          .then(async () => {
            if (!current()) return;
            await runPromise(deliver);
            if (!current()) return;
            cursor = message.sequence;
            if (lease !== undefined && ready) send({ type: "ack", lease, sequence: cursor });
          })
          .catch((cause: unknown) => {
            if (current()) fail(error("Provider-host event delivery failed.", cause));
          })
          .finally(() => {
            pendingDeliveryBytes -= bytes;
          });
      }
    });
    next.on("close", () => {
      if (socket !== next) return;
      ready = false;
      // A host from before the version check closes a subscription it cannot read.
      if (connected && !answered) hungUp = true;
      if (closed || terminalError) return;
      reconnect = NodeTimers.setTimeout(connect, 250);
    });
  };
  const close = Effect.sync(() => {
    closed = true;
    if (reconnect) NodeTimers.clearTimeout(reconnect);
    socket?.destroy();
    rejectAll(error("Provider-host client detached."));
    for (const queue of queues.values()) Queue.shutdownUnsafe(queue);
  });
  yield* Effect.addFinalizer(() => close);
  connect();
  yield* Effect.tryPromise({
    try: () => configured,
    catch: (cause) =>
      isAdapterError(cause) ? cause : error("Cannot connect to Codex provider host.", cause),
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) =>
      isAdapterError(cause)
        ? cause
        : error(
            hungUp
              ? "The Codex provider host closed the connection without an answer. It probably runs an older release. Restart the provider host so it runs the same release as this server."
              : "Cannot connect to the configured Codex provider host.",
            cause,
          ),
    ),
  );

  const call = <A, I, B, J>(
    operation: Protocol.Operation,
    inputSchema: Schema.Codec<A, I>,
    outputSchema: Schema.Codec<B, J>,
    input: A,
    sessionId?: ProviderSessionId,
    extras?: {
      readonly commandId?: string;
      readonly mcpSessions?: ReadonlyArray<typeof Protocol.McpSession.Type>;
      readonly effectiveRuntime?: typeof Protocol.EffectiveRuntime.Type;
      readonly reattach?: boolean;
    },
  ) =>
    Effect.tryPromise({
      try: () =>
        new Promise<unknown>((resolve, reject) => {
          if (terminalError) {
            reject(terminalError);
            return;
          }
          if (closed) {
            reject(error("Provider-host client detached."));
            return;
          }
          request(
            {
              type: "command",
              operation,
              payload: Protocol.encode(inputSchema, input),
              ...(extras?.commandId === undefined ? {} : { commandId: extras.commandId }),
              ...(sessionId === undefined ? {} : { sessionId }),
              ...(extras?.mcpSessions === undefined ? {} : { mcpSessions: extras.mcpSessions }),
              ...(extras?.effectiveRuntime === undefined
                ? {}
                : { effectiveRuntime: extras.effectiveRuntime }),
            },
            resolve,
            reject,
            extras?.reattach,
          );
        }),
      catch: (cause) =>
        isAdapterError(cause) ? cause : error("Provider-host command failed.", cause),
    }).pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => Protocol.decode(outputSchema, value),
          catch: (cause) => error("Invalid provider-host command response.", cause),
        }),
      ),
    );
  // The host answers a close once the session has stopped, which can be after its caller gave up.
  const stopping = new Map<
    ProviderSessionId,
    Deferred.Deferred<void, Adapter.ProviderAdapterV2Error>
  >();
  const stopSession = Effect.fn("RemoteCodexAdapter.stopSession")(
    function* (sessionId: ProviderSessionId) {
      launches.delete(sessionId);
      let stopped = stopping.get(sessionId);
      if (stopped === undefined) {
        const close = yield* Deferred.make<void, Adapter.ProviderAdapterV2Error>();
        stopping.set(sessionId, close);
        runFork(
          call("closeSession", Schema.Void, Schema.Void, undefined, sessionId).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (stopping.get(sessionId) === close) stopping.delete(sessionId);
              }).pipe(Effect.andThen(Deferred.done(close, exit))),
            ),
          ),
        );
        stopped = close;
      }
      return yield* Deferred.await(stopped);
    },
    (effect) =>
      effect.pipe(
        Effect.timeout("2 seconds"),
        Effect.interruptible,
        Effect.mapError((cause) =>
          error("Could not confirm the hosted Codex session stopped.", cause),
        ),
      ),
  );
  const mcpForThread = (threadId: ThreadId | null) =>
    threadId === null
      ? Effect.succeed([])
      : mcp.read(threadId).pipe(
          Effect.map((config) => {
            if (!config) return [];
            const { capabilities, ...rest } = config;
            return [
              {
                ...rest,
                ...(capabilities === undefined ? {} : { capabilities: [...capabilities] }),
              },
            ];
          }),
        );
  const enableReplay = Effect.sync(() => {
    replay = true;
    if (ready && lease !== undefined) send({ type: "replay", lease });
  });
  // The host writes its whole replay before it answers a later command on the same connection.
  const receiveBufferedOutput = Effect.gen(function* () {
    let connection: number | undefined;
    do {
      connection = lease;
      yield* enableReplay;
      yield* call("capabilities", Schema.Void, Protocol.Capabilities, undefined);
    } while (lease !== connection);
  });
  const configurationLaunch = Protocol.launchKey({ configuration: options.configuration });
  const hostedSessions = call("listSessions", Schema.Void, Protocol.Sessions, undefined).pipe(
    Effect.flatMap((sessions) =>
      Effect.filter(sessions, (session) => {
        const id = session.input.providerSessionId;
        // A managed session renews its login through the token broker of the server that opened it.
        const reusable = managed
          ? launches.has(id)
          : (session.launch ?? configurationLaunch) === configurationLaunch;
        if (!reusable)
          return stopSession(id).pipe(Effect.ignoreCause({ log: true }), Effect.as(false));
        return Effect.sync(() => {
          reattachable.set(id, session);
          if (!launches.has(id)) launches.set(id, configurationLaunch);
          return true;
        });
      }),
    ),
  );
  // An earlier hosted session of a managed instance can still run on another login.
  if (managed) yield* hostedSessions;
  return Adapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: CODEX,
    getCapabilities: Effect.fn("RemoteCodexAdapter.getCapabilities")(function () {
      return call("capabilities", Schema.Void, Protocol.Capabilities, undefined);
    }),
    planSelectionTransition: Effect.fn("RemoteCodexAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    hostedSessions: hostedSessions.pipe(
      Effect.map((sessions) =>
        sessions.map((session) => ({
          ...session,
          mcpSessions: session.mcpSessions.map(({ capabilities, ...config }) => ({
            ...config,
            ...(capabilities === undefined ? {} : { capabilities: new Set(capabilities) }),
          })),
        })),
      ),
    ),
    openSession: Effect.fn("RemoteCodexAdapter.openSession")(function* (input) {
      if (stopping.has(input.providerSessionId))
        return yield* error(
          `Hosted Codex session ${input.providerSessionId} has not confirmed that it stopped. Retry once it stops.`,
        );
      const existing = reattachable.get(input.providerSessionId);
      reattachable.delete(input.providerSessionId);
      if (managed && (!options.resolveRuntime || !options.managedIdentity))
        return yield* error(
          `Managed Codex instance ${options.instanceId} has no runtime with its own Codex home, so it does not start on the default Codex login.`,
        );
      const effectiveRuntime = options.resolveRuntime
        ? yield* options.resolveRuntime.pipe(
            Effect.mapError((cause) => error("Could not resolve managed Codex runtime.", cause)),
          )
        : undefined;
      // An older provider host spawns what it receives, so the check runs before sending.
      if (effectiveRuntime !== undefined && options.managedIdentity) {
        const problem = managedCodexRuntimeProblem(
          yield* options.managedIdentity.pipe(
            Effect.mapError((cause) => error("Could not resolve managed Codex runtime.", cause)),
          ),
          effectiveRuntime,
        );
        if (problem !== undefined) return yield* error(problem);
      }
      const launch =
        effectiveRuntime === undefined
          ? configurationLaunch
          : Protocol.launchKey({ runtime: effectiveRuntime });
      // The host can still run this id with a login that this adapter did not start.
      if (launches.get(input.providerSessionId) !== launch)
        yield* stopSession(input.providerSessionId);
      if (existing) freshAfter.delete(input.providerSessionId);
      else {
        if (!replay) yield* receiveBufferedOutput;
        freshAfter.set(input.providerSessionId, receivedCursor);
      }
      const queue = yield* Queue.bounded<
        Adapter.ProviderAdapterV2Event,
        Adapter.ProviderAdapterV2Error
      >(512);
      queues.set(input.providerSessionId, queue);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (queues.get(input.providerSessionId) === queue) queues.delete(input.providerSessionId);
          Queue.shutdownUnsafe(queue);
        }),
      );
      if (input.lifetime === "ephemeral")
        yield* Effect.addFinalizer(() =>
          stopSession(input.providerSessionId).pipe(Effect.ignoreCause()),
        );
      const description = yield* call(
        "openSession",
        Protocol.OpenSession,
        Protocol.SessionDescription,
        input,
        input.providerSessionId,
        {
          mcpSessions: yield* mcpForThread(input.threadId),
          reattach: existing !== undefined,
          ...(effectiveRuntime === undefined ? {} : { effectiveRuntime }),
        },
      );
      launches.set(input.providerSessionId, launch);
      if (!existing) yield* enableReplay;
      const sessionId = input.providerSessionId;
      const supports = (method: string) => description.methods.includes(method);
      const ensureThread: Adapter.ProviderAdapterV2SessionRuntime["ensureThread"] = (payload) =>
        mcpForThread(payload.threadId).pipe(
          Effect.flatMap((mcpSessions) =>
            call(
              "ensureThread",
              Protocol.EnsureThread,
              Protocol.ProviderThread,
              payload,
              sessionId,
              { mcpSessions },
            ),
          ),
        );
      const resumeThread: Adapter.ProviderAdapterV2SessionRuntime["resumeThread"] = (payload) =>
        mcpForThread(payload.threadId ?? payload.providerThread.appThreadId).pipe(
          Effect.flatMap((mcpSessions) =>
            call(
              "resumeThread",
              Protocol.ResumeThread,
              Protocol.ProviderThread,
              payload,
              sessionId,
              { mcpSessions },
            ),
          ),
        );
      const start = (
        operation: "startTurn" | "compactThread",
        payload: Adapter.ProviderAdapterV2TurnInput,
      ) =>
        enableReplay.pipe(
          Effect.andThen(
            call(operation, Protocol.Turn, Schema.Void, payload, sessionId, {
              commandId: `${operation}:${sessionId}:${payload.attemptId}`,
            }),
          ),
        );
      return {
        instanceId: options.instanceId,
        driver: CODEX,
        providerSessionId: sessionId,
        providerSession: description.session,
        events: Stream.fromQueue(queue),
        externalLifetime: {
          stop: stopSession(sessionId),
          replay: enableReplay,
        },
        canReuseContextUsage: options.canReuseContextUsage,
        hasPendingBackgroundWork: call(
          "hasPendingBackgroundWork",
          Schema.Void,
          Schema.Boolean,
          undefined,
          sessionId,
        ).pipe(Effect.orElseSucceed(() => true)),
        hasPendingBackgroundWorkForThread: (providerThread) =>
          call(
            "hasPendingBackgroundWorkForThread",
            Protocol.Thread,
            Schema.Boolean,
            { providerThread },
            sessionId,
          ).pipe(Effect.orElseSucceed(() => true)),
        ensureThread,
        resumeThread,
        startTurn: (payload) => start("startTurn", payload),
        ...(supports("compactThread")
          ? {
              compactThread: (payload: Adapter.ProviderAdapterV2TurnInput) =>
                start("compactThread", payload),
            }
          : {}),
        steerTurn: (payload) => call("steerTurn", Protocol.Steer, Schema.Void, payload, sessionId),
        interruptTurn: (payload) =>
          call("interruptTurn", Protocol.Interrupt, Schema.Void, payload, sessionId),
        respondToRuntimeRequest: (payload) =>
          call("respondToRuntimeRequest", Protocol.Respond, Schema.Void, payload, sessionId),
        readThreadSnapshot: (payload) =>
          call("readThreadSnapshot", Protocol.Thread, Protocol.ThreadSnapshot, payload, sessionId),
        rollbackThread: (payload) =>
          call("rollbackThread", Protocol.Rollback, Protocol.ThreadSnapshot, payload, sessionId),
        forkThread: (payload) =>
          call("forkThread", Protocol.Fork, Protocol.ProviderThread, payload, sessionId),
        ...(supports("injectHistory")
          ? {
              injectHistory: (
                payload: Adapter.ProviderAdapterV2HistoricalContext & {
                  readonly providerThread: typeof Protocol.ProviderThread.Type;
                },
              ) =>
                call("injectHistory", Protocol.InjectHistory, Schema.Boolean, payload, sessionId),
            }
          : {}),
        ...(supports("unloadThread")
          ? {
              unloadThread: (payload: typeof Protocol.Thread.Type) =>
                call("unloadThread", Protocol.Thread, Schema.Void, payload, sessionId),
            }
          : {}),
        ...(supports("stopTask")
          ? {
              stopTask: (payload: typeof Protocol.StopTask.Type) =>
                call("stopTask", Protocol.StopTask, Schema.Void, payload, sessionId),
            }
          : {}),
        ...(supports("stopSubagent")
          ? {
              stopSubagent: (payload: typeof Protocol.StopSubagent.Type) =>
                call(
                  "stopSubagent",
                  Protocol.StopSubagent,
                  Protocol.SubagentOutcome,
                  payload,
                  sessionId,
                ),
            }
          : {}),
        ...(supports("uploadFeedback")
          ? {
              uploadFeedback: (payload: typeof Protocol.Feedback.Type) =>
                call(
                  "uploadFeedback",
                  Protocol.Feedback,
                  Schema.Struct({ feedbackId: Schema.String }),
                  payload,
                  sessionId,
                ),
            }
          : {}),
        ...(supports("mcpApps")
          ? {
              mcpApps: {
                listTools: (payload: typeof Protocol.McpToolsInput.Type) =>
                  call(
                    "mcp.listTools",
                    Protocol.McpToolsInput,
                    Protocol.McpTools,
                    payload,
                    sessionId,
                  ),
                callTool: (payload: typeof Protocol.McpCallInput.Type) =>
                  call(
                    "mcp.callTool",
                    Protocol.McpCallInput,
                    Protocol.McpResult,
                    payload,
                    sessionId,
                  ),
                readResource: (payload: typeof Protocol.McpResourceInput.Type) =>
                  call(
                    "mcp.readResource",
                    Protocol.McpResourceInput,
                    Protocol.McpResource,
                    payload,
                    sessionId,
                  ),
              },
            }
          : {}),
      } satisfies Adapter.ProviderAdapterV2SessionRuntime;
    }),
  });
});
