import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type CollaborationUser,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as UserMemory from "../../../persistence/UserMemory.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const invocation = {
  environmentId: EnvironmentId.make("environment-memory-test"),
  threadId: ThreadId.make("thread-memory-test"),
  providerSessionId: "provider-session-memory-test",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "memory-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

// The latest user message decides whose memory the tools touch.
let latestAuthor: CollaborationUser | null = null;
const TestLayer = McpHttpServer.MemoryToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadDetailById: () =>
        Effect.succeed(
          Option.some({
            messages: [{ role: "user", author: latestAuthor }],
          } as never),
        ),
    }),
  ),
  Layer.provide(UserMemory.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

it.effect("reads and writes only the current message author's memory", () =>
  Effect.gen(function* () {
    latestAuthor = { subject: "google:alice", displayName: "Alice" };
    const saved = yield* callTool("memory_update", { content: "Prefers French replies." });
    expect(saved.structuredContent).toEqual({
      author: { displayName: "Alice" },
      memory: "Prefers French replies.",
    });

    latestAuthor = { subject: "google:bob", displayName: "Bob" };
    const bob = yield* callTool("memory_read");
    expect(bob.structuredContent).toEqual({ author: { displayName: "Bob" }, memory: null });

    latestAuthor = { subject: "google:alice", displayName: "Alice" };
    const cleared = yield* callTool("memory_update", { content: "" });
    expect(cleared.structuredContent).toEqual({ author: { displayName: "Alice" }, memory: null });

    latestAuthor = null;
    const anonymous = yield* callTool("memory_read");
    expect(anonymous.isError).toBe(true);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects memory larger than the size limit", () =>
  Effect.gen(function* () {
    latestAuthor = { subject: "google:alice", displayName: "Alice" };
    const result = yield* callTool("memory_update", { content: "x".repeat(4_001) });
    expect(result.isError).toBe(true);
  }).pipe(Effect.provide(TestLayer)),
);
