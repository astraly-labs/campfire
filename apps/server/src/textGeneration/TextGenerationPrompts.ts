/**
 * Shared prompt builders for text generation providers.
 *
 * Extracts the prompt construction logic that is identical across
 * Codex, Claude, and any future CLI-based text generation backends.
 *
 * @module textGenerationPrompts
 */
import * as Schema from "effect/Schema";
import type { ChatAttachment } from "@t3tools/contracts";

import { limitSection } from "./TextGenerationUtils.ts";
import type { TextGenerationPolicy } from "./TextGenerationPolicy.ts";

function policyInstruction(instruction: string | undefined): ReadonlyArray<string> {
  const trimmed = instruction?.trim();
  return trimmed ? ["", "Additional instructions:", limitSection(trimmed, 4_000)] : [];
}

// ---------------------------------------------------------------------------
// Commit message
// ---------------------------------------------------------------------------

export interface CommitMessagePromptInput {
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch: boolean;
  policy?: TextGenerationPolicy | undefined;
}

export function buildCommitMessagePrompt(input: CommitMessagePromptInput) {
  const wantsBranch = input.includeBranch;

  const prompt = [
    "You write concise git commit messages.",
    wantsBranch
      ? "Return a JSON object with keys: subject, body, branch."
      : "Return a JSON object with keys: subject, body.",
    "Rules:",
    "- subject must be imperative, <= 72 chars, and no trailing period",
    "- body can be empty string or short bullet points",
    ...(wantsBranch
      ? ["- branch must be a short semantic git branch fragment for this change"]
      : []),
    "- capture the primary user-visible or developer-visible change",
    ...policyInstruction(input.policy?.commitInstructions),
    "",
    `Branch: ${input.branch ?? "(detached)"}`,
    "",
    "Staged files:",
    limitSection(input.stagedSummary, 6_000),
    "",
    "Staged patch:",
    limitSection(input.stagedPatch, 40_000),
  ].join("\n");

  if (wantsBranch) {
    return {
      prompt,
      outputSchema: Schema.Struct({
        subject: Schema.String,
        body: Schema.String,
        branch: Schema.String,
      }),
    };
  }

  return {
    prompt,
    outputSchema: Schema.Struct({
      subject: Schema.String,
      body: Schema.String,
    }),
  };
}

// ---------------------------------------------------------------------------
// PR content
// ---------------------------------------------------------------------------

export interface PrContentPromptInput {
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  policy?: TextGenerationPolicy | undefined;
}

export function buildPrContentPrompt(input: PrContentPromptInput) {
  const prompt = [
    "You write GitHub pull request content.",
    "Return a JSON object with keys: title, body.",
    "Rules:",
    "- title should be concise and specific",
    "- body must be markdown and include headings '## Summary' and '## Testing'",
    "- under Summary, provide short bullet points",
    "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate",
    ...policyInstruction(input.policy?.changeRequestInstructions),
    "",
    `Base branch: ${input.baseBranch}`,
    `Head branch: ${input.headBranch}`,
    "",
    "Commits:",
    limitSection(input.commitSummary, 12_000),
    "",
    "Diff stat:",
    limitSection(input.diffSummary, 12_000),
    "",
    "Diff patch:",
    limitSection(input.diffPatch, 40_000),
  ].join("\n");

  const outputSchema = Schema.Struct({
    title: Schema.String,
    body: Schema.String,
  });

  return { prompt, outputSchema };
}

// ---------------------------------------------------------------------------
// Branch name
// ---------------------------------------------------------------------------

export interface BranchNamePromptInput {
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  policy?: TextGenerationPolicy | undefined;
}

interface PromptFromMessageInput {
  instruction: string;
  responseShape: string;
  rules: ReadonlyArray<string>;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  additionalInstructions?: string | undefined;
}

function buildPromptFromMessage(input: PromptFromMessageInput): string {
  const attachmentLines = (input.attachments ?? []).map(
    (attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
  );

  const promptSections = [
    input.instruction,
    input.responseShape,
    "Rules:",
    ...input.rules.map((rule) => `- ${rule}`),
    "",
    "User message:",
    limitSection(input.message, 8_000),
    ...policyInstruction(input.additionalInstructions),
  ];
  if (attachmentLines.length > 0) {
    promptSections.push(
      "",
      "Attachment metadata:",
      limitSection(attachmentLines.join("\n"), 4_000),
    );
  }

  return promptSections.join("\n");
}

export function buildBranchNamePrompt(input: BranchNamePromptInput) {
  const prompt = buildPromptFromMessage({
    instruction: "You generate concise git branch names.",
    responseShape: "Return a JSON object with key: branch.",
    rules: [
      "Branch should describe the requested work from the user message.",
      "Keep it short and specific (2-6 words).",
      "Use plain words only, no issue prefixes and no punctuation-heavy text.",
      "If images are attached, use them as primary context for visual/UI issues.",
    ],
    message: input.message,
    attachments: input.attachments,
    additionalInstructions: input.policy?.branchInstructions,
  });
  const outputSchema = Schema.Struct({
    branch: Schema.String,
  });

  return { prompt, outputSchema };
}

// ---------------------------------------------------------------------------
// Thread title
// ---------------------------------------------------------------------------

export interface ThreadTitlePromptInput {
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  policy?: TextGenerationPolicy | undefined;
}

export function buildThreadTitlePrompt(input: ThreadTitlePromptInput) {
  const prompt = buildPromptFromMessage({
    instruction: "You write concise thread titles for coding conversations.",
    responseShape: "Return a JSON object with key: title.",
    rules: [
      "Title should summarize the user's request, not restate it verbatim.",
      "Keep it short and specific (3-8 words).",
      "Avoid quotes, filler, prefixes, and trailing punctuation.",
      "If images are attached, use them as primary context for visual/UI issues.",
    ],
    message: input.message,
    attachments: input.attachments,
    additionalInstructions: input.policy?.threadTitleInstructions,
  });
  const outputSchema = Schema.Struct({
    title: Schema.String,
  });

  return { prompt, outputSchema };
}

// ---------------------------------------------------------------------------
// Thread handoff
// ---------------------------------------------------------------------------

export interface ThreadHandoffTranscriptMessageInput {
  role: "user" | "agent";
  text: string;
}

export interface ThreadHandoffPromptInput {
  sourceCwd: string;
  sourceBranch?: string | null | undefined;
  sourceProjectName?: string | null | undefined;
  targetCwd: string;
  targetProjectName: string;
  transcript: ReadonlyArray<ThreadHandoffTranscriptMessageInput>;
  note?: string | undefined;
}

// Cap individual transcript messages so a single runaway agent reply cannot
// crowd out everything else when we serialise. The combined transcript is
// then further capped by `limitSection` below.
const THREAD_HANDOFF_PER_MESSAGE_CHAR_LIMIT = 6_000;
const THREAD_HANDOFF_TRANSCRIPT_CHAR_LIMIT = 60_000;

function formatTranscriptMessage(
  message: ThreadHandoffTranscriptMessageInput,
  index: number,
): string {
  const label = message.role === "user" ? "User" : "Agent";
  const body = limitSection(message.text.trim(), THREAD_HANDOFF_PER_MESSAGE_CHAR_LIMIT);
  return `[${index + 1}] ${label}:\n${body}`;
}

export function buildThreadHandoffPrompt(input: ThreadHandoffPromptInput) {
  const transcriptBody = input.transcript.map(formatTranscriptMessage).join("\n\n");
  const sourceProjectLabel = input.sourceProjectName?.trim() || input.sourceCwd;
  const branchLine = input.sourceBranch
    ? `Source branch: ${input.sourceBranch}`
    : "Source branch: (unknown)";

  const userNoteSection =
    input.note && input.note.trim().length > 0
      ? ["", "User note for the next agent:", limitSection(input.note.trim(), 2_000)]
      : [];

  const prompt = [
    "You are summarising a coding conversation as a handoff for a different agent",
    "who will work in a separate repository and has no visibility into the source",
    "thread, the source repository, or its files.",
    "",
    "Return a JSON object with key: prompt.",
    "Rules for the `prompt` field:",
    "- It must read as a first-person user message addressed to the next agent.",
    "- Use Markdown with these top-level sections (omit a section only if",
    "  genuinely empty): `## Context`, `## What was found`, `## Files & references`,",
    "  `## Suggested next step`.",
    "- Under `## Context`, name the source project and what the user was doing in",
    "  one or two sentences. Do NOT assume the next agent can read the source repo.",
    "- Under `## What was found`, list concrete findings, hypotheses, or decisions",
    "  with enough detail to be actionable in isolation.",
    "- Under `## Files & references`, list files, symbols, URLs, or external IDs",
    "  that the next agent should look at. Qualify cross-repo paths with the source",
    "  project name so the next agent does not look for them locally.",
    "- Under `## Suggested next step`, propose the concrete task to do in the",
    "  target project. Be specific and grounded in the findings.",
    "- Never invent files, symbols, or facts that are not in the transcript.",
    "- Keep the whole prompt under ~400 words; favour density over prose.",
    "",
    `Source project: ${sourceProjectLabel}`,
    `Source cwd: ${input.sourceCwd}`,
    branchLine,
    `Target project: ${input.targetProjectName}`,
    `Target cwd: ${input.targetCwd}`,
    ...userNoteSection,
    "",
    "Source transcript (oldest first):",
    limitSection(transcriptBody, THREAD_HANDOFF_TRANSCRIPT_CHAR_LIMIT),
  ].join("\n");

  const outputSchema = Schema.Struct({
    prompt: Schema.String,
  });

  return { prompt, outputSchema };
}
