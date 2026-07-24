import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type CodexSettings,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { startCodexProviderHostServer, type HostedCodexAdapter } from "./CodexProviderHost.ts";
import { makeRemoteCodexAdapter } from "./RemoteCodexAdapter.ts";

const codex = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const config: CodexSettings = {
  enabled: true,
  binaryPath: "codex",
  homePath: "",
  shadowHomePath: "",
  launchArgs: "",
  customModels: [],
};

it.effect("keeps sessions alive and replays events across backend adapter restarts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-provider-host-" });
    const socketPath = path.join(tempDir, "provider.sock");
    const nativeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, ProviderSession>();
    let factoryCalls = 0;
    let hostCloses = 0;
    let stopAllCalls = 0;
    let sendTurnCalls = 0;

    const hosted: HostedCodexAdapter = {
      adapter: {
        provider: codex,
        capabilities: { sessionModelSwitch: "in-session" },
        startSession: (input) =>
          Effect.sync(() => {
            const session: ProviderSession = {
              provider: codex,
              providerInstanceId: instanceId,
              status: "ready",
              runtimeMode: input.runtimeMode,
              threadId: input.threadId,
              cwd: input.cwd,
              createdAt: "2026-07-23T10:00:00.000Z",
              updatedAt: "2026-07-23T10:00:00.000Z",
            };
            sessions.set(input.threadId, session);
            return session;
          }),
        sendTurn: (input) =>
          Effect.sync(() => {
            sendTurnCalls += 1;
            return {
              threadId: input.threadId,
              turnId: TurnId.make("turn-1"),
            };
          }),
        interruptTurn: () => Effect.void,
        respondToRequest: () => Effect.void,
        respondToUserInput: () => Effect.void,
        stopSession: (threadId) => Effect.sync(() => void sessions.delete(threadId)),
        listSessions: () => Effect.sync(() => Array.from(sessions.values())),
        hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
        readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
        rollbackThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
        stopAll: () =>
          Effect.sync(() => {
            stopAllCalls += 1;
            sessions.clear();
          }),
        streamEvents: Stream.fromQueue(nativeEvents),
      } satisfies ProviderAdapterShape<never>,
      close: async () => {
        hostCloses += 1;
      },
    };

    const host = yield* Effect.promise(() =>
      startCodexProviderHostServer({
        socketPath,
        createAdapter: async () => {
          factoryCalls += 1;
          return hosted;
        },
        ackCommitGraceMs: 5_000,
      }),
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => host.close()));

    const firstScope = yield* Scope.make();
    const first = yield* makeRemoteCodexAdapter({
      socketPath,
      instanceId,
      config,
      environment: [],
    }).pipe(Effect.provideService(Scope.Scope, firstScope));
    const threadId = ThreadId.make("thread-survives-restart");
    yield* first.startSession({
      threadId,
      provider: codex,
      providerInstanceId: instanceId,
      runtimeMode: "approval-required",
    });
    yield* first.sendTurn({
      threadId,
      idempotencyKey: "command:turn-survives-restart",
      input: "keep going",
    });

    const event: ProviderRuntimeEvent = {
      type: "runtime.warning",
      eventId: EventId.make("event-during-backend-restart"),
      provider: codex,
      providerInstanceId: instanceId,
      threadId,
      createdAt: "2026-07-23T10:00:01.000Z",
      payload: { message: "buffered while the backend is offline" },
    };
    yield* Queue.offer(nativeEvents, event);
    const delivered = yield* Stream.runHead(first.streamEvents);
    expect(Option.getOrUndefined(delivered)?.eventId).toBe(event.eventId);
    // This request is ordered after the event ACK on the same socket, proving
    // the host's grace window replays even an event the old backend ACKed.
    expect(yield* first.hasSession(threadId)).toBe(true);
    yield* Scope.close(firstScope, Exit.void);

    expect(stopAllCalls).toBe(0);
    expect(sessions.has(threadId)).toBe(true);

    const secondScope = yield* Scope.make();
    const second = yield* makeRemoteCodexAdapter({
      socketPath,
      instanceId,
      config,
      environment: [],
    }).pipe(Effect.provideService(Scope.Scope, secondScope));
    expect(yield* second.hasSession(threadId)).toBe(true);
    const repeated = yield* second.sendTurn({
      threadId,
      idempotencyKey: "command:turn-survives-restart",
      input: "keep going",
    });
    expect(repeated.turnId).toBe(TurnId.make("turn-1"));
    expect(sendTurnCalls).toBe(1);
    const replayed = yield* Stream.runHead(second.streamEvents).pipe(Effect.timeout("2 seconds"));
    expect(Option.getOrUndefined(replayed)?.eventId).toBe(event.eventId);
    expect(factoryCalls).toBe(1);

    yield* Scope.close(secondScope, Exit.void);
    expect(stopAllCalls).toBe(0);
    yield* Effect.promise(() => host.close());
    expect(hostCloses).toBe(1);
  }).pipe(Effect.provide(NodeServices.layer)),
);
