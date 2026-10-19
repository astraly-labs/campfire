import type { ProviderSendTurnInput } from "@t3tools/contracts";

/**
 * Returns the turn's trimmed prompt text with the author context in front.
 * Adapters read the prompt through this instead of `input.input`, so every
 * provider learns who sent each turn. Threads are shared, so this is per turn.
 */
export function providerTurnText(input: Pick<ProviderSendTurnInput, "input" | "author">): string {
  const text = input.input?.trim() ?? "";
  const author = input.author;
  if (!author) {
    return text;
  }
  const sender = author.email ? `${author.displayName} (${author.email})` : author.displayName;
  const context = [`[Message from: ${sender}]`];
  if (author.memory) {
    context.push(`[User memory for ${author.displayName}:\n${author.memory}\n]`);
  }
  return [context.join("\n"), text].filter((part) => part.length > 0).join("\n\n");
}
