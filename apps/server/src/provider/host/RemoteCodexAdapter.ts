// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as Net from "node:net";
import * as Timers from "node:timers";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import type { CodexEffectiveRuntime } from "../CodexManagedRuntime.ts";
import type { ProviderSetupError } from "@t3tools/contracts";
import * as Protocol from "./Protocol.ts";

const CODEX = ProviderDriverKind.make("codex");
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
}
export interface RemoteCodexAdapterOptions {
  readonly socketPath: string;
  readonly instanceId: ProviderInstanceId;
  readonly configuration: typeof Protocol.Configuration.Type;
  readonly onUsageLimits?: (update: typeof Protocol.UsageLimits.Type) => Effect.Effect<void>;
  readonly onContinuation: (request: typeof Protocol.Continuation.Type) => Effect.Effect<void>;
  readonly resolveRuntime?: Effect.Effect<CodexEffectiveRuntime, ProviderSetupError, Scope.Scope>;
  readonly canReuseContextUsage: NonNullable<
    Adapter.ProviderAdapterV2SessionRuntime["canReuseContextUsage"]
  >;
}

export const makeRemoteCodexAdapter = Effect.fn("makeRemoteCodexAdapter")(function* (
  options: RemoteCodexAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const mcp = yield* McpProviderSessions.McpProviderSessions;
  const prefix = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  const queues = new Map<
    ProviderSessionId,
    Queue.Queue<Adapter.ProviderAdapterV2Event, Adapter.ProviderAdapterV2Error>
  >();
  const descriptions = new Map<ProviderSessionId, SessionDescription>();
  const pending = new Map<string, PendingCommand>();
  let counter = 0;
  let socket: Net.Socket | undefined;
  let lease: number | undefined;
  let ready = false;
  let replay = false;
  let closed = false;
  let terminalError: Adapter.ProviderAdapterV2Error | undefined;
  let cursor = 0;
  let receivedCursor = 0;
  let pendingDeliveryBytes = 0;
  let delivery = Promise.resolve();
  let reconnect: NodeJS.Timeout | undefined;
  let firstConnectionResolve: (() => void) | undefined;
  let firstConnectionReject: ((cause: Adapter.ProviderAdapterV2Error) => void) | undefined;
  const firstConnection = new Promise<void>((resolve, reject) => {
    firstConnectionResolve = resolve;
    firstConnectionReject = reject;
  });
  const send = (message: Protocol.ClientMessage) => socket?.write(Protocol.encodeClient(message));
  const fail = (cause: Adapter.ProviderAdapterV2Error) => {
    terminalError = cause;
    firstConnectionReject?.(cause);
    for (const command of pending.values()) command.reject(cause);
    pending.clear();
    for (const queue of queues.values()) Effect.runFork(Queue.fail(queue, cause));
    socket?.destroy();
  };
  const connect = () => {
    if (closed || terminalError) return;
    const next = Net.createConnection(options.socketPath);
    socket = next;
    next.setNoDelay(true);
    next.setEncoding("utf8");
    let buffer = "";
    next.once("connect", () =>
      send({
        type: "subscribe",
        protocolVersion: Protocol.PROTOCOL_VERSION,
        instanceId: options.instanceId,
        after: cursor,
        ...(lease === undefined ? {} : { previousLease: lease }),
      }),
    );
    next.on("error", () => {});
    next.on("data", (chunk: string) => {
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
        let message: Protocol.ServerMessage;
        try {
          message = Protocol.decode(Protocol.ServerMessage, JSON.parse(line));
        } catch (cause) {
          fail(error("Invalid provider-host message.", cause));
          return;
        }
        if (message.type === "fatal") {
          fail(error(message.detail));
          return;
        }
        if (message.type === "subscribed") {
          lease = message.lease;
          ready = true;
          cursor = Math.max(cursor, message.committed);
          receivedCursor = Math.max(receivedCursor, cursor);
          firstConnectionResolve?.();
          for (const command of pending.values()) send({ ...command.command, lease });
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
        const deliver =
          message.type === "event"
            ? Effect.gen(function* () {
                const queue = queues.get(message.sessionId);
                if (queue === undefined) return;
                yield* Queue.offer(queue, message.event);
              })
            : message.type === "usage"
              ? (options.onUsageLimits?.(message.update) ?? Effect.void)
              : options.onContinuation(message.request);
        // Serialize delivery so a later frame cannot acknowledge an earlier blocked
        // callback. The host retains acknowledged frames for its restart grace window.
        delivery = delivery
          .then(async () => {
            if (closed || terminalError) return;
            await Effect.runPromise(deliver);
            cursor = message.sequence;
            if (lease !== undefined && ready) send({ type: "ack", lease, sequence: cursor });
          })
          .catch((cause: unknown) => fail(error("Provider-host event delivery failed.", cause)))
          .finally(() => {
            pendingDeliveryBytes -= bytes;
          });
      }
    });
    next.on("close", () => {
      if (socket !== next) return;
      ready = false;
      if (closed || terminalError) return;
      reconnect = Timers.setTimeout(connect, 250);
    });
  };
  const close = Effect.sync(() => {
    closed = true;
    if (reconnect) Timers.clearTimeout(reconnect);
    socket?.destroy();
    const cause = error("Provider-host client detached.");
    for (const command of pending.values()) command.reject(cause);
    pending.clear();
    for (const queue of queues.values()) Queue.shutdownUnsafe(queue);
  });
  yield* Effect.addFinalizer(() => close);
  connect();
  yield* Effect.tryPromise({
    try: () => firstConnection,
    catch: (cause) =>
      Schema.is(Adapter.ProviderAdapterV2Error)(cause)
        ? cause
        : error("Cannot connect to Codex provider host.", cause),
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) =>
      error("Cannot connect to the configured Codex provider host.", cause),
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
          const requestId = `${prefix}:${++counter}`;
          const command: Omit<Command, "lease"> = {
            type: "command",
            commandId: extras?.commandId ?? requestId,
            requestId,
            operation,
            payload: Protocol.encode(inputSchema, input),
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(extras?.mcpSessions === undefined ? {} : { mcpSessions: extras.mcpSessions }),
            ...(extras?.effectiveRuntime === undefined
              ? {}
              : { effectiveRuntime: extras.effectiveRuntime }),
          };
          pending.set(requestId, { command, resolve, reject });
          if (ready && lease !== undefined) send({ ...command, lease });
        }),
      catch: (cause) =>
        Schema.is(Adapter.ProviderAdapterV2Error)(cause)
          ? cause
          : error("Provider-host command failed.", cause),
    }).pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => Protocol.decode(outputSchema, value),
          catch: (cause) => error("Invalid provider-host command response.", cause),
        }),
      ),
    );
  yield* call("configure", Protocol.Configuration, Schema.Void, options.configuration);
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
  const hostedSessions = call("listSessions", Schema.Void, Protocol.Sessions, undefined).pipe(
    Effect.tap((sessions) =>
      Effect.sync(() => {
        for (const session of sessions) descriptions.set(session.input.providerSessionId, session);
      }),
    ),
  );
  return Adapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: CODEX,
    getCapabilities: () => call("capabilities", Schema.Void, Protocol.Capabilities, undefined),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
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
    openSession: (input) =>
      Effect.gen(function* () {
        const queue = yield* Queue.bounded<
          Adapter.ProviderAdapterV2Event,
          Adapter.ProviderAdapterV2Error
        >(512);
        queues.set(input.providerSessionId, queue);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (queues.get(input.providerSessionId) === queue)
              queues.delete(input.providerSessionId);
            Queue.shutdownUnsafe(queue);
          }),
        );
        const existing = descriptions.get(input.providerSessionId);
        const effectiveRuntime =
          existing || !options.resolveRuntime
            ? undefined
            : yield* options.resolveRuntime.pipe(
                Effect.mapError((cause) =>
                  error("Could not resolve managed Codex runtime.", cause),
                ),
              );
        if (input.lifetime === "ephemeral")
          yield* Effect.addFinalizer(() =>
            call("closeSession", Schema.Void, Schema.Void, undefined, input.providerSessionId).pipe(
              Effect.catchCause(() => Effect.void),
            ),
          );
        const description = yield* call(
          "openSession",
          Protocol.OpenSession,
          Protocol.SessionDescription,
          input,
          input.providerSessionId,
          {
            mcpSessions: yield* mcpForThread(input.threadId),
            ...(effectiveRuntime === undefined ? {} : { effectiveRuntime }),
          },
        );
        descriptions.set(input.providerSessionId, description);
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
            stop: call("closeSession", Schema.Void, Schema.Void, undefined, sessionId),
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
          steerTurn: (payload) =>
            call("steerTurn", Protocol.Steer, Schema.Void, payload, sessionId),
          interruptTurn: (payload) =>
            call("interruptTurn", Protocol.Interrupt, Schema.Void, payload, sessionId),
          respondToRuntimeRequest: (payload) =>
            call("respondToRuntimeRequest", Protocol.Respond, Schema.Void, payload, sessionId),
          readThreadSnapshot: (payload) =>
            call(
              "readThreadSnapshot",
              Protocol.Thread,
              Protocol.ThreadSnapshot,
              payload,
              sessionId,
            ),
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
