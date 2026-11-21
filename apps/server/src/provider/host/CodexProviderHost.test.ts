// @effect-diagnostics nodeBuiltinImport:off - raw sockets stand in for other servers on the host protocol.
import * as NodeNet from "node:net";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  CodexSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import {
  CodexProviderCapabilitiesV2,
  canReuseCodexContextUsage,
} from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  managedCodexLaunchArgs,
  managedCodexRuntimeProblem,
  type CodexEffectiveRuntime,
} from "../CodexManagedRuntime.ts";
import { startCodexProviderHostServer } from "./CodexProviderHost.ts";
import * as Protocol from "./Protocol.ts";
import { makeRemoteCodexAdapter, type RemoteCodexAdapterOptions } from "./RemoteCodexAdapter.ts";

const instanceId = ProviderInstanceId.make("codex");
const sessionId = ProviderSessionId.make("hosted-session");
const threadId = ThreadId.make("app-thread");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
} as const;
const decodeSettings = Schema.decodeSync(CodexSettings);
const config = decodeSettings({});
const now = DateTime.makeUnsafe("2026-10-13T00:00:00.000Z");
const session = {
  id: sessionId,
  driver,
  providerInstanceId: instanceId,
  status: "running",
  cwd: "/workspace",
  model: "gpt-5.4",
  capabilities: CodexProviderCapabilitiesV2,
  createdAt: now,
  updatedAt: now,
  lastError: null,
} as const;
const providerThread = {
  id: ProviderThreadId.make("native-thread"),
  driver,
  providerInstanceId: instanceId,
  providerSessionId: sessionId,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
  nativeConversationHeadRef: null,
  status: "active",
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
} as const;
const turn: Adapter.ProviderAdapterV2TurnInput = {
  appThread: {
    id: threadId,
    projectId: ProjectId.make("project"),
    title: "Hosted turn",
    providerInstanceId: instanceId,
    modelSelection,
    createdBy: "user",
    creationSource: "web",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  threadId,
  runId: RunId.make("run"),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: RunAttemptId.make("attempt"),
  rootNodeId: NodeId.make("root"),
  providerThread,
  message: {
    messageId: MessageId.make("prompt"),
    text: "Keep working",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  },
  modelSelection,
  runtimePolicy,
};
const openInput = { threadId, providerSessionId: sessionId, modelSelection, runtimePolicy };
const managedHome = "/state/codex-homes/codex-2";
const profileKey = "a".repeat(64);
const brokeredRuntime = (endpoint: string): CodexEffectiveRuntime => ({
  revision: profileKey,
  config: decodeSettings({
    setupMode: "managed",
    homePath: managedHome,
    launchArgs: managedCodexLaunchArgs("/usr/bin/node", [
      "__managed-chatgpt-token",
      endpoint,
      instanceId,
      "environment",
      profileKey,
    ]),
  }),
  environment: { CODEX_HOME: managedHome },
});
const managedRuntime = brokeredRuntime("/tmp/t3-token-first/s");
type ServerSide = Pick<
  RemoteCodexAdapterOptions,
  "configuration" | "resolveRuntime" | "managedIdentity"
>;
const unmanaged: ServerSide = { configuration: { config, environment: [] } };
// The server's identity matches the runtime its resolver builds.
const managedSide = (runtime: CodexEffectiveRuntime): ServerSide => ({
  configuration: {
    config: decodeSettings({ setupMode: "managed" }),
    environment: [],
  },
  resolveRuntime: Effect.succeed(runtime),
  managedIdentity: Effect.succeed({
    instanceId,
    homePath: managedHome,
    route: { launchArgs: runtime.config.launchArgs, profileKey: runtime.revision },
  }),
});
const managed = managedSide(managedRuntime);

type RawCommand = Pick<
  Extract<Protocol.ClientMessage, { readonly type: "command" }>,
  "operation" | "payload" | "sessionId" | "effectiveRuntime"
>;
// Sends each command after the previous reply, without the checks of the current adapter.
// The host keeps command receipts per instance, so each client names its own commands.
const sendRaw = (socketPath: string, commands: ReadonlyArray<RawCommand>, client = "raw") =>
  Effect.promise(
    () =>
      new Promise<ReadonlyArray<Protocol.ServerMessage>>((resolve) => {
        const socket = NodeNet.createConnection(socketPath);
        socket.setEncoding("utf8");
        const replies: Array<Protocol.ServerMessage> = [];
        let buffer = "";
        let lease = 0;
        const sendNext = () => {
          const command = commands[replies.length];
          if (command === undefined) {
            socket.destroy();
            resolve(replies);
            return;
          }
          const id = `${client}:${replies.length}`;
          socket.write(
            Protocol.encodeClient({
              type: "command",
              lease,
              commandId: id,
              requestId: id,
              ...command,
            }),
          );
        };
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
            const message = Protocol.decode(
              Protocol.ServerMessage,
              JSON.parse(buffer.slice(0, end)),
            );
            buffer = buffer.slice(end + 1);
            if (message.type === "subscribed") lease = message.lease;
            else if (message.type === "response" || message.type === "error") replies.push(message);
            else continue;
            sendNext();
          }
        });
        socket.once("connect", () =>
          socket.write(
            Protocol.encodeClient({
              type: "subscribe",
              protocolVersion: Protocol.PROTOCOL_VERSION,
              instanceId,
              after: 0,
            }),
          ),
        );
      }),
  );
type HostLease = { readonly hostId: string; readonly lease: number };
type Reply = Protocol.ServerMessage | undefined;
const subscribeRaw = (
  socketPath: string,
  fields: { readonly previousLease?: HostLease; readonly protocolVersion?: number } = {},
) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly socket: NodeNet.Socket; readonly reply: Reply }>(
          (resolve, reject) => {
            const socket = NodeNet.createConnection(socketPath);
            let buffer = "";
            socket.setEncoding("utf8");
            socket.once("error", reject);
            socket.once("close", () => resolve({ socket, reply: undefined }));
            socket.on("data", (chunk: string) => {
              buffer += chunk;
              const newline = buffer.indexOf("\n");
              if (newline < 0) return;
              const reply = Protocol.decode(
                Protocol.ServerMessage,
                JSON.parse(buffer.slice(0, newline)),
              );
              resolve({ socket, reply });
            });
            socket.once("connect", () =>
              socket.write(
                JSON.stringify({
                  type: "subscribe",
                  protocolVersion: Protocol.PROTOCOL_VERSION,
                  instanceId,
                  after: 0,
                  ...fields,
                }) + "\n",
              ),
            );
          },
        ),
    ),
    ({ socket }) => Effect.sync(() => socket.destroy()),
  ).pipe(Effect.map(({ reply }) => reply));
const leaseOf = (reply: Reply): HostLease => {
  if (reply?.type !== "subscribed") throw new Error(`Expected a subscription, got ${reply?.type}.`);
  return { hostId: reply.hostId, lease: reply.lease };
};
const remote = (socketPath: string, server: ServerSide = unmanaged) =>
  makeRemoteCodexAdapter({
    socketPath,
    instanceId,
    ...server,
    onContinuation: () => Effect.void,
    canReuseContextUsage: canReuseCodexContextUsage,
  });
const fakeHost = (answer: (socket: NodeNet.Socket) => void) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "campfire-fake-host-" });
    const socketPath = `${temp}/host.sock`;
    let markReconnected = () => {};
    const reconnected = new Promise<void>((resolve) => {
      markReconnected = resolve;
    });
    const sockets = new Set<NodeNet.Socket>();
    const server = NodeNet.createServer((socket) => {
      sockets.add(socket);
      if (sockets.size === 2) markReconnected();
      socket.once("data", () => answer(socket));
    });
    yield* Effect.acquireRelease(
      Effect.promise(() => new Promise<void>((resolve) => server.listen(socketPath, resolve))),
      () =>
        Effect.promise(() => {
          for (const socket of sockets) socket.destroy();
          return new Promise<void>((resolve) => server.close(() => resolve()));
        }),
    );
    return { socketPath, reconnected: Effect.promise(() => reconnected) };
  });

// Sends every command at once and reports each reply as it arrives.
const sendPipelined = (
  socketPath: string,
  commands: ReadonlyArray<RawCommand>,
  onReply: (reply: Protocol.ServerMessage) => void,
) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        const socket = NodeNet.createConnection(socketPath);
        socket.setEncoding("utf8");
        let buffer = "";
        let replies = 0;
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
            const message = Protocol.decode(
              Protocol.ServerMessage,
              JSON.parse(buffer.slice(0, end)),
            );
            buffer = buffer.slice(end + 1);
            if (message.type === "subscribed")
              for (const [index, command] of commands.entries())
                socket.write(
                  Protocol.encodeClient({
                    type: "command",
                    lease: message.lease,
                    commandId: `pipelined:${index}`,
                    requestId: `pipelined:${index}`,
                    ...command,
                  }),
                );
            if (message.type !== "response" && message.type !== "error") continue;
            onReply(message);
            if (++replies === commands.length) {
              socket.destroy();
              resolve();
            }
          }
        });
        socket.once("connect", () =>
          socket.write(
            Protocol.encodeClient({
              type: "subscribe",
              protocolVersion: Protocol.PROTOCOL_VERSION,
              instanceId,
              after: 0,
            }),
          ),
        );
      }),
  );

// Subscribes the client to a fake host process with this id, then hands each client frame on.
const acceptAs = (
  socket: NodeNet.Socket,
  hostId: string,
  handle: (message: Protocol.ClientMessage) => void,
) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      handle(Protocol.decode(Protocol.ClientMessage, JSON.parse(buffer.slice(0, end))));
      buffer = buffer.slice(end + 1);
    }
  });
  socket.write(
    Protocol.encodeServer({
      type: "subscribed",
      protocolVersion: Protocol.PROTOCOL_VERSION,
      hostId,
      lease: 1,
      committed: 0,
    }),
  );
};
const answer = (socket: NodeNet.Socket, message: Protocol.ClientMessage) => {
  if (message.type !== "command") return;
  socket.write(
    Protocol.encodeServer({
      type: "response",
      requestId: message.requestId,
      result:
        message.operation === "capabilities"
          ? Protocol.encode(Protocol.Capabilities, CodexProviderCapabilitiesV2)
          : Protocol.encode(Schema.Void, undefined),
    }),
  );
};

const continuation = (sequence: number) =>
  Protocol.encodeServer({
    type: "continuation",
    lease: 1,
    sequence,
    request: { threadId, providerThreadId: providerThread.id, driver, detail: null },
  });
// Restarts a fake host while the client still runs the first frame of the old host.
const restartDuringDelivery = (oldDelivery: Promise<void>) =>
  Effect.gen(function* () {
    let epoch = 0;
    const first = Promise.withResolvers<NodeNet.Socket>();
    const replacement = Promise.withResolvers<NodeNet.Socket>();
    const delivering = Promise.withResolvers<void>();
    const acks: Array<number> = [];
    const acked = Promise.withResolvers<"acked" | "closed">();
    const host = yield* fakeHost((socket) => {
      const current = ++epoch;
      if (current === 1) first.resolve(socket);
      else socket.once("close", () => acked.resolve("closed"));
      acceptAs(socket, `host-${current}`, (message) => {
        if (message.type !== "ack") answer(socket, message);
        if (current === 1) return;
        if (message.type === "ack") {
          acks.push(message.sequence);
          acked.resolve("acked");
        } else if (message.type === "command") replacement.resolve(socket);
      });
    });
    let deliveries = 0;
    yield* makeRemoteCodexAdapter({
      socketPath: host.socketPath,
      instanceId,
      ...unmanaged,
      onContinuation: () =>
        ++deliveries === 1
          ? Effect.promise(() => {
              delivering.resolve();
              return oldDelivery;
            })
          : Effect.void,
      canReuseContextUsage: canReuseCodexContextUsage,
    });
    const old = yield* Effect.promise(() => first.promise);
    old.write(continuation(9));
    yield* Effect.promise(() => delivering.promise);
    old.destroy();
    const next = yield* Effect.promise(() => replacement.promise);
    return { next, acks, acked: Effect.promise(() => acked.promise) };
  });

const makeFixture = (
  options: {
    readonly maxBufferBytes?: number;
    readonly beforeClose?: Effect.Effect<void>;
    /** False stands for a host that accepts any runtime, such as a release before the check. */
    readonly checksRuntime?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const { maxBufferBytes, beforeClose = Effect.void, checksRuntime = true } = options;
    const fs = yield* FileSystem.FileSystem;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "campfire-host-" });
    const socketPath = `${temp}/host.sock`;
    const events = yield* Queue.unbounded<Adapter.ProviderAdapterV2Event>();
    const closed = yield* Queue.unbounded<void>();
    let opens = 0;
    let closes = 0;
    let starts = 0;
    const closesAtOpens: Array<number> = [];
    const launches: Array<{
      readonly configuration: typeof Protocol.Configuration.Type;
      readonly runtime: typeof Protocol.EffectiveRuntime.Type | undefined;
    }> = [];
    const unsupported = Effect.fail(
      new Adapter.ProviderAdapterProtocolError({ driver, detail: "Unused fake operation." }),
    );
    const adapter = Adapter.ProviderAdapterV2.of({
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
      openSession: () =>
        Effect.gen(function* () {
          opens++;
          closesAtOpens.push(closes);
          yield* Effect.addFinalizer(() =>
            beforeClose.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  closes++;
                }),
              ),
              Effect.andThen(Queue.offer(closed, undefined)),
            ),
          );
          return {
            instanceId,
            driver,
            providerSessionId: sessionId,
            providerSession: session,
            events: Stream.fromQueue(events),
            ensureThread: () => Effect.succeed(providerThread),
            resumeThread: () => Effect.succeed(providerThread),
            startTurn: () =>
              Effect.sync(() => {
                starts++;
              }),
            steerTurn: () => Effect.void,
            interruptTurn: () => Effect.void,
            respondToRuntimeRequest: () => Effect.void,
            readThreadSnapshot: () => unsupported,
            rollbackThread: () => unsupported,
            forkThread: () => unsupported,
          } satisfies Adapter.ProviderAdapterV2SessionRuntime;
        }),
    });
    const start = () =>
      startCodexProviderHostServer({
        socketPath,
        ...(maxBufferBytes === undefined ? {} : { maxBufferBytes }),
        checkRuntime: async ({ instanceId, configuration, runtime }) =>
          checksRuntime
            ? managedCodexRuntimeProblem(
                { instanceId, homePath: configuration.config.homePath || managedHome },
                runtime,
              )
            : undefined,
        createAdapter: async (configuration) => ({
          adapter,
          setMcpSessions: async () => {},
          openSession: (input, runtime, scope) =>
            Effect.sync(() => launches.push({ configuration, runtime })).pipe(
              Effect.andThen(adapter.openSession(input)),
              Effect.provideService(Scope.Scope, scope),
            ),
          close: async () => {},
        }),
      });
    let host = yield* Effect.promise(start);
    yield* Effect.addFinalizer(() => Effect.promise(() => host.close()));
    const closeHost = Effect.promise(() => host.close());
    const restartHost = closeHost.pipe(
      Effect.andThen(
        Effect.promise(async () => {
          host = await start();
        }),
      ),
    );
    const connect = (scope: Scope.Closeable, server: ServerSide = unmanaged) =>
      remote(socketPath, server).pipe(Effect.provideService(Scope.Scope, scope));
    return {
      socketPath,
      closeHost,
      restartHost,
      connect,
      events,
      closed,
      counts: () => ({ opens, closes, starts }),
      closesAtOpens: () => closesAtOpens,
      homes: () =>
        launches.map(({ configuration, runtime }) => (runtime ?? configuration).config.homePath),
      launchArgs: () => launches.map(({ runtime }) => runtime?.config.launchArgs),
    };
  });

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, McpProviderSessions.layer))(
  "Codex provider host V2",
  (it) => {
    it.effect(
      "keeps the same runtime and replays offline events after backend replacement without repeating a turn",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeFixture();
          const firstScope = yield* Scope.make();
          const first = yield* fixture.connect(firstScope);
          const firstSession = yield* first
            .openSession(openInput)
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          yield* firstSession.startTurn(turn);
          yield* Scope.close(firstScope, Exit.void);
          expect(fixture.counts()).toEqual({ opens: 1, starts: 1, closes: 0 });
          const offlineEvent: Adapter.ProviderAdapterV2Event = {
            type: "provider_thread.updated",
            driver,
            providerThread: { ...providerThread, status: "idle" },
          };
          yield* Queue.offer(fixture.events, offlineEvent);
          const nextScope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(nextScope, Exit.void));
          const next = yield* fixture.connect(nextScope);
          const hosted = yield* next.hostedSessions!;
          expect(hosted).toHaveLength(1);
          expect(hosted[0]?.turns[0]?.attemptId).toBe(turn.attemptId);
          const resumed = yield* next
            .openSession(openInput)
            .pipe(Effect.provideService(Scope.Scope, nextScope));
          const output = yield* resumed.events.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* resumed.externalLifetime!.replay;
          expect(yield* Fiber.join(output)).toMatchObject([
            { type: "provider_thread.updated", providerThread: { status: "idle" } },
          ]);
          yield* resumed.startTurn(turn);
          expect(fixture.counts()).toEqual({ opens: 1, starts: 1, closes: 0 });
          yield* resumed.externalLifetime!.stop;
          expect(fixture.counts().closes).toBe(1);
        }),
    );

    it.effect("sends a managed instance's own runtime again when its closed session reopens", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const ownerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        const client = yield* fixture.connect(ownerScope, managed);
        const idleScope = yield* Scope.make();
        const idle = yield* client
          .openSession(openInput)
          .pipe(Effect.provideService(Scope.Scope, idleScope));
        yield* idle.externalLifetime!.stop;
        yield* Scope.close(idleScope, Exit.void);
        yield* client.openSession(openInput).pipe(Effect.provideService(Scope.Scope, ownerScope));
        expect(fixture.homes()).toEqual([managedHome, managedHome]);
      }),
    );

    it.effect(
      "never restarts a managed session on the default home once its app-server exits",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeFixture();
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const owner = yield* fixture.connect(scope, managed);
          yield* owner.openSession(openInput).pipe(Effect.provideService(Scope.Scope, scope));
          const refused = {
            _tag: "ProviderAdapterProtocolError",
            detail: expect.stringContaining("own Codex home"),
          };
          const runtimeless = yield* fixture.connect(scope, {
            configuration: managed.configuration,
          });
          expect(yield* runtimeless.hostedSessions!).toEqual([]);
          expect(
            yield* runtimeless
              .openSession(openInput)
              .pipe(Effect.provideService(Scope.Scope, scope), Effect.flip),
          ).toMatchObject(refused);
          const homeless = yield* fixture.connect(scope, {
            ...managed,
            resolveRuntime: Effect.succeed({
              ...managedRuntime,
              config: { ...managedRuntime.config, homePath: "" },
              environment: {},
            }),
          });
          expect(
            yield* homeless
              .openSession(openInput)
              .pipe(Effect.provideService(Scope.Scope, scope), Effect.flip),
          ).toMatchObject(refused);
          expect(fixture.homes()).toEqual([managedHome]);
        }),
    );

    it.effect("never reattaches a managed instance to a session on the default login", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const directScope = yield* Scope.make();
        const direct = yield* fixture.connect(directScope);
        yield* direct.openSession(openInput).pipe(Effect.provideService(Scope.Scope, directScope));
        yield* Scope.close(directScope, Exit.void);
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const client = yield* fixture.connect(scope, managed);
        expect(yield* client.hostedSessions!).toEqual([]);
        yield* client.openSession(openInput).pipe(Effect.provideService(Scope.Scope, scope));
        expect(fixture.homes()).toEqual(["", managedHome]);
        expect(fixture.counts()).toMatchObject({ opens: 2, closes: 1 });
      }),
    );

    it.effect("stops a running direct session as soon as its instance is rebuilt as managed", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const direct = yield* fixture.connect(scope);
        const running = yield* direct
          .openSession(openInput)
          .pipe(Effect.provideService(Scope.Scope, scope));
        yield* running.startTurn(turn);
        yield* fixture.connect(scope, managed);
        expect(fixture.counts()).toEqual({ opens: 1, starts: 1, closes: 1 });
      }),
    );

    it.effect("never reattaches a direct session to an instance that now names another home", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const firstScope = yield* Scope.make();
        const first = yield* fixture.connect(firstScope);
        yield* first.openSession(openInput).pipe(Effect.provideService(Scope.Scope, firstScope));
        yield* Scope.close(firstScope, Exit.void);
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const otherHome = "/Users/someone/.codex-other";
        const moved = yield* fixture.connect(scope, {
          configuration: { config: decodeSettings({ homePath: otherHome }), environment: [] },
        });
        expect(yield* moved.hostedSessions!).toEqual([]);
        yield* moved.openSession(openInput).pipe(Effect.provideService(Scope.Scope, scope));
        expect(fixture.homes()).toEqual(["", otherHome]);
        expect(fixture.counts()).toMatchObject({ opens: 2, closes: 1 });
      }),
    );

    it.effect("refuses a runtime-less open while a managed configuration waits", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const direct = yield* fixture.connect(scope);
        yield* direct.openSession(openInput).pipe(Effect.provideService(Scope.Scope, scope));
        const next = ProviderSessionId.make("next");
        const replies = yield* sendRaw(fixture.socketPath, [
          {
            operation: "configure",
            payload: Protocol.encode(Protocol.Configuration, managed.configuration),
          },
          {
            operation: "openSession",
            sessionId: next,
            payload: Protocol.encode(Protocol.OpenSession, {
              ...openInput,
              providerSessionId: next,
            }),
          },
        ]);
        expect(replies.map((reply) => reply.type)).toEqual(["response", "error"]);
        expect(fixture.homes()).toEqual([""]);
      }),
    );

    it.effect("drops a waiting configuration once the active configuration is asked again", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const original = yield* fixture.connect(scope);
        yield* original.openSession(openInput).pipe(Effect.provideService(Scope.Scope, scope));
        yield* fixture.connect(scope, {
          configuration: {
            config: decodeSettings({ homePath: "/scratch/direct" }),
            environment: [],
          },
        });
        const reverted = yield* fixture.connect(scope);
        expect(yield* reverted.hostedSessions!).toHaveLength(1);
        yield* reverted.openSession(openInput).pipe(Effect.provideService(Scope.Scope, scope));
        expect(fixture.homes()).toEqual([""]);
        expect(fixture.counts()).toMatchObject({ opens: 1, closes: 0 });
      }),
    );

    it.effect("refuses to hand a session to a request with another login and stops it", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const direct = yield* fixture.connect(scope);
        yield* direct.openSession(openInput).pipe(Effect.provideService(Scope.Scope, scope));
        const open = (effectiveRuntime?: CodexEffectiveRuntime): RawCommand => ({
          operation: "openSession",
          sessionId,
          payload: Protocol.encode(Protocol.OpenSession, openInput),
          ...(effectiveRuntime === undefined ? {} : { effectiveRuntime }),
        });
        const replies = yield* sendRaw(fixture.socketPath, [
          {
            operation: "configure",
            payload: Protocol.encode(Protocol.Configuration, managed.configuration),
          },
          open(managedRuntime),
          open(managedRuntime),
          open(),
        ]);
        expect(replies.map((reply) => reply.type)).toEqual([
          "response",
          "error",
          "response",
          "response",
        ]);
        expect(fixture.homes()).toEqual(["", managedHome]);
        expect(fixture.counts()).toMatchObject({ opens: 2, closes: 1 });
      }),
    );

    it.effect("checks a reused managed runtime against the configuration that waits", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const owner = yield* fixture.connect(scope, managed);
        yield* owner.openSession(openInput).pipe(Effect.provideService(Scope.Scope, scope));
        const reuse = (config: CodexSettings, client: string) =>
          sendRaw(
            fixture.socketPath,
            [
              {
                operation: "configure",
                payload: Protocol.encode(Protocol.Configuration, { config, environment: [] }),
              },
              {
                operation: "openSession",
                sessionId,
                payload: Protocol.encode(Protocol.OpenSession, openInput),
                effectiveRuntime: managedRuntime,
              },
            ],
            client,
          );
        const moved = yield* reuse(
          decodeSettings({ setupMode: "managed", homePath: "/state/codex-homes/moved" }),
          "moved",
        );
        expect(moved.map((reply) => reply.type)).toEqual(["response", "error"]);
        expect(fixture.counts()).toMatchObject({ opens: 1, closes: 0 });
        const changed = yield* reuse(
          decodeSettings({ setupMode: "managed", binaryPath: "/opt/codex/bin/codex" }),
          "changed",
        );
        expect(changed.map((reply) => reply.type)).toEqual(["response", "error"]);
        expect(fixture.counts()).toMatchObject({ opens: 1, closes: 1 });
      }),
    );

    it.effect("reopens a managed session that still names a replaced server's token broker", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const firstScope = yield* Scope.make();
        const first = yield* fixture.connect(firstScope, managed);
        yield* first.openSession(openInput).pipe(Effect.provideService(Scope.Scope, firstScope));
        yield* Scope.close(firstScope, Exit.void);
        const nextScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(nextScope, Exit.void));
        const nextRuntime = brokeredRuntime("/tmp/t3-token-next/s");
        const next = yield* fixture.connect(nextScope, managedSide(nextRuntime));
        expect(yield* next.hostedSessions!).toEqual([]);
        yield* next.openSession(openInput).pipe(Effect.provideService(Scope.Scope, nextScope));
        expect(fixture.launchArgs()).toEqual([
          managedRuntime.config.launchArgs,
          nextRuntime.config.launchArgs,
        ]);
        expect(fixture.counts()).toMatchObject({ opens: 2, closes: 1 });
      }),
    );

    it.effect("never hands a retired session's buffered output to its replacement", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const firstScope = yield* Scope.make();
        const first = yield* fixture.connect(firstScope, managed);
        const retired = yield* first
          .openSession(openInput)
          .pipe(Effect.provideService(Scope.Scope, firstScope));
        const status = (lastError: string): Adapter.ProviderAdapterV2Event => ({
          type: "provider_session.updated",
          driver,
          providerSession: { ...session, lastError },
        });
        yield* Queue.offer(fixture.events, status("retired session"));
        expect(yield* retired.events.pipe(Stream.take(1), Stream.runCollect)).toMatchObject([
          status("retired session"),
        ]);
        yield* Scope.close(firstScope, Exit.void);
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const next = yield* fixture.connect(scope, managed);
        expect(yield* next.hostedSessions!).toEqual([]);
        const replacement = yield* next
          .openSession(openInput)
          .pipe(Effect.provideService(Scope.Scope, scope));
        expect(fixture.counts()).toMatchObject({ opens: 2, closes: 1 });
        yield* Queue.offer(fixture.events, status("replacement session"));
        expect(yield* replacement.events.pipe(Stream.take(1), Stream.runCollect)).toMatchObject([
          status("replacement session"),
        ]);
      }),
    );

    it.effect("never reopens a hosted session before its unconfirmed close completes", () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          beforeClose: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
          ),
        });
        const firstScope = yield* Scope.make();
        const first = yield* fixture.connect(firstScope, managed);
        yield* first.openSession(openInput).pipe(Effect.provideService(Scope.Scope, firstScope));
        yield* Scope.close(firstScope, Exit.void);
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        yield* Effect.addFinalizer(() => Deferred.succeed(finish, undefined));
        const connecting = yield* fixture.connect(scope, managed).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("3 seconds");
        const next = yield* Fiber.join(connecting);
        expect(yield* next.hostedSessions!).toEqual([]);
        const early = yield* next
          .openSession(openInput)
          .pipe(Effect.provideService(Scope.Scope, scope), Effect.exit);
        expect(Exit.isFailure(early)).toBe(true);
        expect(fixture.counts()).toMatchObject({ opens: 1, closes: 0 });
        yield* Deferred.succeed(finish, undefined);
        yield* Queue.take(fixture.closed);
        expect(yield* next.hostedSessions!).toEqual([]);
        yield* next.openSession(openInput).pipe(Effect.provideService(Scope.Scope, scope));
        expect(fixture.counts()).toMatchObject({ opens: 2, closes: 1 });
      }),
    );

    it.effect(
      "answers a close or an open of a session only after its earlier close completes",
      () =>
        Effect.gen(function* () {
          const finish = yield* Deferred.make<void>();
          const fixture = yield* makeFixture({ beforeClose: Deferred.await(finish) });
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          yield* Effect.addFinalizer(() => Deferred.succeed(finish, undefined));
          const direct = yield* fixture.connect(scope);
          yield* direct.openSession(openInput).pipe(Effect.provideService(Scope.Scope, scope));
          const close: RawCommand = { operation: "closeSession", sessionId, payload: null };
          const closesAtReply = new Map<string, number>();
          yield* sendPipelined(
            fixture.socketPath,
            [
              close,
              close,
              {
                operation: "openSession",
                sessionId,
                payload: Protocol.encode(Protocol.OpenSession, openInput),
              },
              { operation: "capabilities", payload: null },
            ],
            (reply) => {
              if (reply.type !== "response" && reply.type !== "error") return;
              closesAtReply.set(reply.requestId, fixture.counts().closes);
              if (reply.requestId === "pipelined:3") Deferred.doneUnsafe(finish, Effect.void);
            },
          );
          expect(Object.fromEntries(closesAtReply)).toEqual({
            "pipelined:0": 1,
            "pipelined:1": 1,
            "pipelined:2": 1,
            "pipelined:3": 0,
          });
          expect(fixture.closesAtOpens()).toEqual([0, 1]);
        }),
    );

    it.effect("never sends a managed runtime that its server's own token route refuses", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ checksRuntime: false });
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const client = yield* fixture.connect(scope, {
          ...managed,
          resolveRuntime: Effect.succeed(brokeredRuntime("/tmp/t3-token-other/s")),
        });
        expect(
          yield* client
            .openSession(openInput)
            .pipe(Effect.provideService(Scope.Scope, scope), Effect.flip),
        ).toMatchObject({ _tag: "ProviderAdapterProtocolError" });
        expect(fixture.homes()).toEqual([]);
      }),
    );

    it.effect("refuses a managed runtime with another home or without its token broker", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const foreignHome = "/Users/someone/.codex";
        const open = (name: string, effectiveRuntime: CodexEffectiveRuntime): RawCommand => {
          const providerSessionId = ProviderSessionId.make(name);
          return {
            operation: "openSession",
            sessionId: providerSessionId,
            payload: Protocol.encode(Protocol.OpenSession, { ...openInput, providerSessionId }),
            effectiveRuntime,
          };
        };
        const replies = yield* sendRaw(fixture.socketPath, [
          {
            operation: "configure",
            payload: Protocol.encode(Protocol.Configuration, managed.configuration),
          },
          open("foreign-home", {
            ...managedRuntime,
            config: { ...managedRuntime.config, homePath: foreignHome },
            environment: { CODEX_HOME: foreignHome },
          }),
          open("no-broker", {
            ...managedRuntime,
            config: { ...managedRuntime.config, launchArgs: "" },
          }),
        ]);
        expect(replies.map((reply) => reply.type)).toEqual(["response", "error", "error"]);
        expect(fixture.homes()).toEqual([]);
      }),
    );

    it.effect("fences the replaced owner instead of letting reconnect steal the new lease", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const firstScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
        const first = yield* fixture.connect(firstScope);
        const firstSession = yield* first
          .openSession(openInput)
          .pipe(Effect.provideService(Scope.Scope, firstScope));
        const failedStream = yield* firstSession.events.pipe(
          Stream.runDrain,
          Effect.exit,
          Effect.forkScoped,
        );
        const replacementScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(replacementScope, Exit.void));
        const replacement = yield* fixture.connect(replacementScope);
        expect(Exit.isFailure(yield* Fiber.join(failedStream))).toBe(true);
        expect(yield* replacement.getCapabilities()).toEqual(CodexProviderCapabilitiesV2);
        expect(fixture.counts().closes).toBe(0);
      }),
    );
    it.effect("takes a fresh lease from a restarted provider host and keeps serving", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const client = yield* fixture.connect(scope);
        const lost = yield* client
          .openSession(openInput)
          .pipe(Effect.provideService(Scope.Scope, scope));
        const ended = yield* lost.events.pipe(Stream.runDrain, Effect.flip, Effect.forkScoped);
        yield* fixture.restartHost;
        expect(yield* Fiber.join(ended)).toMatchObject({
          _tag: "ProviderAdapterProtocolError",
          detail: expect.stringContaining("restarted"),
        });
        yield* client.openSession(openInput).pipe(Effect.provideService(Scope.Scope, scope));
        expect(fixture.counts().opens).toBe(2);
      }),
    );
    it.effect("gives a restarted host to its first owner and fences every stale lease", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const superseded = { type: "fatal", detail: "Provider-host owner has been superseded." };
        const earlier = leaseOf(yield* subscribeRaw(fixture.socketPath));
        yield* fixture.restartHost;
        const owner = leaseOf(yield* subscribeRaw(fixture.socketPath, { previousLease: earlier }));
        expect(owner.hostId).not.toBe(earlier.hostId);
        expect(owner.lease).toBe(1);
        expect(yield* subscribeRaw(fixture.socketPath, { previousLease: earlier })).toEqual(
          superseded,
        );
        leaseOf(yield* subscribeRaw(fixture.socketPath));
        expect(yield* subscribeRaw(fixture.socketPath, { previousLease: owner })).toEqual(
          superseded,
        );
      }),
    );
    it.effect("tells a server that speaks another protocol why the host refuses it", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const other = Protocol.PROTOCOL_VERSION + 1;
        expect(yield* subscribeRaw(fixture.socketPath, { protocolVersion: other })).toMatchObject({
          type: "fatal",
          detail: expect.stringContaining(`protocol ${other}`),
        });
      }),
    );
    it.effect("refuses a provider host that speaks another protocol", () =>
      Effect.gen(function* () {
        const other = Protocol.PROTOCOL_VERSION + 1;
        const host = yield* fakeHost((socket) =>
          socket.write(
            JSON.stringify({
              type: "subscribed",
              protocolVersion: other,
              hostId: "other-release",
              lease: 1,
              committed: 0,
            }) + "\n",
          ),
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        expect(
          yield* remote(host.socketPath).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.flip,
          ),
        ).toMatchObject({
          _tag: "ProviderAdapterProtocolError",
          detail: expect.stringContaining(`protocol ${other}`),
        });
      }),
    );
    it.effect("names a provider host that hangs up on the subscription", () =>
      Effect.gen(function* () {
        const host = yield* fakeHost((socket) => socket.destroy());
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const connecting = yield* remote(host.socketPath).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.flip,
          Effect.forkScoped,
        );
        yield* host.reconnected;
        yield* TestClock.adjust("10 seconds");
        expect(yield* Fiber.join(connecting)).toMatchObject({
          _tag: "ProviderAdapterProtocolError",
          detail: expect.stringContaining("without an answer"),
        });
      }),
    );
    it.effect(
      "finishes startup on the host that answers after a restart during configuration",
      () =>
        Effect.gen(function* () {
          let epoch = 0;
          const host = yield* fakeHost((socket) => {
            const current = ++epoch;
            acceptAs(socket, `host-${current}`, (message) =>
              current === 1 ? socket.destroy() : answer(socket, message),
            );
          });
          expect(yield* remote(host.socketPath).pipe(Effect.exit)).toMatchObject({
            _tag: "Success",
          });
          expect(epoch).toBe(2);
        }),
    );
    it.effect("keeps serving when a restarted host drops the answer to its configuration", () =>
      Effect.gen(function* () {
        let epoch = 0;
        const first = Promise.withResolvers<NodeNet.Socket>();
        const thirdConfigured = Promise.withResolvers<void>();
        const host = yield* fakeHost((socket) => {
          const current = ++epoch;
          if (current === 1) first.resolve(socket);
          acceptAs(socket, `host-${current}`, (message) => {
            if (current === 2 && message.type === "command") return socket.destroy();
            answer(socket, message);
            if (current === 3) thirdConfigured.resolve();
          });
        });
        const client = yield* remote(host.socketPath);
        (yield* Effect.promise(() => first.promise)).destroy();
        yield* Effect.promise(() => thirdConfigured.promise);
        expect(yield* client.getCapabilities().pipe(Effect.exit)).toMatchObject({
          _tag: "Success",
          value: CodexProviderCapabilitiesV2,
        });
      }),
    );
    it.effect("closes cleanly while a restarted host has not answered its configuration", () =>
      Effect.gen(function* () {
        let epoch = 0;
        const first = Promise.withResolvers<NodeNet.Socket>();
        const configuring = Promise.withResolvers<void>();
        const host = yield* fakeHost((socket) => {
          const current = ++epoch;
          if (current === 1) first.resolve(socket);
          acceptAs(socket, `host-${current}`, (message) => {
            if (current === 1) answer(socket, message);
            else if (message.type === "command") configuring.resolve();
          });
        });
        const scope = yield* Scope.make();
        yield* remote(host.socketPath).pipe(Effect.provideService(Scope.Scope, scope));
        (yield* Effect.promise(() => first.promise)).destroy();
        yield* Effect.promise(() => configuring.promise);
        expect(yield* Scope.close(scope, Exit.void).pipe(Effect.exit)).toMatchObject({
          _tag: "Success",
        });
      }),
    );
    it.effect("never acknowledges a frame of a lost host on its replacement", () =>
      Effect.gen(function* () {
        const release = Promise.withResolvers<void>();
        const restart = yield* restartDuringDelivery(release.promise);
        release.resolve();
        restart.next.write(continuation(2));
        expect(yield* restart.acked).toBe("acked");
        expect(restart.acks).toEqual([2]);
      }),
    );
    it.effect("keeps serving the new host when a delivery of the lost host fails", () =>
      Effect.gen(function* () {
        const release = Promise.withResolvers<void>();
        const restart = yield* restartDuringDelivery(release.promise);
        release.reject(new Error("The callback of the lost host failed."));
        restart.next.write(continuation(2));
        expect(yield* restart.acked).toBe("acked");
        expect(restart.acks).toEqual([2]);
      }),
    );
    it.effect("never lets a lost session's handle act on its replacement", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const client = yield* fixture.connect(scope);
        const lost = yield* client
          .openSession(openInput)
          .pipe(Effect.provideService(Scope.Scope, scope));
        const ended = yield* lost.events.pipe(Stream.runDrain, Effect.flip, Effect.forkScoped);
        yield* fixture.restartHost;
        yield* Fiber.join(ended);
        const replacement = yield* client
          .openSession(openInput)
          .pipe(Effect.provideService(Scope.Scope, scope));
        yield* replacement.startTurn(turn);
        yield* lost
          .startTurn({ ...turn, attemptId: RunAttemptId.make("late-attempt") })
          .pipe(Effect.ignore);
        yield* lost.externalLifetime!.stop;
        expect(yield* client.hostedSessions!).toHaveLength(1);
        expect(fixture.counts()).toEqual({ opens: 2, starts: 1, closes: 1 });
      }),
    );
    it.effect("sends an open that never reached the lost host to its replacement", () =>
      Effect.gen(function* () {
        let epoch = 0;
        const first = Promise.withResolvers<NodeNet.Socket>();
        const waiting = Promise.withResolvers<NodeNet.Socket>();
        const outcome = Promise.withResolvers<string>();
        const host = yield* fakeHost((socket) => {
          const current = ++epoch;
          if (current === 1) {
            first.resolve(socket);
            acceptAs(socket, "host-1", (message) => answer(socket, message));
          } else waiting.resolve(socket);
        });
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const client = yield* remote(host.socketPath).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        (yield* Effect.promise(() => first.promise)).destroy();
        const replacement = yield* Effect.promise(() => waiting.promise);
        yield* client.openSession(openInput).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.tapCause((cause) => Effect.sync(() => outcome.resolve(Cause.pretty(cause)))),
          Effect.forkScoped,
        );
        acceptAs(replacement, "host-2", (message) => {
          if (message.type === "command" && message.operation === "openSession")
            outcome.resolve("the new host received the open");
          else answer(replacement, message);
        });
        expect(yield* Effect.promise(() => outcome.promise)).toBe("the new host received the open");
      }),
    );
    it.effect("fails waiting commands while a host hangs up, until a host answers again", () =>
      Effect.gen(function* () {
        let epoch = 0;
        let silent = true;
        const first = Promise.withResolvers<NodeNet.Socket>();
        const retried = Promise.withResolvers<void>();
        const answered = Promise.withResolvers<void>();
        const host = yield* fakeHost((socket) => {
          const current = ++epoch;
          if (current === 1) first.resolve(socket);
          if (current === 3) retried.resolve();
          if (current > 1 && silent) return socket.destroy();
          acceptAs(socket, `host-${current === 1 ? 1 : 2}`, (message) => {
            if (message.type === "ack") return answered.resolve();
            answer(socket, message);
            // The client acknowledges this frame only after it reads the answer before it.
            if (current > 1) socket.write(continuation(1));
          });
        });
        const client = yield* remote(host.socketPath);
        (yield* Effect.promise(() => first.promise)).destroy();
        yield* Effect.promise(() => retried.promise);
        const waiting = yield* client
          .getCapabilities()
          .pipe(Effect.flip, Effect.timeoutOption("20 seconds"), Effect.forkScoped);
        yield* TestClock.adjust("30 seconds");
        expect(yield* Fiber.join(waiting)).toMatchObject({
          _tag: "Some",
          value: {
            _tag: "ProviderAdapterProtocolError",
            detail: expect.stringContaining("without an answer"),
          },
        });
        expect(yield* client.getCapabilities().pipe(Effect.flip)).toMatchObject({
          detail: expect.stringContaining("without an answer"),
        });
        silent = false;
        yield* Effect.promise(() => answered.promise);
        expect(yield* client.getCapabilities()).toEqual(CodexProviderCapabilitiesV2);
      }),
    );
    it.effect("fails visibly and stops the native runtime when the replay buffer is full", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ maxBufferBytes: 100 });
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const client = yield* fixture.connect(scope);
        const runtime = yield* client
          .openSession(openInput)
          .pipe(Effect.provideService(Scope.Scope, scope));
        const failure = yield* runtime.events.pipe(Stream.runDrain, Effect.exit, Effect.forkScoped);
        yield* Queue.offer(fixture.events, {
          type: "provider_session.updated",
          driver,
          providerSession: { ...session, lastError: "x".repeat(512) },
        });
        yield* Queue.take(fixture.closed);
        expect(Exit.isFailure(yield* Fiber.join(failure))).toBe(true);
        expect(fixture.counts().closes).toBe(1);
      }),
    );
    it.effect(
      "closes private sessions on scope release and never advertises them for recovery",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeFixture();
          const ownerScope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
          const client = yield* fixture.connect(ownerScope);
          const privateScope = yield* Scope.make();
          yield* client
            .openSession({ ...openInput, lifetime: "ephemeral" })
            .pipe(Effect.provideService(Scope.Scope, privateScope));
          expect(yield* client.hostedSessions!).toEqual([]);
          yield* Scope.close(privateScope, Exit.void);
          expect(fixture.counts()).toEqual({ opens: 1, starts: 0, closes: 1 });
        }),
    );
    it.effect("releases a private scope when its provider host has disappeared", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const ownerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        const client = yield* fixture.connect(ownerScope);
        const privateScope = yield* Scope.make();
        yield* client
          .openSession({ ...openInput, lifetime: "ephemeral" })
          .pipe(Effect.provideService(Scope.Scope, privateScope));
        yield* fixture.closeHost;
        const close = yield* Scope.close(privateScope, Exit.void).pipe(Effect.forkScoped);
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(close);
        expect(fixture.counts().closes).toBe(1);
      }),
    );
    it.effect("stops private sessions left behind when a new backend replaces their owner", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const firstScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
        const first = yield* fixture.connect(firstScope);
        yield* first
          .openSession({ ...openInput, lifetime: "ephemeral" })
          .pipe(Effect.provideService(Scope.Scope, firstScope));
        const nextScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(nextScope, Exit.void));
        const next = yield* fixture.connect(nextScope);
        yield* Queue.take(fixture.closed);
        expect(yield* next.hostedSessions!).toEqual([]);
        expect(fixture.counts().closes).toBe(1);
      }),
    );
  },
);
