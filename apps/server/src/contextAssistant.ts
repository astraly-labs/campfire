import {
  ContextAssistantError,
  MessageId,
  NodeId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ContextAssistantAskInput,
  type ContextAssistantSessionId,
  type ContextAssistantStreamEvent,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type ProviderTurnId,
} from "@t3tools/contracts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Error,
  ProviderAdapterV2RuntimePolicy,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { ProjectionStoreV2Shape } from "./orchestration-v2/ProjectionStore.ts";
import type { ProjectStoreV2 } from "./orchestration-v2/ProjectStore.ts";
import type { ProviderAdapterRegistryV2Shape } from "./orchestration-v2/ProviderAdapterRegistry.ts";

const MAX_TRANSCRIPT_CHARS = 48_000;
const EVENT_BUFFER_CAPACITY = 2_048;

interface ContextAssistantDependencies {
  readonly crypto: Crypto.Crypto;
  readonly projections: Pick<ProjectionStoreV2Shape, "getThreadProjection">;
  readonly projects: Pick<ProjectStoreV2["Service"], "getShell">;
  readonly adapters: Pick<ProviderAdapterRegistryV2Shape, "get">;
}

interface BriefingSession {
  readonly kind: "ready";
  readonly sourceThreadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly closed: Deferred.Deferred<void>;
  readonly runtime: ProviderAdapterV2SessionRuntime;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly appThread: OrchestrationV2AppThread;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  ordinal: number;
  busy: boolean;
  activeTurnId: ProviderTurnId | null;
}

interface OpeningSession {
  readonly kind: "opening";
  readonly scope: Scope.Closeable;
  readonly closed: Deferred.Deferred<void>;
}
type BriefingState = OpeningSession | BriefingSession;

function formatMessage(message: OrchestrationV2ConversationMessage): string {
  const author = message.author?.displayName ? ` · ${message.author.displayName}` : "";
  return `[${DateTime.formatIso(message.createdAt)} · ${message.role}${author} · ${message.id}]\n${message.text}`;
}

export function buildBoundedThreadTranscript(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  maxChars = MAX_TRANSCRIPT_CHARS,
): string {
  const selected: string[] = [];
  let remaining = Math.max(0, maxChars);

  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const formatted = formatMessage(messages[index]!);
    const separatorLength = selected.length === 0 ? 0 : 2;
    const available = Math.max(0, remaining - separatorLength);
    if (available === 0) break;
    const excerpt =
      formatted.length <= available
        ? formatted
        : `…${formatted.slice(Math.max(0, formatted.length - available + 1))}`;
    selected.push(excerpt);
    remaining -= excerpt.length + separatorLength;
  }

  return selected.toReversed().join("\n\n");
}

export function buildContextAssistantInitialPrompt(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly project: OrchestrationProjectShell;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly question: string;
}): string {
  const transcript = buildBoundedThreadTranscript(input.messages);
  return [
    "You are a private, temporary briefing assistant for one existing coding conversation.",
    "Explain only from the supplied conversation and clearly label uncertainty.",
    "Do not modify files, run commands, contact people, or take actions. This is a read-only briefing.",
    "Answer in the user's language. Use concise Markdown. When useful, cite message IDs from the transcript.",
    "If a diagram would clarify the answer, use a Mermaid code block.",
    "",
    "SOURCE THREAD",
    `Project: ${input.project.title}`,
    `Thread: ${input.thread.title}`,
    `Branch: ${input.thread.branch ?? "not set"}`,
    `Workspace: ${input.thread.worktreePath ?? input.project.workspaceRoot}`,
    "",
    "CONVERSATION TRANSCRIPT (oldest retained message first)",
    transcript || "(No messages in this thread.)",
    "",
    "USER QUESTION",
    input.question,
  ].join("\n");
}

const briefingError = (message: string, cause?: unknown) =>
  new ContextAssistantError({
    code: "provider_error",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

/** Private runtimes bypass the durable orchestrator, so answers never enter the shared thread. */
export function makeContextAssistantManager(dependencies: ContextAssistantDependencies) {
  const sessions = new Map<string, BriefingState>();
  const keyFor = (ownerKey: string, sessionId: ContextAssistantSessionId) =>
    JSON.stringify([ownerKey, sessionId]);

  const closeKey = (key: string) =>
    Effect.suspend(() => {
      const session = sessions.get(key);
      sessions.delete(key);
      if (!session) return Effect.succeed({ closed: false });
      return Deferred.succeed(session.closed, undefined).pipe(
        Effect.andThen(Scope.close(session.scope, Exit.void)),
        Effect.as({ closed: true }),
      );
    });

  const close = (sessionId: ContextAssistantSessionId, ownerKey: string) =>
    closeKey(keyFor(ownerKey, sessionId));
  const closeAll = Effect.suspend(() =>
    Effect.forEach([...sessions.keys()], closeKey, { concurrency: "unbounded", discard: true }),
  );

  const createSession = Effect.fn("contextAssistant.createSession")(function* (
    key: string,
    opening: OpeningSession,
    input: ContextAssistantAskInput,
  ) {
    const scope = opening.scope;
    return yield* Effect.gen(function* () {
      const source = yield* dependencies.projections.getThreadProjection(input.sourceThreadId);
      const thread = source.thread;
      if (thread.deletedAt !== null)
        return yield* new ContextAssistantError({
          code: "source_not_found",
          message: "The source conversation no longer exists.",
        });
      const project = yield* dependencies.projects.getShell(thread.projectId);
      if (Option.isNone(project))
        return yield* new ContextAssistantError({
          code: "source_not_found",
          message: "The source project no longer exists.",
        });
      const uuid = yield* dependencies.crypto.randomUUIDv4;
      const threadId = ThreadId.make(`context-assistant:${uuid}`);
      const providerSessionId = ProviderSessionId.make(`context-assistant:${uuid}`);
      const runtimePolicy = {
        cwd: thread.worktreePath ?? project.value.workspaceRoot,
        runtimeMode: "approval-required",
        interactionMode: "default",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      } satisfies ProviderAdapterV2RuntimePolicy;
      const adapter = yield* dependencies.adapters.get(thread.modelSelection.instanceId);
      const runtime = yield* adapter
        .openSession({
          threadId,
          providerSessionId,
          modelSelection: thread.modelSelection,
          runtimePolicy,
        })
        .pipe(Scope.provide(scope));
      const providerThread = yield* runtime.ensureThread({
        threadId,
        providerSessionId,
        title: "Private briefing",
        modelSelection: thread.modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const appThread: OrchestrationV2AppThread = {
        ...thread,
        id: threadId,
        title: "Private briefing",
        createdBy: "user",
        creationSource: "web",
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        archivedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      if (sessions.get(key) !== opening)
        return yield* briefingError("The private briefing was closed.");
      const session: BriefingSession = {
        kind: "ready",
        sourceThreadId: input.sourceThreadId,
        scope,
        closed: opening.closed,
        runtime,
        providerThread,
        appThread,
        runtimePolicy,
        ordinal: 0,
        busy: true,
        activeTurnId: null,
      };
      sessions.set(key, session);
      return {
        session,
        prompt: buildContextAssistantInitialPrompt({
          thread,
          project: project.value,
          messages: source.messages,
          question: input.prompt,
        }),
      };
    }).pipe(
      Effect.raceFirst(Deferred.await(opening.closed).pipe(
        Effect.andThen(Effect.fail(briefingError("The private briefing was closed."))),
      )),
      Effect.mapError((cause) =>
        Schema.is(ContextAssistantError)(cause)
          ? cause
          : briefingError("Could not start the private briefing.", cause),
      ),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
  });

  const ask = Effect.fn("contextAssistant.ask")(function* (
    input: ContextAssistantAskInput,
    ownerKey: string,
  ) {
    const key = keyFor(ownerKey, input.sessionId);
    const existing = sessions.get(key);
    if (existing?.kind === "opening" || existing?.busy)
      return yield* new ContextAssistantError({
        code: "session_busy",
        message: "Wait for the current briefing answer to finish.",
      });
    if (existing && existing.sourceThreadId !== input.sourceThreadId)
      return yield* new ContextAssistantError({
        code: "session_conflict",
        message: "This private briefing belongs to a different thread.",
      });
    let session: BriefingSession;
    let prompt = input.prompt;
    if (existing) {
      session = existing;
      session.busy = true;
    } else {
      const opening: OpeningSession = {
        kind: "opening", scope: Scope.makeUnsafe(), closed: Deferred.makeUnsafe<void>(),
      };
      sessions.set(key, opening);
      const opened = yield* createSession(key, opening, input).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            if (sessions.get(key) === opening) sessions.delete(key);
          }),
        ),
      );
      session = opened.session;
      prompt = opened.prompt;
    }
    const currentSession = session;
    const turnScope = yield* Scope.make();
    let completed = false;
    let finished = false;
    const finish = Effect.suspend(() => {
      if (finished) return Effect.void;
      finished = true;
      currentSession.busy = false;
      currentSession.activeTurnId = null;
      return Scope.close(turnScope, Exit.void).pipe(
        Effect.andThen(completed || sessions.get(key) !== currentSession
          ? Effect.void
          : closeKey(key).pipe(Effect.asVoid)),
      );
    });
    yield* Effect.addFinalizer(() => finish);
    const queue = yield* Queue.bounded<
      ProviderAdapterV2Event,
      ProviderAdapterV2Error | ContextAssistantError
    >(EVENT_BUFFER_CAPACITY);
    const ordinal = ++session.ordinal;
    const uuid = yield* dependencies.crypto.randomUUIDv4.pipe(Effect.orDie);
    const runId = RunId.make(`briefing:${uuid}`);
    const textByMessage = new Map<string, string>();
    const belongsToTurn = (event: ProviderAdapterV2Event) => {
      switch (event.type) {
        case "message.updated":
          return (
            event.message.threadId === currentSession.appThread.id && event.message.runId === runId
          );
        case "provider_turn.updated":
          return (
            event.providerTurn.providerThreadId === currentSession.providerThread.id &&
            event.providerTurn.ordinal === ordinal
          );
        case "turn.terminal":
          return (
            event.providerThreadId === currentSession.providerThread.id &&
            event.runOrdinal === ordinal
          );
        case "runtime_request.updated":
          return event.threadId === currentSession.appThread.id;
        default:
          return false;
      }
    };
    const subscription = session.runtime.subscribeEvents
      ? yield* session.runtime.subscribeEvents
      : null;
    if (subscription) yield* Scope.addFinalizer(turnScope, subscription.close);
    yield* (subscription?.events ?? session.runtime.events).pipe(
      Stream.filter(belongsToTurn),
      Stream.runForEach((event) => Queue.offer(queue, event)),
      Effect.andThen(Queue.fail(queue, briefingError("The briefing provider disconnected."))),
      Effect.raceFirst(Deferred.await(currentSession.closed).pipe(
        Effect.andThen(Effect.fail(briefingError("The private briefing was closed."))),
      )),
      Effect.catch((cause) => Queue.fail(queue, cause)),
      Effect.forkIn(turnScope),
    );
    yield* session.runtime
      .startTurn({
        appThread: session.appThread,
        threadId: session.appThread.id,
        runId,
        runOrdinal: ordinal,
        providerTurnOrdinal: ordinal,
        attemptId: RunAttemptId.make(`briefing:${uuid}`),
        rootNodeId: NodeId.make(`briefing:${uuid}`),
        providerThread: session.providerThread,
        message: {
          messageId: MessageId.make(`briefing:${uuid}`),
          text: prompt,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: session.appThread.modelSelection,
        runtimePolicy: session.runtimePolicy,
      })
      .pipe(
        Effect.mapError((cause) => briefingError("The private briefing could not answer.", cause)),
        Effect.onError(() => closeKey(key)),
      );
    return Stream.fromQueue(queue).pipe(
      Stream.takeUntil(
        (event) => event.type === "turn.terminal" || event.type === "runtime_request.updated",
      ),
      Stream.map((event): ContextAssistantStreamEvent | null => {
        switch (event.type) {
          case "provider_turn.updated":
            currentSession.activeTurnId = event.providerTurn.id;
            return null;
          case "message.updated": {
            if (event.message.role !== "assistant") return null;
            const previous = textByMessage.get(event.message.id) ?? "";
            textByMessage.set(event.message.id, event.message.text);
            const delta = event.message.text.startsWith(previous)
              ? event.message.text.slice(previous.length)
              : event.message.text;
            return delta ? { type: "assistant.delta", delta } : null;
          }
          case "turn.terminal":
            completed = event.status === "completed";
            return event.status === "completed"
              ? { type: "assistant.completed" }
              : {
                  type: "assistant.failed",
                  message:
                    event.status === "failed"
                      ? event.failure.message
                      : "The briefing was interrupted.",
                };
          case "runtime_request.updated":
            return {
              type: "assistant.failed",
              message: "Private briefings cannot request tool approval.",
            };
          default:
            return null;
        }
      }),
      Stream.filter((event) => event !== null),
      Stream.catch(() =>
        Stream.succeed({
          type: "assistant.failed",
          message: "The briefing provider disconnected.",
        } satisfies ContextAssistantStreamEvent),
      ),
      Stream.ensuring(finish),
    );
  });
  return { ask, close, closeAll };
}
