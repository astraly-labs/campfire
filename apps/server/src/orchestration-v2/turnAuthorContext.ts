import type { CollaborationUser } from "@t3tools/contracts";

/**
 * The text a provider receives for one turn or steer: the user's text with a
 * block naming its signed-in sender and that sender's memory in front. Threads
 * are shared, so this is built per message. Messages without a signed-in
 * author (CLI, pairing, agents) and slash commands pass through unchanged,
 * since providers only expand a command at the very start of the prompt.
 */
export function withTurnAuthorContext(input: {
  readonly author: CollaborationUser | null | undefined;
  readonly email?: string | undefined;
  readonly memory?: string | undefined;
  readonly text: string;
}): string {
  const { author, email, memory, text } = input;
  if (author == null || text.trimStart().startsWith("/")) return text;
  const sender = email === undefined ? author.displayName : `${author.displayName} (${email})`;
  const block = [
    `[Message from: ${sender}]`,
    ...(memory === undefined ? [] : [`[User memory for ${author.displayName}:\n${memory}\n]`]),
  ].join("\n");
  return text.trim().length === 0 ? block : `${block}\n\n${text}`;
}
