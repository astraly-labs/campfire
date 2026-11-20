// @effect-diagnostics nodeBuiltinImport:off - a raw socket client speaks the host protocol like an older server.
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
type ServerSide = Pick<RemoteCodexAdapterOptions, "configuration" | "resolveRuntime">;
const unmanaged: ServerSide = { configuration: { config, environment: [] } };
const managed: ServerSide = {
  configuration: {
    config: decodeSettings({ setupMode: "managed" }),
    environment: [],
  },
  resolveRuntime: Effect.succeed(managedRuntime),
};

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

const makeFixture = (
  options: { readonly maxBufferBytes?: number; readonly beforeClose?: Effect.Effect<void> } = {},
) =>
  Effect.gen(function* () {
    const { maxBufferBytes, beforeClose = Effect.void } = options;
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
    const host = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startCodexProviderHostServer({
          socketPath,
          ...(maxBufferBytes === undefined ? {} : { maxBufferBytes }),
          checkRuntime: async ({ instanceId, configuration, runtime }) =>
            managedCodexRuntimeProblem(
              { instanceId, homePath: configuration.config.homePath || managedHome },
              runtime,
            ),
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
        }),
      ),
      (host) => Effect.promise(() => host.close()),
    );
    const connect = (scope: Scope.Closeable, server: ServerSide = unmanaged) =>
      makeRemoteCodexAdapter({
        socketPath,
        instanceId,
        ...server,
        onContinuation: () => Effect.void,
        canReuseContextUsage: canReuseCodexContextUsage,
      }).pipe(Effect.provideService(Scope.Scope, scope));
    return {
      host,
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
        const runtimeless = yield* fixture.connect(scope, {
          configuration: managed.configuration,
        });
        const refusal = yield* runtimeless
          .openSession({ ...openInput, providerSessionId: ProviderSessionId.make("next") })
          .pipe(Effect.provideService(Scope.Scope, scope), Effect.exit);
        expect(fixture.homes()).toEqual([""]);
        expect(refusal).toMatchObject({
          _tag: "Failure",
          cause: { reasons: [{ error: { _tag: "ProviderAdapterProtocolError" } }] },
        });
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
        const replies = yield* sendRaw(fixture.host.socketPath, [
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
            fixture.host.socketPath,
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
        const next = yield* fixture.connect(nextScope, {
          ...managed,
          resolveRuntime: Effect.succeed(nextRuntime),
        });
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
        const next = yield* fixture.connect(scope, managed);
        const listing = yield* next.hostedSessions!.pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("3 seconds");
        expect(yield* Fiber.join(listing)).toEqual([]);
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
            fixture.host.socketPath,
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

    it.effect("refuses a managed runtime with another home or without its token broker", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const foreignHome = "/Users/someone/.codex";
        const refusals = [];
        for (const [index, runtime] of [
          {
            ...managedRuntime,
            config: { ...managedRuntime.config, homePath: foreignHome },
            environment: { CODEX_HOME: foreignHome },
          },
          { ...managedRuntime, config: { ...managedRuntime.config, launchArgs: "" } },
        ].entries()) {
          const client = yield* fixture.connect(scope, {
            ...managed,
            resolveRuntime: Effect.succeed(runtime),
          });
          refusals.push(
            yield* client
              .openSession({
                ...openInput,
                providerSessionId: ProviderSessionId.make(`refused-${index}`),
              })
              .pipe(Effect.provideService(Scope.Scope, scope), Effect.exit),
          );
        }
        expect(fixture.homes()).toEqual([]);
        for (const refusal of refusals)
          expect(refusal).toMatchObject({
            _tag: "Failure",
            cause: { reasons: [{ error: { _tag: "ProviderAdapterProtocolError" } }] },
          });
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
        yield* Effect.promise(() => fixture.host.close());
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
