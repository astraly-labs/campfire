import type { ChatMessage } from "../types";

/**
 * Caps applied client-side so a pathological assistant reply cannot crowd
 * out the rest of the transcript when we paste it into the composer. The
 * limits mirror the server-side handoff prompt (`TextGenerationPrompts.ts`)
 * so the user sees similar truncation behavior across the two flows.
 */
const PER_MESSAGE_CHAR_LIMIT = 6_000;
const TRANSCRIPT_CHAR_LIMIT = 60_000;
const TRUNCATED_SUFFIX = "\n…[truncated]";

function clipToLimit(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - TRUNCATED_SUFFIX.length))}${TRUNCATED_SUFFIX}`;
}

/**
 * Build the Markdown body of a "Branch" action — the verbatim source
 * transcript pasted into the composer of the new thread.
 *
 * The branch flow is intentionally LLM-free: where the existing fork-handoff
 * asks a model to summarise the thread, this just hands the next agent the
 * exact messages so nothing gets paraphrased away. Roles are tagged
 * "**You**" / "**Agent**" so the model reading the seed prompt understands
 * the previous turn structure.
 *
 * `system` messages are dropped because they are protocol scaffolding and
 * would only confuse the agent reading the seed. Empty messages are also
 * skipped — they happen when an assistant response is interrupted before
 * any text streams in.
 *
 * Returns `null` when the resulting transcript is empty; callers use that to
 * surface a "nothing to branch" toast instead of opening an empty draft.
 */
export function buildBranchSeedPrompt(messages: ReadonlyArray<ChatMessage>): string | null {
  const formatted: string[] = [];
  let index = 0;
  for (const message of messages) {
    if (message.role === "system") continue;
    const text = message.text.trim();
    if (text.length === 0) continue;
    const label = message.role === "user" ? "You" : "Agent";
    const body = clipToLimit(text, PER_MESSAGE_CHAR_LIMIT);
    index += 1;
    formatted.push(`### ${label} (message ${index})\n${body}`);
  }

  if (formatted.length === 0) return null;

  const body = clipToLimit(formatted.join("\n\n"), TRANSCRIPT_CHAR_LIMIT);
  return [
    "I'm branching off from a previous conversation in this project. Below is the",
    "verbatim transcript so far — roles are labelled. Pick up from the end of the",
    "transcript and continue the work; ask me before making changes if anything is",
    "ambiguous.",
    "",
    "---",
    "",
    body,
    "",
    "---",
    "",
    "Continue from here.",
  ].join("\n");
}
