import { expect, it } from "@effect/vitest";
import {
  type CollaborationUser,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as TurnAuthorService from "../../../orchestration-v2/TurnAuthorService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";

const alice: CollaborationUser = { subject: "google:alice", displayName: "Alice" };
const bob: CollaborationUser = { subject: "google:bob", displayName: "Bob" };
const providerInstanceId = ProviderInstanceId.make("codex");
const epoch = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

/** A thread whose run is live, started by `author`'s message. */
const liveThreadEvents = (
  name: string,
  author: CollaborationUser | null,
): ReadonlyArray<OrchestrationV2DomainEvent> => {
  const threadId = ThreadId.make(`thread:${name}`);
  const runId = RunId.make(`run:${name}`);
  const nodeId = NodeId.make(`node:${name}`);
  const providerThreadId = ProviderThreadId.make(`provider-thread:${name}`);
  const messageId = MessageId.make(`message:${name}`);
  const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
  const common = { threadId, occurredAt: epoch };
  return [
    {
      ...common,
      id: EventId.make(`${name}:thread`),
      type: "thread.created",
      payload: {
        id: threadId,
        projectId: ProjectId.make("project:memory"),
        title: name,
        providerInstanceId,
        modelSelection,
        createdBy: "user",
        creationSource: "web",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/workspace",
        activeProviderThreadId: providerThreadId,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: epoch,
        updatedAt: epoch,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    },
    {
      ...common,
      id: EventId.make(`${name}:run`),
      type: "run.created",
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: nodeId,
        activeAttemptId: RunAttemptId.make(`attempt:${name}`),
        status: "running",
        requestedAt: epoch,
        startedAt: epoch,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
    {
      ...common,
      id: EventId.make(`${name}:message`),
      type: "message.updated",
      payload: {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        author,
        text: "Remember something about me.",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: epoch,
        updatedAt: epoch,
      },
    },
  ];
};

const callTool = (thread: string, name: string, args: Record<string, unknown> = {}) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment:memory"),
      requestNamespace: `provider:${thread}`,
      thread: {
        threadId: ThreadId.make(`thread:${thread}`),
        providerSessionId: `provider:${thread}`,
        providerInstanceId,
      },
      client: undefined,
      capabilities: new Set<McpInvocationContext.McpCapability>(),
      issuedAt: 0,
    }),
    Effect.provideService(
      McpSchema.McpServerClient,
      McpSchema.McpServerClient.of({
        clientId: 1,
        protocolVersion: "2025-06-18",
        clientCapabilities: {},
        clientInfo: { name: "memory", version: "1" },
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "memory", version: "1" },
        },
        getClient: Effect.die("unused"),
      }),
    ),
  );

const layerProjections = ProjectionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerMemoryTools = McpHttpServer.layerMemoryToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(liveThreadsLayer),
  Layer.provide(TurnAuthorService.layer),
  Layer.provideMerge(layerProjections),
);

const seed = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* Effect.forEach(
    [
      ...liveThreadEvents("alice", alice),
      ...liveThreadEvents("bob", bob),
      ...liveThreadEvents("cli", null),
    ],
    store.apply,
  );
});

it.effect("keeps each sender's memory to themselves", () =>
  Effect.gen(function* () {
    yield* seed;
    const saved = yield* callTool("alice", "memory_update", {
      content: "Prefers French replies.",
    });
    expect(saved.isError).toBe(false);
    expect(saved.structuredContent).toEqual({
      author: { displayName: "Alice" },
      memory: "Prefers French replies.",
    });
    expect((yield* callTool("alice", "memory_read")).structuredContent).toEqual({
      author: { displayName: "Alice" },
      memory: "Prefers French replies.",
    });
    expect((yield* callTool("bob", "memory_read")).structuredContent).toEqual({
      author: { displayName: "Bob" },
      memory: null,
    });

    const cleared = yield* callTool("alice", "memory_update", { content: "" });
    expect(cleared.structuredContent).toEqual({ author: { displayName: "Alice" }, memory: null });
  }).pipe(Effect.provide(layerMemoryTools)),
);

it.effect("refuses memory for a message without a signed-in sender", () =>
  Effect.gen(function* () {
    yield* seed;
    const result = yield* callTool("cli", "memory_read");
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("The sender of the current message is not a signed-in user."),
      },
    ]);
  }).pipe(Effect.provide(layerMemoryTools)),
);

it.effect("rejects memory longer than the limit without storing it", () =>
  Effect.gen(function* () {
    yield* seed;
    const rejected = yield* callTool("alice", "memory_update", {
      content: "x".repeat(TurnAuthorService.USER_MEMORY_MAX_CHARS + 1),
    }).pipe(Effect.flip);
    expect(rejected._tag).toBe("InvalidParams");
    expect((yield* callTool("alice", "memory_read")).structuredContent).toEqual({
      author: { displayName: "Alice" },
      memory: null,
    });
  }).pipe(Effect.provide(layerMemoryTools)),
);
