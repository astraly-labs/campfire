import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  type CollaborationUser,
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  SideThreadId,
  SideThreadMessageId,
  ThreadId,
  type ProviderSessionId,
} from "@t3tools/contracts";
import type {
  ProviderAdapterV2,
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UserMemory from "../persistence/UserMemory.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as TurnAuthorService from "./TurnAuthorService.ts";

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const unsupported = () => Effect.die("Unexpected provider operation in multiplayer soak");

it.live(
  "runs five independent teammate turns without browsers and resumes 1000 durable events",
  () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<{
        readonly turn: ProviderAdapterV2TurnInput;
        readonly providerSessionId: ProviderSessionId;
      }>();
      const adapter: ProviderAdapterV2["Service"] = {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const providerThread = {
              id: ProviderThreadId.make(`native:${input.threadId}`),
              driver: adapter.driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: input.threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle" as const,
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            };
            return {
              instanceId,
              driver: adapter.driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver: adapter.driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd: input.runtimePolicy.cwd ?? "/workspace",
                model: input.modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.never,
              ensureThread: (thread) =>
                Effect.succeed({
                  ...providerThread,
                  id: ProviderThreadId.make(`native:${thread.threadId}`),
                  appThreadId: thread.threadId,
                }),
              resumeThread: unsupported,
              startTurn: (turn) =>
                Queue.offer(starts, { turn, providerSessionId: input.providerSessionId }).pipe(
                  Effect.asVoid,
                ),
              steerTurn: unsupported,
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: unsupported,
              readThreadSnapshot: unsupported,
              rollbackThread: unsupported,
              forkThread: unsupported,
            } satisfies ProviderAdapterV2SessionRuntime;
          }),
      };
      const database = SqlitePersistence.layerMemory;
      const layer = Layer.mergeAll(
        ProjectionStore.layer.pipe(Layer.provide(database)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "campfire-five-teammates" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { databaseLayer: database },
        ),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const now = DateTime.formatIso(yield* DateTime.now);
        const clients = yield* Effect.forEach(
          Array.from({ length: 5 }, (_, index) => index),
          (index) =>
            Effect.gen(function* () {
              return {
                threadId: ThreadId.make(`thread:teammate:${index}`),
                user: { subject: `google:teammate:${index}`, displayName: `Teammate ${index}` },
                worktreePath: yield* checkpointWorkspace(`campfire-teammate-${index}`),
              };
            }),
        );
        yield* Effect.forEach(
          clients,
          (client) =>
            Effect.gen(function* () {
              yield* orchestrator.dispatch({
                type: "thread.create",
                commandId: CommandId.make(`create:${client.threadId}`),
                threadId: client.threadId,
                projectId: ProjectId.make("project:multiplayer"),
                title: client.user.displayName,
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: client.user.displayName,
                worktreePath: client.worktreePath,
                createdBy: "user",
                creationSource: "web",
                collaborationUser: client.user,
              });
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`start:${client.threadId}`),
                threadId: client.threadId,
                messageId: MessageId.make(`message:${client.threadId}`),
                text: `Turn for ${client.user.displayName}`,
                attachments: [],
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
                collaborationUser: client.user,
              });
              yield* orchestrator.dispatch({
                type: "sidethread.create",
                commandId: CommandId.make(`discussion:${client.threadId}`),
                threadId: client.threadId,
                sideThreadId: SideThreadId.make(`thread:${client.threadId}`),
                collaborationUser: client.user,
                createdAt: now,
              });
            }),
          { concurrency: "unbounded" },
        );
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
          assert.deepStrictEqual(
            projection.messages.find((message) => message.role === "user")?.author,
            client.user,
          );
        }
        yield* Effect.forEach(
          clients,
          (client) =>
            Effect.forEach(
              Array.from({ length: 200 }, (_, index) => index),
              (index) =>
                orchestrator.dispatch({
                  type: "sidethread.message.post",
                  commandId: CommandId.make(`post:${client.threadId}:${index}`),
                  threadId: client.threadId,
                  sideThreadId: SideThreadId.make(`thread:${client.threadId}`),
                  messageId: SideThreadMessageId.make(`post:${client.threadId}:${index}`),
                  text: `Durable message ${index}`,
                  collaborationUser: client.user,
                  createdAt: now,
                }),
            ),
          { concurrency: "unbounded" },
        );
        yield* Effect.forEach(
          clients,
          (client) =>
            Effect.gen(function* () {
              const reconnect = (afterSequence: number) =>
                orchestrator
                  .streamStoredEventsFrom({ threadId: client.threadId, afterSequence })
                  .pipe(
                    Stream.filter((stored) => stored.event.type === "sidethread.message-posted"),
                    Stream.take(100),
                    Stream.runCollect,
                  );
              const first = yield* reconnect(0);
              const second = yield* reconnect(first.at(-1)!.sequence);
              const all = [...first, ...second];
              assert.equal(all.length, 200);
              assert.equal(new Set(all.map((stored) => stored.sequence)).size, 200);
              assert.deepStrictEqual(
                all.map((stored) =>
                  stored.event.type === "sidethread.message-posted"
                    ? stored.event.payload.messageId
                    : "",
                ),
                Array.from({ length: 200 }, (_, index) => `post:${client.threadId}:${index}`),
              );
              assert.isTrue(
                all.every(
                  (stored) =>
                    stored.event.threadId === client.threadId &&
                    stored.event.type === "sidethread.message-posted" &&
                    stored.event.payload.author.subject === client.user.subject,
                ),
              );
              const snapshot = yield* projections.getThreadSnapshotWindow(client.threadId, {
                rowLimit: 40,
              });
              assert.equal(snapshot.projection.sideThreads?.[0]?.messages.length, 200);
            }),
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  { timeout: 30_000 },
);

const alice = { subject: "google:alice", displayName: "Alice" };
const bob = { subject: "google:bob", displayName: "Bob" };

it.live(
  "tells the provider who sent each turn and steer, with only that sender's memory",
  () =>
    Effect.gen(function* () {
      const sharedThreadId = ThreadId.make("thread:authors:shared");
      const liveThreadId = ThreadId.make("thread:authors:live");
      const starts = yield* Queue.unbounded<ProviderAdapterV2TurnInput>();
      const steers = yield* Queue.unbounded<string>();
      const driver = ProviderDriverKind.make("codex");
      const adapter: ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd: input.runtimePolicy.cwd ?? "/workspace",
                model: input.modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromPubSub(events),
              ensureThread: (thread) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`native:${thread.threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: thread.threadId,
                  ownerNodeId: null,
                  nativeThreadRef: null,
                  nativeConversationHeadRef: null,
                  status: "idle" as const,
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: unsupported,
              startTurn: (turn) =>
                Effect.gen(function* () {
                  yield* Queue.offer(starts, turn);
                  const at = yield* DateTime.now;
                  const providerTurnId = ProviderTurnId.make(`provider-turn:${turn.runId}`);
                  // Shared-thread turns finish so the next queued one starts.
                  const status = turn.threadId === sharedThreadId ? "completed" : "running";
                  yield* PubSub.publish(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: { driver, nativeId: providerTurnId, strength: "strong" },
                      ordinal: turn.runOrdinal,
                      status,
                      startedAt: at,
                      completedAt: status === "completed" ? at : null,
                    },
                  });
                  if (status === "completed") {
                    yield* PubSub.publish(events, {
                      type: "turn.terminal",
                      driver,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId,
                      runOrdinal: turn.runOrdinal,
                      status: "completed",
                      failure: null,
                      threadDisposition: "reusable",
                    });
                  }
                }),
              steerTurn: (steer) => Queue.offer(steers, steer.message.text).pipe(Effect.asVoid),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: unsupported,
              readThreadSnapshot: unsupported,
              rollbackThread: unsupported,
              forkThread: unsupported,
            } satisfies ProviderAdapterV2SessionRuntime;
          }),
      };
      const database = SqlitePersistence.layerMemory;
      const layer = Layer.mergeAll(
        Layer.mergeAll(
          AuthSessions.layer,
          UserMemory.layer,
          TurnAuthorService.layer.pipe(Layer.provide(ProjectionStore.layer)),
        ).pipe(Layer.provide(database)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "campfire-turn-authors" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { databaseLayer: database },
        ),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const turnAuthors = yield* TurnAuthorService.TurnAuthorService;
        const memories = yield* UserMemory.UserMemoryRepository;
        const now = yield* DateTime.now;
        yield* memories.set({ subject: alice.subject, content: "Prefers French replies." });
        yield* (yield* AuthSessions.AuthSessionRepository).create({
          sessionId: AuthSessionId.make("session:alice"),
          subject: alice.subject,
          scopes: [],
          method: "browser-session-cookie",
          client: {
            label: alice.displayName,
            ipAddress: null,
            userAgent: null,
            deviceType: "desktop",
            os: null,
            browser: null,
          },
          email: "alice@example.com",
          issuedAt: now,
          expiresAt: DateTime.add(now, { days: 1 }),
        });
        const createThread = (threadId: ThreadId) =>
          Effect.gen(function* () {
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`create:${threadId}`),
              threadId,
              projectId: ProjectId.make("project:authors"),
              title: threadId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: threadId,
              worktreePath: yield* checkpointWorkspace(threadId.replaceAll(":", "-")),
              createdBy: "user",
              creationSource: "web",
            });
          });
        const send = (
          threadId: ThreadId,
          id: string,
          text: string,
          user: CollaborationUser | null,
          dispatchMode: MessageDispatch["dispatchMode"],
        ) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`send:${id}`),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text,
            attachments: [],
            dispatchMode,
            createdBy: "user",
            creationSource: "web",
            ...(user === null ? {} : { collaborationUser: user }),
          });
        const queued = { type: "queue_after_active" } as const;

        yield* createThread(sharedThreadId);
        yield* send(sharedThreadId, "cli", "Run the tests.", null, { type: "start_immediately" });
        yield* send(sharedThreadId, "alice", "Fix the build.", alice, queued);
        yield* send(sharedThreadId, "bob", "Review it.", bob, queued);
        yield* send(sharedThreadId, "alice-command", "/goal ship it", alice, queued);
        const sharedTexts = yield* Effect.forEach([1, 2, 3, 4], () =>
          Queue.take(starts).pipe(Effect.map((turn) => turn.message.text)),
        );
        assert.deepStrictEqual(sharedTexts, [
          "Run the tests.",
          [
            "[Message from: Alice (alice@example.com)]",
            "[User memory for Alice:",
            "Prefers French replies.",
            "]",
            "",
            "Fix the build.",
          ].join("\n"),
          "[Message from: Bob]\n\nReview it.",
          "/goal ship it",
        ]);

        yield* createThread(liveThreadId);
        yield* send(liveThreadId, "alice-live", "Start the migration.", alice, {
          type: "start_immediately",
        });
        const live = yield* Queue.take(starts);
        // A message queued behind the live run does not own the current turn.
        yield* send(liveThreadId, "bob-queued", "Then update the docs.", bob, queued);
        assert.deepStrictEqual(yield* turnAuthors.readMemory(liveThreadId), {
          author: { displayName: "Alice" },
          memory: "Prefers French replies.",
        });
        // Steering needs the live provider turn projected.
        yield* orchestrator
          .streamStoredEventsFrom({
            threadId: liveThreadId,
            afterSequence: 0,
            eventType: "provider-turn.updated",
          })
          .pipe(Stream.runHead);
        yield* send(liveThreadId, "bob-steer", "Skip the seed step.", bob, {
          type: "steer_active",
          targetRunId: live.runId,
        });
        assert.strictEqual(yield* Queue.take(steers), "[Message from: Bob]\n\nSkip the seed step.");
        assert.deepStrictEqual(
          yield* turnAuthors.replaceMemory({
            threadId: liveThreadId,
            content: "Reviews pull requests in the morning.",
          }),
          { author: { displayName: "Bob" }, memory: "Reviews pull requests in the morning." },
        );
        assert.deepStrictEqual(
          yield* memories.get(alice.subject),
          Option.some("Prefers French replies."),
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  { timeout: 30_000 },
);
