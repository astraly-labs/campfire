import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  buildBoundedThreadTranscript,
  buildContextAssistantInitialPrompt,
} from "./contextAssistant.ts";

function message(index: number, text: string): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make(`message-${index}`),
    role: index % 2 === 0 ? "user" : "assistant",
    text,
    threadId: ThreadId.make("thread-1"),
    runId: null,
    nodeId: null,
    createdBy: "user",
    creationSource: "web",
    attachments: [],
    streaming: false,
    createdAt: DateTime.makeUnsafe(`2026-07-24T10:00:0${index}.000Z`),
    updatedAt: DateTime.makeUnsafe(`2026-07-24T10:00:0${index}.000Z`),
  };
}

describe("context assistant prompt", () => {
  it("keeps the newest messages when the transcript is bounded", () => {
    const transcript = buildBoundedThreadTranscript(
      [message(1, "old detail"), message(2, "middle detail"), message(3, "latest decision")],
      105,
    );

    expect(transcript).toContain("latest decision");
    expect(transcript).not.toContain("old detail");
    expect(transcript.length).toBeLessThanOrEqual(105);
  });

  it("places the frozen source transcript before the user's question", () => {
    const thread = {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Long refactor",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "rebuild",
      worktreePath: "/tmp/worktree",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: ProviderInstanceId.make("codex"),
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: ThreadId.make("thread-1"),
      },
      forkedFrom: null,
      lastVisitedAt: null,
      createdAt: DateTime.makeUnsafe("2026-07-24T10:00:00.000Z"),
      updatedAt: DateTime.makeUnsafe("2026-07-24T10:00:00.000Z"),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    } satisfies OrchestrationV2AppThread;
    const project = {
      id: ProjectId.make("project-1"),
      title: "Campfire",
      workspaceRoot: "/tmp/campfire",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-07-24T10:00:00.000Z",
      updatedAt: "2026-07-24T10:00:00.000Z",
    } satisfies OrchestrationProjectShell;

    const prompt = buildContextAssistantInitialPrompt({
      thread,
      project,
      messages: [message(1, "We chose the queue design.")],
      question: "What did we decide?",
    });

    expect(prompt.indexOf("We chose the queue design.")).toBeLessThan(
      prompt.indexOf("What did we decide?"),
    );
    expect(prompt).toContain("read-only briefing");
  });
});
