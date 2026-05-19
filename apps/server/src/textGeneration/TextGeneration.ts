import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ChatAttachment, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";

import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";

export type TextGenerationProvider = "codex" | "claudeAgent" | "cursor" | "opencode";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

/**
 * A single message from a source thread transcript, used as input when an
 * agent summarises a conversation into a handoff prompt for a different
 * project.
 */
export interface ThreadHandoffTranscriptMessage {
  /** "user" for user-authored turns, "agent" for assistant responses. */
  role: "user" | "agent";
  /** Plain-text rendering of the message body. */
  text: string;
}

export interface ThreadHandoffGenerationInput {
  /** Working directory of the SOURCE thread (where the conversation happened). */
  sourceCwd: string;
  /** Optional branch context for the source thread. */
  sourceBranch?: string | null | undefined;
  /** Human-readable name of the source project (for transcript framing). */
  sourceProjectName?: string | null | undefined;
  /** Working directory of the TARGET project the handoff is destined for. */
  targetCwd: string;
  /** Human-readable name of the target project. */
  targetProjectName: string;
  /** Ordered transcript messages from the source thread. */
  transcript: ReadonlyArray<ThreadHandoffTranscriptMessage>;
  /** Optional free-form user note appended to the agent instructions. */
  note?: string | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadHandoffGenerationResult {
  /**
   * Markdown body intended to be pre-filled as the first user message of
   * the new thread in the target project. Structured for another agent
   * (no shared context with the source thread).
   */
  prompt: string;
}

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
  generateThreadHandoff(
    input: ThreadHandoffGenerationInput,
  ): Promise<ThreadHandoffGenerationResult>;
}

/**
 * TextGenerationShape - Service API for commit/PR text generation.
 */
export interface TextGenerationShape {
  /**
   * Generate a commit message from staged change context.
   */
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  /**
   * Generate pull request title/body from branch and diff context.
   */
  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  /**
   * Generate a concise branch name from a user message.
   */
  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  /**
   * Generate a concise thread title from a user's first message.
   */
  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  /**
   * Generate a handoff prompt summarising a source thread for a fresh
   * conversation in a different project. The output is intended to be
   * pre-filled in the target project's composer as the first user message.
   */
  readonly generateThreadHandoff: (
    input: ThreadHandoffGenerationInput,
  ) => Effect.Effect<ThreadHandoffGenerationResult, TextGenerationError>;
}

/**
 * TextGeneration - Service tag for commit and PR text generation.
 */
export class TextGeneration extends Context.Service<TextGeneration, TextGenerationShape>()(
  "t3/text-generation/TextGeneration",
) {}

/**
 * Operation identifier carried on `TextGenerationError.operation` and used
 * by provider implementations to label log lines and error payloads. Kept
 * in one place so every provider stays in sync as we add new operations.
 */
export type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateThreadHandoff";

const resolveInstance = (
  registry: ProviderInstanceRegistryShape,
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistryShape,
): TextGenerationShape => ({
  generateCommitMessage: (input) =>
    resolveInstance(registry, "generateCommitMessage", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)),
    ),
  generatePrContent: (input) =>
    resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input)),
    ),
  generateBranchName: (input) =>
    resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
    ),
  generateThreadTitle: (input) =>
    resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.generateThreadTitle(input)),
    ),
  generateThreadHandoff: (input) =>
    resolveInstance(registry, "generateThreadHandoff", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.generateThreadHandoff(input)),
    ),
});

export const layer = Layer.effect(
  TextGeneration,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    return makeTextGenerationFromRegistry(registry);
  }),
);
