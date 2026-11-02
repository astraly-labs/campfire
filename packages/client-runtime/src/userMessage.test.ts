import { ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveUserMessagePresentation } from "./userMessage.ts";

describe("resolveUserMessagePresentation", () => {
  const legacyText = "[Triggered by schedule task: Daily audit]\n\nCheck for crashes.\n";

  it("removes attribution from legacy scheduled prompts", () => {
    expect(
      resolveUserMessagePresentation({ role: "user", createdBy: "agent", text: legacyText }),
    ).toEqual({
      text: "Check for crashes.\n",
      attribution: "automation",
      scheduledTaskId: undefined,
    });
  });

  it("uses task metadata without changing the prompt", () => {
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        scheduledTaskId: ScheduledTaskId.make("task-1"),
        text: legacyText,
      }),
    ).toEqual({ text: legacyText, attribution: "automation", scheduledTaskId: "task-1" });
  });

  it("preserves user-written and assistant-quoted schedule headers", () => {
    for (const message of [
      { role: "user", createdBy: "user" as const },
      { role: "user" },
      { role: "assistant", createdBy: "agent" as const },
    ]) {
      expect(resolveUserMessagePresentation({ ...message, text: legacyText })).toEqual({
        text: legacyText,
        attribution: null,
        scheduledTaskId: undefined,
      });
    }
  });

  it("leaves other agent prompts and embedded headers intact", () => {
    for (const text of [
      "Review this area",
      `Quoted prompt:\n${legacyText}`,
      "[Triggered by schedule task: Daily audit]",
    ]) {
      expect(resolveUserMessagePresentation({ role: "user", createdBy: "agent", text })).toEqual({
        text,
        attribution: "agent",
        scheduledTaskId: undefined,
      });
    }
  });

  it("attributes older server-sent restart continuations to T3 Code, not another agent", () => {
    const text = "Note: the T3 server restarted.";
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        creationSource: "server",
        text,
      }),
    ).toMatchObject({ attribution: "t3code" });
    for (const creationSource of ["mcp", "provider"] as const) {
      expect(
        resolveUserMessagePresentation({ role: "user", createdBy: "agent", creationSource, text }),
      ).toMatchObject({ attribution: "agent" });
    }
  });

  it("keeps the T3 Code label on a message T3 Code sent for another thread and opens that thread", () => {
    const senderThreadId = ThreadId.make("thread-review");
    const text = "**Review 1 of 3** from Cursor on #42";
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        creationSource: "server",
        senderThreadId,
        text,
      }),
    ).toEqual({ text, attribution: "t3code", scheduledTaskId: undefined, senderThreadId });
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        creationSource: "mcp",
        senderThreadId,
        text,
      }),
    ).toMatchObject({ attribution: "agent", senderThreadId });
    expect(
      resolveUserMessagePresentation({ role: "user", createdBy: "user", senderThreadId, text })
        .senderThreadId,
    ).toBeUndefined();
  });

  it("recovers the triggering automation from older scheduler message ids", () => {
    for (const trigger of ["scheduled", "manual"]) {
      expect(
        resolveUserMessagePresentation({
          id: `scheduled-task-message:task:daily-audit:1788661140000:${trigger}`,
          role: "user",
          createdBy: "user",
          text: legacyText,
        }),
      ).toEqual({
        text: "Check for crashes.\n",
        attribution: "automation",
        scheduledTaskId: "task:daily-audit",
      });
    }
  });
});
