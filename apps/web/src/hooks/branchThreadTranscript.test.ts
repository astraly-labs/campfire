import type { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildBranchSeedPrompt } from "./branchThreadTranscript";
import type { ChatMessage } from "../types";

function message(
  partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "text">,
): ChatMessage {
  return {
    createdAt: "2026-05-21T00:00:00.000Z",
    streaming: false,
    ...partial,
  };
}

const idA = "m-1" as MessageId;
const idB = "m-2" as MessageId;
const idC = "m-3" as MessageId;

describe("buildBranchSeedPrompt", () => {
  it("returns null when the transcript has nothing useful", () => {
    expect(buildBranchSeedPrompt([])).toBeNull();
    expect(
      buildBranchSeedPrompt([
        message({ id: idA, role: "system", text: "you are a helpful agent" }),
        message({ id: idB, role: "user", text: "   " }),
        message({ id: idC, role: "assistant", text: "" }),
      ]),
    ).toBeNull();
  });

  it("labels roles and numbers messages in order", () => {
    const prompt = buildBranchSeedPrompt([
      message({ id: idA, role: "user", text: "Look into the latency spike." }),
      message({ id: idB, role: "assistant", text: "Found a stall in the WS reconnect path." }),
      message({ id: idC, role: "user", text: "Pin it to a turn id?" }),
    ]);

    expect(prompt).not.toBeNull();
    expect(prompt).toContain("### You (message 1)");
    expect(prompt).toContain("Look into the latency spike.");
    expect(prompt).toContain("### Agent (message 2)");
    expect(prompt).toContain("Found a stall in the WS reconnect path.");
    expect(prompt).toContain("### You (message 3)");
    expect(prompt).toContain("Pin it to a turn id?");
    expect(prompt).toContain("Continue from here.");
  });

  it("drops system messages and re-indexes the rest", () => {
    const prompt = buildBranchSeedPrompt([
      message({ id: idA, role: "system", text: "system context" }),
      message({ id: idB, role: "user", text: "real question" }),
    ]);

    // System content must not leak into the seed.
    expect(prompt).not.toBeNull();
    expect(prompt).not.toContain("system context");
    // Re-indexed: the user message is message 1, not 2.
    expect(prompt).toContain("### You (message 1)");
  });

  it("truncates an oversize message with a marker rather than dumping it raw", () => {
    const huge = "A".repeat(7_000);
    const prompt = buildBranchSeedPrompt([message({ id: idA, role: "assistant", text: huge })]);

    expect(prompt).not.toBeNull();
    expect(prompt).toContain("[truncated]");
    // The full 7k-char run should not survive verbatim.
    expect(prompt!.includes(huge)).toBe(false);
  });
});
