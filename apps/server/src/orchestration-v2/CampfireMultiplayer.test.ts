import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  SideThreadId,
  SideThreadMessageId,
  ThreadId,
  type ProviderSessionId,
} from "@t3tools/contracts";
import type {
  ProviderAdapterV2,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const unsupported = () => Effect.die("Unexpected provider operation in multiplayer soak");

it.live("runs five independent teammate turns without browsers and resumes 1000 durable events", () =>
  Effect.gen(function* () {
    const starts = yield* Queue.unbounded<{ readonly turn: ProviderAdapterV2TurnInput; readonly providerSessionId: ProviderSessionId }>();
    const adapter: ProviderAdapterV2["Service"] = {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (input) => Effect.gen(function* () {
        const now = yield* DateTime.now;
        const providerThread = {
          id: ProviderThreadId.make(`native:${input.threadId}`), driver: adapter.driver, providerInstanceId: instanceId,
          providerSessionId: input.providerSessionId, appThreadId: input.threadId, ownerNodeId: null,
          nativeThreadRef: null, nativeConversationHeadRef: null, status: "idle" as const,
          firstRunOrdinal: null, lastRunOrdinal: null, handoffIds: [], forkedFrom: null, createdAt: now, updatedAt: now,
        };
        return {
          instanceId, driver: adapter.driver, providerSessionId: input.providerSessionId,
          providerSession: { id: input.providerSessionId, driver: adapter.driver, providerInstanceId: instanceId, status: "ready", cwd: input.runtimePolicy.cwd ?? "/workspace", model: input.modelSelection.model, capabilities: CodexProviderCapabilitiesV2, createdAt: now, updatedAt: now, lastError: null },
          events: Stream.never,
          ensureThread: (thread) => Effect.succeed({ ...providerThread, id: ProviderThreadId.make(`native:${thread.threadId}`), appThreadId: thread.threadId }), resumeThread: unsupported,
          startTurn: (turn) => Queue.offer(starts, { turn, providerSessionId: input.providerSessionId }).pipe(Effect.asVoid),
          steerTurn: unsupported, interruptTurn: () => Effect.void, respondToRuntimeRequest: unsupported,
          readThreadSnapshot: unsupported, rollbackThread: unsupported, forkThread: unsupported,
        } satisfies ProviderAdapterV2SessionRuntime;
      }),
    };
    const database = SqlitePersistence.layerMemory;
    const layer = Layer.mergeAll(
      ProjectionStore.layer.pipe(Layer.provide(database)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "campfire-five-teammates" }, ProviderAdapterRegistry.layerFromAdapters([adapter]), { databaseLayer: database },
      ),
    );
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const now = DateTime.formatIso(yield* DateTime.now);
      const clients = yield* Effect.forEach(Array.from({ length: 5 }, (_, index) => index), (index) => Effect.gen(function* () { return {
        threadId: ThreadId.make(`thread:teammate:${index}`),
        user: { subject: `google:teammate:${index}`, displayName: `Teammate ${index}` },
        worktreePath: yield* checkpointWorkspace(`campfire-teammate-${index}`),
      }; }));
      yield* Effect.forEach(clients, (client) => Effect.gen(function* () {
        yield* orchestrator.dispatch({
          type: "thread.create", commandId: CommandId.make(`create:${client.threadId}`), threadId: client.threadId,
          projectId: ProjectId.make("project:multiplayer"), title: client.user.displayName, modelSelection,
          runtimeMode: "full-access", interactionMode: "default", branch: client.user.displayName, worktreePath: client.worktreePath,
          createdBy: "user", creationSource: "web", collaborationUser: client.user,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch", commandId: CommandId.make(`start:${client.threadId}`), threadId: client.threadId,
          messageId: MessageId.make(`message:${client.threadId}`), text: `Turn for ${client.user.displayName}`, attachments: [],
          dispatchMode: { type: "start_immediately" }, createdBy: "user", creationSource: "web", collaborationUser: client.user,
        });
        yield* orchestrator.dispatch({ type: "sidethread.create", commandId: CommandId.make(`discussion:${client.threadId}`), threadId: client.threadId, sideThreadId: SideThreadId.make(`thread:${client.threadId}`), collaborationUser: client.user, createdAt: now });
      }), { concurrency: "unbounded" });
      // Each receipt comes from the worker invoking a real session runtime. No
      // browser subscription exists while the five provider turns are starting.
      const started = yield* Effect.forEach(clients, () => Queue.take(starts));
      // Codex multiplexes native threads inside one session runtime. Isolation
      // belongs to each turn and provider thread, not to an extra process.
      assert.equal(new Set(started.map((item) => item.providerSessionId)).size, 1);
      assert.equal(new Set(started.map((item) => item.turn.providerThread.id)).size, 5);
      for (const client of clients) {
        const ownTurn = started.find((item) => item.turn.threadId === client.threadId);
        assert.ok(ownTurn);
        assert.equal(ownTurn.turn.runtimePolicy.cwd, client.worktreePath);
        const projection = yield* projections.getThreadProjection(client.threadId);
        assert.equal(projection.runs.filter((run) => run.status === "running").length, 1);
        assert.deepStrictEqual(projection.thread.collaborationCreatedBy, client.user);
        assert.deepStrictEqual(projection.messages.find((message) => message.role === "user")?.author, client.user);
      }
      yield* Effect.forEach(clients, (client) => Effect.forEach(Array.from({ length: 200 }, (_, index) => index), (index) => orchestrator.dispatch({
        type: "sidethread.message.post", commandId: CommandId.make(`post:${client.threadId}:${index}`), threadId: client.threadId,
        sideThreadId: SideThreadId.make(`thread:${client.threadId}`), messageId: SideThreadMessageId.make(`post:${client.threadId}:${index}`),
        text: `Durable message ${index}`, collaborationUser: client.user, createdAt: now,
      })), { concurrency: "unbounded" });
      yield* Effect.forEach(clients, (client) => Effect.gen(function* () {
        const reconnect = (afterSequence: number) => orchestrator.streamStoredEventsFrom({ threadId: client.threadId, afterSequence }).pipe(
          Stream.filter((stored) => stored.event.type === "sidethread.message-posted"), Stream.take(100), Stream.runCollect,
        );
        const first = yield* reconnect(0);
        const second = yield* reconnect(first.at(-1)!.sequence);
        const all = [...first, ...second];
        assert.equal(all.length, 200);
        assert.equal(new Set(all.map((stored) => stored.sequence)).size, 200);
        assert.deepStrictEqual(all.map((stored) => stored.event.type === "sidethread.message-posted" ? stored.event.payload.messageId : ""), Array.from({ length: 200 }, (_, index) => `post:${client.threadId}:${index}`));
        assert.isTrue(all.every((stored) => stored.event.threadId === client.threadId && stored.event.type === "sidethread.message-posted" && stored.event.payload.author.subject === client.user.subject));
        const snapshot = yield* projections.getThreadSnapshotWindow(client.threadId, { rowLimit: 40 });
        assert.equal(snapshot.projection.sideThreads?.[0]?.messages.length, 200);
      }), { concurrency: "unbounded" });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped), { timeout: 30_000 },
);
