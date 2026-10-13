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
import { startCodexProviderHostServer } from "./CodexProviderHost.ts";
import { makeRemoteCodexAdapter } from "./RemoteCodexAdapter.ts";

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
const config = Schema.decodeSync(CodexSettings)({});
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

const makeFixture = (maxBufferBytes?: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "campfire-host-" });
    const socketPath = `${temp}/host.sock`;
    const events = yield* Queue.unbounded<Adapter.ProviderAdapterV2Event>();
    const closed = yield* Queue.unbounded<void>();
    let opens = 0;
    let closes = 0;
    let starts = 0;
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
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closes++;
            }).pipe(Effect.andThen(Queue.offer(closed, undefined))),
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
          createAdapter: async () => ({
            adapter,
            setMcpSessions: async () => {},
            openSession: (input, _runtime, scope) =>
              adapter.openSession(input).pipe(Effect.provideService(Scope.Scope, scope)),
            close: async () => {},
          }),
        }),
      ),
      (host) => Effect.promise(() => host.close()),
    );
    const connect = (scope: Scope.Closeable) =>
      makeRemoteCodexAdapter({
        socketPath,
        instanceId,
        configuration: { config, environment: [] },
        onContinuation: () => Effect.void,
        canReuseContextUsage: canReuseCodexContextUsage,
      }).pipe(Effect.provideService(Scope.Scope, scope));
    return { host, connect, events, closed, counts: () => ({ opens, closes, starts }) };
  });

it.layer(Layer.mergeAll(NodeServices.layer, McpProviderSessions.layer))(
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
        const fixture = yield* makeFixture(100);
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
