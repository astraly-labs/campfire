import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect } from "vite-plus/test";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SideThreadId,
  SideThreadMessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import * as ServerConfigLayer from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { canonicalizeClientCommandTimestamps, normalizeDispatchCommand } from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

const normalizerLayer = it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    ServerConfigLayer.layerTest(process.cwd(), { prefix: "t3-normalizer-side-image-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    WorkspacePaths.layer.pipe(Layer.provide(NodeServices.layer)),
  ),
);

normalizerLayer("normalizeDispatchCommand", (it) => {
  it.effect("persists SideThread images and leaves GIF metadata inline", () =>
    Effect.gen(function* () {
      const command: ClientOrchestrationCommand = {
        type: "sidethread.message.post",
        commandId: CommandId.make("command-side-image"),
        threadId: ThreadId.make("thread-side-image"),
        sideThreadId: SideThreadId.make("thread:thread-side-image"),
        messageId: SideThreadMessageId.make("message-side-image"),
        text: "See attachments",
        attachments: [
          {
            type: "image",
            name: "proof.png",
            mimeType: "image/png",
            sizeBytes: 5,
            dataUrl: "data:image/png;base64,aGVsbG8=",
          },
          {
            type: "gif",
            url: "https://example.test/proof.gif",
            previewUrl: "https://example.test/proof.gif",
            width: 320,
            height: 180,
          },
        ],
        createdAt: clientCreatedAt,
      };

      const normalized = yield* normalizeDispatchCommand(command);
      assert.equal(normalized.type, "sidethread.message.post");
      if (normalized.type !== "sidethread.message.post") return;
      assert.equal(normalized.attachments?.[0]?.type, "image");
      assert.equal(normalized.attachments?.[1]?.type, "gif");

      const image = normalized.attachments?.[0];
      if (!image || image.type !== "image") return assert.fail("Expected persisted image");
      assert.equal(image.name, "proof.png");
      assert.equal(image.sizeBytes, 5);

      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: image,
      });
      assert.isNotNull(attachmentPath);
      assert.isTrue(yield* fileSystem.exists(attachmentPath!));
    }),
  );
});
