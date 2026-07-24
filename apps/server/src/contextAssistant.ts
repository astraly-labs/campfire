import {
  ContextAssistantError,
  type ContextAssistantAskInput,
  type ContextAssistantCloseResult,
  type ContextAssistantSessionId,
  type ContextAssistantStreamEvent,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderServiceShape } from "./provider/Services/ProviderService.ts";

const MAX_TRANSCRIPT_CHARS = 48_000;
const EVENT_BUFFER_CAPACITY = 2_048;

interface ContextAssistantSession {
  readonly sourceThreadId: ThreadId;
  readonly providerThreadId: ThreadId;
  busy: boolean;
  activeTurnId: TurnId | null;
}

interface ContextAssistantDependencies {
  readonly crypto: Crypto.Crypto;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly providerService: ProviderServiceShape;
}

function formatMessage(message: OrchestrationMessage): string {
  const author = message.author?.displayName ? ` · ${message.author.displayName}` : "";
  return `[${message.createdAt} · ${message.role}${author} · ${message.id}]\n${message.text}`;
}

export function buildBoundedThreadTranscript(
  messages: ReadonlyArray<OrchestrationMessage>,
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
  readonly thread: OrchestrationThread;
  readonly project: OrchestrationProjectShell;
  readonly question: string;
}): string {
  const transcript = buildBoundedThreadTranscript(input.thread.messages);
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

function contextAssistantError(
  code: ContextAssistantError["code"],
  message: string,
  cause?: unknown,
): ContextAssistantError {
  return new ContextAssistantError({
    code,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function isTerminalEvent(event: ProviderRuntimeEvent, turnId: TurnId): boolean {
  if (event.type === "session.exited") return true;
  if (event.type === "runtime.error") {
    return event.turnId === undefined || event.turnId === turnId;
  }
  if (event.turnId !== turnId) return false;
  return event.type === "turn.completed" || event.type === "turn.aborted";
}

function toStreamEvent(
  event: ProviderRuntimeEvent,
  turnId: TurnId,
): Option.Option<ContextAssistantStreamEvent> {
  if (event.type === "runtime.error" && (event.turnId === undefined || event.turnId === turnId)) {
    return Option.some({ type: "assistant.failed", message: event.payload.message });
  }
  if (event.type === "session.exited") {
    return Option.some({
      type: "assistant.failed",
      message: event.payload.reason ?? "The private briefing session closed.",
    });
  }
  if (event.turnId !== turnId) return Option.none();
  if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
    return Option.some({ type: "assistant.delta", delta: event.payload.delta });
  }
  if (event.type === "turn.completed") {
    return event.payload.state === "completed"
      ? Option.some({ type: "assistant.completed" })
      : Option.some({
          type: "assistant.failed",
          message: event.payload.errorMessage ?? `Briefing stopped (${event.payload.state}).`,
        });
  }
  if (event.type === "turn.aborted") {
    return Option.some({ type: "assistant.failed", message: event.payload.reason });
  }
  return Option.none();
}

export function makeContextAssistantManager(dependencies: ContextAssistantDependencies) {
  const sessions = new Map<ContextAssistantSessionId, ContextAssistantSession>();

  const cleanupSession = (session: ContextAssistantSession) =>
    Effect.gen(function* () {
      if (session.activeTurnId !== null) {
        yield* dependencies.providerService
          .interruptTurn({
            threadId: session.providerThreadId,
            turnId: session.activeTurnId,
          })
          .pipe(Effect.ignore({ log: true }));
      }
      yield* dependencies.providerService
        .stopSession({ threadId: session.providerThreadId })
        .pipe(Effect.ignore({ log: true }));
    });

  const close = (
    sessionId: ContextAssistantSessionId,
  ): Effect.Effect<ContextAssistantCloseResult> => {
    const session = sessions.get(sessionId);
    if (!session) return Effect.succeed({ closed: false });
    sessions.delete(sessionId);
    return cleanupSession(session).pipe(Effect.as({ closed: true }));
  };

  const closeAll = Effect.suspend(() =>
    Effect.forEach(Array.from(sessions.keys()), close, {
      concurrency: "unbounded",
      discard: true,
    }),
  );

  const ask = (
    input: ContextAssistantAskInput,
  ): Effect.Effect<
    Stream.Stream<ContextAssistantStreamEvent>,
    ContextAssistantError,
    Scope.Scope
  > =>
    Effect.gen(function* () {
      let session = sessions.get(input.sessionId);
      let prompt = input.prompt;
      let createdSession = false;

      if (session && session.sourceThreadId !== input.sourceThreadId) {
        return yield* contextAssistantError(
          "session_conflict",
          "This private briefing belongs to a different thread.",
        );
      }
      if (session?.busy) {
        return yield* contextAssistantError(
          "session_busy",
          "Wait for the current briefing answer to finish.",
        );
      }

      if (!session) {
        const thread = yield* dependencies.projectionSnapshotQuery
          .getThreadDetailById(input.sourceThreadId)
          .pipe(
            Effect.mapError((cause) =>
              contextAssistantError(
                "provider_error",
                "Could not load the source conversation.",
                cause,
              ),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    contextAssistantError(
                      "source_not_found",
                      "The source conversation no longer exists.",
                    ),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          );
        const project = yield* dependencies.projectionSnapshotQuery
          .getProjectShellById(thread.projectId)
          .pipe(
            Effect.mapError((cause) =>
              contextAssistantError("provider_error", "Could not load the source project.", cause),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    contextAssistantError(
                      "source_not_found",
                      "The source project no longer exists.",
                    ),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          );
        const providerThreadUuid = yield* dependencies.crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) =>
            contextAssistantError(
              "provider_error",
              "Could not create the private briefing.",
              cause,
            ),
          ),
        );
        const providerThreadId = ThreadId.make(`context-assistant:${providerThreadUuid}`);
        yield* dependencies.providerService
          .startSession(providerThreadId, {
            threadId: providerThreadId,
            providerInstanceId: thread.modelSelection.instanceId,
            cwd: thread.worktreePath ?? project.workspaceRoot,
            modelSelection: thread.modelSelection,
            approvalPolicy: "never",
            sandboxMode: "read-only",
            runtimeMode: "approval-required",
          })
          .pipe(
            Effect.mapError((cause) =>
              contextAssistantError(
                "provider_error",
                "Could not start the private briefing.",
                cause,
              ),
            ),
          );
        session = {
          sourceThreadId: input.sourceThreadId,
          providerThreadId,
          busy: false,
          activeTurnId: null,
        };
        sessions.set(input.sessionId, session);
        createdSession = true;
        prompt = buildContextAssistantInitialPrompt({
          thread,
          project,
          question: input.prompt,
        });
      }

      session.busy = true;
      const currentSession = session;
      const queue = yield* Queue.bounded<ProviderRuntimeEvent>(EVENT_BUFFER_CAPACITY);
      yield* Effect.forkScoped(
        dependencies.providerService.streamEvents.pipe(
          Stream.filter((event) => event.threadId === currentSession.providerThreadId),
          Stream.runForEach((event) => Queue.offer(queue, event).pipe(Effect.asVoid)),
        ),
        { startImmediately: true },
      );

      const turn = yield* dependencies.providerService
        .sendTurn({
          threadId: currentSession.providerThreadId,
          input: prompt,
          interactionMode: "default",
        })
        .pipe(
          Effect.mapError((cause) =>
            contextAssistantError(
              "provider_error",
              "The private briefing could not answer.",
              cause,
            ),
          ),
          Effect.tapError(() =>
            Effect.sync(() => {
              currentSession.busy = false;
              if (createdSession) sessions.delete(input.sessionId);
            }).pipe(Effect.andThen(createdSession ? cleanupSession(currentSession) : Effect.void)),
          ),
        );
      currentSession.activeTurnId = turn.turnId;

      const releaseTurn = Effect.gen(function* () {
        if (currentSession.activeTurnId === turn.turnId) {
          currentSession.activeTurnId = null;
          currentSession.busy = false;
        }
        yield* dependencies.providerService
          .interruptTurn({
            threadId: currentSession.providerThreadId,
            turnId: turn.turnId,
          })
          .pipe(Effect.ignore({ log: true }));
      });

      return Stream.fromQueue(queue).pipe(
        Stream.filter(
          (event) =>
            event.turnId === turn.turnId ||
            event.type === "session.exited" ||
            (event.type === "runtime.error" && event.threadId === currentSession.providerThreadId),
        ),
        Stream.takeUntil((event) => isTerminalEvent(event, turn.turnId)),
        Stream.map((event) => toStreamEvent(event, turn.turnId)),
        Stream.filter(Option.isSome),
        Stream.map((event) => event.value),
        Stream.ensuring(releaseTurn),
      );
    });

  return { ask, close, closeAll };
}

export function makeUnavailableContextAssistantManager() {
  return {
    ask: (_input: ContextAssistantAskInput) =>
      Effect.fail(
        contextAssistantError(
          "provider_error",
          "Private briefing is unavailable in this server runtime.",
        ),
      ),
    close: (_sessionId: ContextAssistantSessionId) =>
      Effect.succeed({ closed: false } satisfies ContextAssistantCloseResult),
    closeAll: Effect.void,
  };
}
