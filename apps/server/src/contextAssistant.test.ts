import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  buildBoundedThreadTranscript,
  buildContextAssistantInitialPrompt,
} from "./contextAssistant.ts";

function message(index: number, text: string): OrchestrationMessage {
  return {
    id: MessageId.make(`message-${index}`),
    role: index % 2 === 0 ? "user" : "assistant",
    text,
    turnId: null,
    streaming: false,
    createdAt: `2026-07-24T10:00:0${index}.000Z`,
    updatedAt: `2026-07-24T10:00:0${index}.000Z`,
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
      latestTurn: null,
      createdAt: "2026-07-24T10:00:00.000Z",
      updatedAt: "2026-07-24T10:00:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [message(1, "We chose the queue design.")],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    } satisfies OrchestrationThread;
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
      question: "What did we decide?",
    });

    expect(prompt.indexOf("We chose the queue design.")).toBeLessThan(
      prompt.indexOf("What did we decide?"),
    );
    expect(prompt).toContain("read-only briefing");
  });
});
