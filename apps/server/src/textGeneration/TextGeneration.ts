import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ChatAttachment, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  isProviderAvailable,
  ProviderDriverKind,
  TextGenerationError,
} from "@t3tools/contracts";

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
  /**
   * `true` when source and target projects are the same. Swaps the prompt
   * framing so the next agent isn't told to treat the codebase as foreign.
   */
  isSameProject?: boolean | undefined;
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

/**
 * Input for the "Take a look" recap that surfaces above the composer. The
 * caller forces a cheap model via `modelSelection` — Haiku for Claude, Spark
 * for Codex — because this runs frequently (on every turn end while a summary
 * exists) and accuracy matters less than latency/cost here.
 */
export interface ConversationSummaryGenerationInput {
  /** Working directory of the source thread. */
  cwd: string;
  /** Optional thread title used to anchor the framing of the summary. */
  threadTitle?: string | null | undefined;
  /** Ordered transcript messages (oldest first). */
  transcript: ReadonlyArray<ThreadHandoffTranscriptMessage>;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ConversationSummaryGenerationResult {
  /** 2-3 sentence plain-prose recap of the conversation. */
  summary: string;
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
  generateConversationSummary(
    input: ConversationSummaryGenerationInput,
  ): Promise<ConversationSummaryGenerationResult>;
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

  /**
   * Generate a 2-3 sentence recap of a conversation for a teammate joining
   * mid-thread (the "Take a look" Summary toggle).
   */
  readonly generateConversationSummary: (
    input: ConversationSummaryGenerationInput,
  ) => Effect.Effect<ConversationSummaryGenerationResult, TextGenerationError>;
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
  | "generateThreadHandoff"
  | "generateConversationSummary";

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

/**
 * One provider attempt: a concrete `textGeneration` implementation plus the
 * `ModelSelection` to run it with. Fallback candidates carry a rewritten
 * selection (the fallback provider's default text-gen model) because the
 * originally-requested model slug belongs to the originally-requested
 * provider and is meaningless on a different driver.
 */
interface ProviderCandidate {
  readonly textGeneration: TextGenerationShape;
  readonly modelSelection: ModelSelection;
  readonly instanceId: ProviderInstanceId;
  /** True when this candidate is a fallback (not the configured instance). */
  readonly isFallback: boolean;
}

const rewriteSelectionForFallback = (instance: ProviderInstance): ModelSelection => ({
  instanceId: instance.instanceId,
  model:
    DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[instance.driverKind] ??
    DEFAULT_GIT_TEXT_GENERATION_MODEL,
  // The requested provider's option selections (e.g. Claude reasoning effort)
  // do not transfer to a different driver, so start the fallback clean.
  options: [],
});

/**
 * Build the ordered list of provider attempts for a text-generation call.
 *
 * Ordering:
 *   1. The configured instance with its original selection — UNLESS we already
 *      know it is unauthenticated or unavailable (then we skip the doomed call
 *      and its ~seconds-long 401 latency).
 *   2. Every other authenticated + available instance, Codex first, each with
 *      its own default text-gen model.
 *
 * If that leaves nothing (configured instance has `unknown` auth and there is
 * no authenticated alternative), the configured instance is re-added so its
 * own — informative — error surfaces instead of a synthetic one. When the
 * configured id is unknown and no instance can serve, callers get the same
 * "no provider instance registered" error as before.
 */
const resolveProviderCandidates = (
  registry: ProviderInstanceRegistryShape,
  operation: TextGenerationOp,
  requested: ModelSelection,
): Effect.Effect<ReadonlyArray<ProviderCandidate>, TextGenerationError> =>
  Effect.gen(function* () {
    const instances = yield* registry.listInstances;
    const withSnapshots = yield* Effect.forEach(instances, (instance) =>
      instance.snapshot.getSnapshot.pipe(Effect.map((snapshot) => ({ instance, snapshot }))),
    );

    const requestedId = requested.instanceId;
    const requestedEntry = withSnapshots.find(
      ({ instance }) => instance.instanceId === requestedId,
    );

    const candidates: ProviderCandidate[] = [];
    const seen = new Set<ProviderInstanceId>();

    if (
      requestedEntry &&
      requestedEntry.snapshot.auth.status !== "unauthenticated" &&
      isProviderAvailable(requestedEntry.snapshot)
    ) {
      candidates.push({
        textGeneration: requestedEntry.instance.textGeneration,
        modelSelection: requested,
        instanceId: requestedId,
        isFallback: false,
      });
      seen.add(requestedId);
    }

    const fallbacks = withSnapshots
      .filter(
        ({ instance, snapshot }) =>
          !seen.has(instance.instanceId) &&
          snapshot.auth.status === "authenticated" &&
          isProviderAvailable(snapshot),
      )
      .toSorted((a, b) => {
        const aCodex = a.instance.driverKind === CODEX_DRIVER_KIND;
        const bCodex = b.instance.driverKind === CODEX_DRIVER_KIND;
        return aCodex === bCodex ? 0 : aCodex ? -1 : 1;
      });

    for (const { instance } of fallbacks) {
      candidates.push({
        textGeneration: instance.textGeneration,
        modelSelection: rewriteSelectionForFallback(instance),
        instanceId: instance.instanceId,
        isFallback: true,
      });
      seen.add(instance.instanceId);
    }

    if (candidates.length === 0) {
      if (requestedEntry) {
        // Configured instance has `unknown` auth and there's no authenticated
        // alternative — try it anyway so its own error (or success) wins.
        candidates.push({
          textGeneration: requestedEntry.instance.textGeneration,
          modelSelection: requested,
          instanceId: requestedId,
          isFallback: false,
        });
      } else {
        return yield* new TextGenerationError({
          operation,
          detail: `No provider instance registered for id '${requestedId}'.`,
        });
      }
    }

    return candidates;
  });

/**
 * Run a text-generation operation against the configured provider, falling
 * back to another authenticated provider (Codex first) when the configured
 * one is unauthenticated/unavailable up front, or fails at call time (e.g. a
 * runtime 401 from an expired token the snapshot still believed valid).
 */
const runWithProviderFallback = <Input extends { readonly modelSelection: ModelSelection }, Result>(
  registry: ProviderInstanceRegistryShape,
  operation: TextGenerationOp,
  input: Input,
  run: (
    textGeneration: TextGenerationShape,
    input: Input,
  ) => Effect.Effect<Result, TextGenerationError>,
): Effect.Effect<Result, TextGenerationError> =>
  Effect.gen(function* () {
    const candidates = yield* resolveProviderCandidates(registry, operation, input.modelSelection);

    let firstError: TextGenerationError | null = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      const attempt = yield* run(candidate.textGeneration, {
        ...input,
        modelSelection: candidate.modelSelection,
      } as Input).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error: TextGenerationError) => Effect.succeed({ ok: false as const, error })),
      );

      if (attempt.ok) {
        if (candidate.isFallback) {
          yield* Effect.logInfo(
            `[🔁 TextGen Fallback] '${operation}': configured provider '${input.modelSelection.instanceId}' unavailable/failed; served by '${candidate.instanceId}' (${candidate.modelSelection.model}).`,
          );
        }
        return attempt.value;
      }

      firstError ??= attempt.error;
    }

    return yield* (
      firstError ??
        new TextGenerationError({
          operation,
          detail: `No usable provider instance for id '${input.modelSelection.instanceId}'.`,
        })
    );
  });

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistryShape,
): TextGenerationShape => ({
  generateCommitMessage: (input) =>
    runWithProviderFallback(registry, "generateCommitMessage", input, (textGeneration, attempt) =>
      textGeneration.generateCommitMessage(attempt),
    ),
  generatePrContent: (input) =>
    runWithProviderFallback(registry, "generatePrContent", input, (textGeneration, attempt) =>
      textGeneration.generatePrContent(attempt),
    ),
  generateBranchName: (input) =>
    runWithProviderFallback(registry, "generateBranchName", input, (textGeneration, attempt) =>
      textGeneration.generateBranchName(attempt),
    ),
  generateThreadTitle: (input) =>
    runWithProviderFallback(registry, "generateThreadTitle", input, (textGeneration, attempt) =>
      textGeneration.generateThreadTitle(attempt),
    ),
  generateThreadHandoff: (input) =>
    runWithProviderFallback(registry, "generateThreadHandoff", input, (textGeneration, attempt) =>
      textGeneration.generateThreadHandoff(attempt),
    ),
  generateConversationSummary: (input) =>
    runWithProviderFallback(
      registry,
      "generateConversationSummary",
      input,
      (textGeneration, attempt) => textGeneration.generateConversationSummary(attempt),
    ),
});

export const layer = Layer.effect(
  TextGeneration,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    return makeTextGenerationFromRegistry(registry);
  }),
);
