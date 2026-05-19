/**
 * Conversation summary helper for the "Take a look" recap toggle.
 *
 * A teammate pinged via `TakeALookButton` shouldn't have to scroll the whole
 * thread to get up to speed. This module owns:
 *   - A process-wide LRU cache keyed by `(threadId, latestTurnId)` so multiple
 *     viewers of the same thread share a single model call until a fresh turn
 *     invalidates it.
 *   - The cheap-model selection per provider driver, sourced from
 *     `CONVERSATION_SUMMARY_MODEL_BY_PROVIDER` (Haiku for Claude, Codex Spark
 *     for Codex, etc.). Summary accuracy matters less than latency/cost here.
 *
 * @module orchestration/conversationSummary
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import {
  CONVERSATION_SUMMARY_MODEL_BY_PROVIDER,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  type ModelSelection,
  OrchestrationGenerateConversationSummaryError,
  type OrchestrationGenerateConversationSummaryResult,
  type OrchestrationThread,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";

import type { ProviderInstanceRegistryShape } from "../provider/Services/ProviderInstanceRegistry.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";

const CACHE_MAX_ENTRIES = 256;

type CacheEntry = OrchestrationGenerateConversationSummaryResult;

/**
 * Module-level LRU cache. Map preserves insertion order, so re-inserting on
 * read and deleting from the head when over capacity gives us LRU eviction
 * without a real linked-list implementation.
 */
const cache = new Map<string, CacheEntry>();

function cacheKey(threadId: ThreadId, turnId: string | null): string {
  return `${threadId}::${turnId ?? "null"}`;
}

function readCache(threadId: ThreadId, turnId: string | null): CacheEntry | undefined {
  const key = cacheKey(threadId, turnId);
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  // Touch: re-insert to move to most-recently-used end.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function writeCache(threadId: ThreadId, turnId: string | null, value: CacheEntry): void {
  const key = cacheKey(threadId, turnId);
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Drop every cache entry tied to a thread, regardless of turnId. Used by the
 * take-a-look pre-warm so the next viewer gets a fresh result even if a stale
 * entry slipped through (e.g. summary generated mid-turn before the diff
 * event landed).
 */
export function invalidateThread(threadId: ThreadId): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${threadId}::`)) {
      cache.delete(key);
    }
  }
}

interface ResolveModelInput {
  readonly registry: ProviderInstanceRegistryShape;
  readonly instanceId: ProviderInstanceId;
}

interface ResolvedModel {
  readonly modelSelection: ModelSelection;
  readonly modelId: string;
}

/**
 * Pick the cheap recap model for a given provider instance. Falls back to
 * `DEFAULT_GIT_TEXT_GENERATION_MODEL` if the driver is unknown (rare; a
 * driver pulled out of the build at runtime) so the call still has *some*
 * chance of succeeding instead of failing loudly. The user-visible failure
 * mode in that case is a misrouted model, not a crash.
 */
const resolveSummaryModel = (input: ResolveModelInput) =>
  Effect.gen(function* () {
    const instance = yield* input.registry.getInstance(input.instanceId);
    if (instance === undefined) {
      return yield* new OrchestrationGenerateConversationSummaryError({
        message: `Provider instance '${input.instanceId}' is not available.`,
      });
    }
    const modelId =
      CONVERSATION_SUMMARY_MODEL_BY_PROVIDER[instance.driverKind] ??
      DEFAULT_GIT_TEXT_GENERATION_MODEL;
    return {
      modelSelection: {
        instanceId: input.instanceId,
        model: modelId,
      } satisfies ModelSelection,
      modelId,
    } satisfies ResolvedModel;
  });

export interface ConversationSummaryParams {
  readonly thread: OrchestrationThread;
  readonly workspaceRoot: string;
  readonly registry: ProviderInstanceRegistryShape;
  readonly force: boolean;
  readonly now: string;
}

/**
 * Produce a 2-3 sentence recap of a thread, hitting the LRU cache first.
 *
 * Cache semantics:
 *   - Key is `(threadId, latestTurn.turnId | null)`. A new completed turn
 *     pushes the key forward, so the cached entry naturally becomes
 *     unreachable without explicit invalidation.
 *   - `force=true` skips the cache lookup but still writes the result back,
 *     so the next viewer benefits from the fresh entry.
 */
export const summarizeConversation = Effect.fn("conversationSummary.summarize")(function* (
  params: ConversationSummaryParams,
) {
  const { thread, registry, force, now } = params;
  if (thread.session === null || thread.session.providerInstanceId === undefined) {
    return yield* new OrchestrationGenerateConversationSummaryError({
      message: `Thread '${thread.id}' has no provider session attached; cannot summarise.`,
    });
  }

  const turnId = thread.latestTurn?.turnId ?? null;

  if (!force) {
    const cached = readCache(thread.id, turnId);
    if (cached) {
      return { ...cached, fromCache: true };
    }
  }

  // Map the in-memory message list into the transcript shape the prompt
  // builder expects. System messages are protocol scaffolding; drop them.
  const transcript = thread.messages.flatMap((message) => {
    if (message.role === "system") return [];
    const text = message.text.trim();
    if (text.length === 0) return [];
    return [
      {
        role: (message.role === "assistant" ? "agent" : "user") as "user" | "agent",
        text,
      },
    ];
  });

  if (transcript.length === 0) {
    return yield* new OrchestrationGenerateConversationSummaryError({
      message: `Thread '${thread.id}' has no transcript to summarise yet.`,
    });
  }

  const { modelSelection, modelId } = yield* resolveSummaryModel({
    registry,
    instanceId: thread.session.providerInstanceId,
  });

  const textGeneration = yield* TextGeneration;
  const startedAt = yield* Clock.currentTimeMillis;
  const generated = yield* textGeneration
    .generateConversationSummary({
      cwd: params.workspaceRoot,
      threadTitle: thread.title,
      transcript,
      modelSelection,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationGenerateConversationSummaryError({
            message: `Conversation summary generation failed: ${cause.detail}`,
            cause,
          }),
      ),
    );

  const endedAt = yield* Clock.currentTimeMillis;
  const durationMs = endedAt - startedAt;
  const resolvedInstance = yield* registry.getInstance(thread.session.providerInstanceId);
  yield* Effect.logInfo("[📝 SummaryGen]", {
    threadId: thread.id,
    driverKind: resolvedInstance?.driverKind,
    model: modelId,
    durationMs,
    transcriptMessages: transcript.length,
    ok: true,
  });

  const result: OrchestrationGenerateConversationSummaryResult = {
    summary: generated.summary,
    generatedAt: now,
    generatedByModel: modelId,
    generatedFromTurnId: turnId,
    fromCache: false,
  };

  writeCache(thread.id, turnId, result);
  return result;
});

/**
 * Internal accessor for tests — never used by production code.
 */
export const __internals = {
  cacheKey,
  readCache,
  writeCache,
  clear: () => cache.clear(),
  size: () => cache.size,
};
