import {
  ContextAssistantSessionId,
  EventId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import type { ProviderAdapterV2, ProviderAdapterV2Event, ProviderAdapterV2SessionRuntime, ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import { emptyProjection } from "./orchestration-v2/ProjectionStore.ts";

import {
  makeContextAssistantManager,
  buildBoundedThreadTranscript,
  buildContextAssistantInitialPrompt,
} from "./contextAssistant.ts";

function message(index: number, text: string): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make(`message-${index}`),
    role: index % 2 === 0 ? "user" : "assistant",
    text,
    threadId: ThreadId.make("thread-1"),
    runId: null,
    nodeId: null,
    createdBy: "user",
    creationSource: "web",
    attachments: [],
    streaming: false,
    createdAt: DateTime.makeUnsafe(`2026-07-24T10:00:0${index}.000Z`),
    updatedAt: DateTime.makeUnsafe(`2026-07-24T10:00:0${index}.000Z`),
  };
}

const sourceThread = {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Long refactor",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "rebuild",
      worktreePath: "/tmp/worktree",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: ProviderInstanceId.make("codex"),
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: ThreadId.make("thread-1"),
      },
      forkedFrom: null,
      lastVisitedAt: null,
      createdAt: DateTime.makeUnsafe("2026-07-24T10:00:00.000Z"),
      updatedAt: DateTime.makeUnsafe("2026-07-24T10:00:00.000Z"),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    } satisfies OrchestrationV2AppThread;
const sourceProject = {
      id: ProjectId.make("project-1"),
      title: "Campfire",
      workspaceRoot: "/tmp/campfire",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-07-24T10:00:00.000Z",
      updatedAt: "2026-07-24T10:00:00.000Z",
    } satisfies OrchestrationProjectShell;


describe("context assistant prompt", () => {
  it("keeps the newest messages when the transcript is bounded", () => {
    const transcript = buildBoundedThreadTranscript(
      [message(1, "old detail"), message(2, "middle detail"), message(3, "latest decision")],
      105,
    );

    expect(transcript).toContain("latest decision");
    expect(transcript).not.toContain("old detail");
    expect(transcript.length).toBeLessThanOrEqual(105);
  });

  it("places the frozen source transcript before the user's question", () => {
    const thread = sourceThread;
    const project = sourceProject;

    const prompt = buildContextAssistantInitialPrompt({
      thread,
      project,
      messages: [message(1, "We chose the queue design.")],
      question: "What did we decide?",
    });

    expect(prompt.indexOf("We chose the queue design.")).toBeLessThan(
      prompt.indexOf("What did we decide?"),
    );
    expect(prompt).toContain("read-only briefing");
  });
});


const privateInput = { sessionId: ContextAssistantSessionId.make("private"), sourceThreadId: sourceThread.id, prompt: "Summarize our decision" };
const unsupported = () => Effect.die("Unexpected provider operation in private briefing");
const makeHarness = Effect.fn(function* (openGate?: Deferred.Deferred<void>) {
  const crypto = yield* Crypto.Crypto;
  const opened = yield* Queue.unbounded<{
    readonly events: Queue.Queue<ProviderAdapterV2Event>;
    readonly started: Queue.Queue<ProviderAdapterV2TurnInput>;
    closeCount: number;
    subscriptionCount: number;
  }>();
  const source = { ...emptyProjection({ id: EventId.make("source"), type: "thread.created", threadId: sourceThread.id, occurredAt: sourceThread.createdAt, payload: sourceThread }), messages: [message(1, "Shared source discussion")] };
  let sourceReads = 0;
  const adapter = {
    instanceId: sourceThread.providerInstanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) => Effect.gen(function* () {
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const started = yield* Queue.unbounded<ProviderAdapterV2TurnInput>();
      const control = { events, started, closeCount: 0, subscriptionCount: 0 };
      yield* Effect.addFinalizer(() => Effect.sync(() => { control.closeCount += 1; }).pipe(Effect.andThen(Queue.end(events))));
      yield* Queue.offer(opened, control);
      if (openGate) yield* Deferred.await(openGate);
      const now = sourceThread.createdAt;
      const providerThread = {
        id: ProviderThreadId.make(`native:${input.threadId}`), driver: adapter.driver, providerInstanceId: adapter.instanceId,
        providerSessionId: input.providerSessionId, appThreadId: input.threadId, ownerNodeId: null,
        nativeThreadRef: null, nativeConversationHeadRef: null, status: "idle" as const,
        firstRunOrdinal: null, lastRunOrdinal: null, handoffIds: [], forkedFrom: null, createdAt: now, updatedAt: now,
      };
      return {
        instanceId: adapter.instanceId, driver: adapter.driver, providerSessionId: input.providerSessionId,
        providerSession: { id: input.providerSessionId, driver: adapter.driver, providerInstanceId: adapter.instanceId, status: "ready", cwd: input.runtimePolicy.cwd, model: input.modelSelection.model, capabilities: CodexProviderCapabilitiesV2, createdAt: now, updatedAt: now, lastError: null },
        events: Stream.fromQueue(events),
        subscribeEvents: Effect.sync(() => {
          control.subscriptionCount += 1;
          return { events: Stream.fromQueue(events), close: Effect.sync(() => { control.subscriptionCount -= 1; }) };
        }),
        ensureThread: () => Effect.succeed(providerThread),
        resumeThread: unsupported,
        startTurn: (turn) => Queue.offer(started, turn).pipe(Effect.asVoid),
        steerTurn: unsupported, interruptTurn: unsupported, respondToRuntimeRequest: unsupported,
        readThreadSnapshot: unsupported, rollbackThread: unsupported, forkThread: unsupported,
      } satisfies ProviderAdapterV2SessionRuntime;
    }),
  } satisfies ProviderAdapterV2["Service"];
  const manager = makeContextAssistantManager({
    crypto,
    projections: { getThreadProjection: () => Effect.sync(() => { sourceReads += 1; return source; }) },
    projects: { getShell: () => Effect.succeed(Option.some(sourceProject)) },
    adapters: { get: () => Effect.succeed(adapter) },
  });
  yield* Effect.addFinalizer(() => manager.closeAll);
  const complete = (control: { events: Queue.Queue<ProviderAdapterV2Event> }, turn: ProviderAdapterV2TurnInput, text: string) => Effect.gen(function* () {
    yield* Queue.offer(control.events, { type: "message.updated", driver: adapter.driver, message: { ...message(2, text), threadId: turn.threadId, runId: turn.runId, role: "assistant" } });
    yield* Queue.offer(control.events, { type: "turn.terminal", driver: adapter.driver, providerThreadId: turn.providerThread.id, providerTurnId: ProviderTurnId.make(`turn:${turn.runId}`), runOrdinal: turn.runOrdinal, status: "completed", failure: null, threadDisposition: "reusable" });
  });
  return { manager, opened, complete, source, sourceReads: () => sourceReads };
});

it.effect("isolates owners with identical private IDs and rejects concurrent asks", () => Effect.gen(function* () {
  const h = yield* makeHarness();
  const alice = yield* h.manager.ask(privateInput, "alice");
  const a = yield* Queue.take(h.opened);
  const aTurn = yield* Queue.take(a.started);
  expect((yield* Effect.flip(h.manager.ask(privateInput, "alice"))).code).toBe("session_busy");
  const bob = yield* h.manager.ask(privateInput, "bob");
  const b = yield* Queue.take(h.opened);
  const bTurn = yield* Queue.take(b.started);
  expect(aTurn.threadId).not.toBe(bTurn.threadId);
  expect(aTurn.runtimePolicy.sandboxPolicy).toEqual({ type: "readOnly" });
  expect(yield* h.manager.close(privateInput.sessionId, "stranger")).toEqual({ closed: false });
  yield* h.complete(a, aTurn, "Alice private answer");
  yield* h.complete(b, bTurn, "Bob private answer");
  expect(yield* Stream.runCollect(alice)).toEqual([{ type: "assistant.delta", delta: "Alice private answer" }, { type: "assistant.completed" }]);
  expect(yield* Stream.runCollect(bob)).toEqual([{ type: "assistant.delta", delta: "Bob private answer" }, { type: "assistant.completed" }]);
  expect(a.subscriptionCount).toBe(0);
  expect(b.subscriptionCount).toBe(0);
  expect(h.source.messages).toEqual([message(1, "Shared source discussion")]);
}).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)));

it.effect("retains only private provider history for follow-up questions", () => Effect.gen(function* () {
  const h = yield* makeHarness();
  const answer = yield* h.manager.ask(privateInput, "alice");
  const control = yield* Queue.take(h.opened);
  const first = yield* Queue.take(control.started);
  expect(first.message.text).toContain("Shared source discussion");
  yield* h.complete(control, first, "First answer");
  yield* Stream.runCollect(answer);
  const followup = yield* h.manager.ask({ ...privateInput, prompt: "Why?" }, "alice");
  const second = yield* Queue.take(control.started);
  expect(second.message.text).toBe("Why?");
  expect(second.runOrdinal).toBe(2);
  expect(second.providerThread.id).toBe(first.providerThread.id);
  expect(h.sourceReads()).toBe(1);
  yield* h.complete(control, second, "Private follow-up");
  yield* Stream.runCollect(followup);
  expect(control.subscriptionCount).toBe(0);
  expect(control.closeCount).toBe(0);
  expect(yield* h.manager.close(privateInput.sessionId, "alice")).toEqual({ closed: true });
  expect(control.closeCount).toBe(1);
}).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)));

it.effect("closes a provider that is still opening and allows a clean retry", () => Effect.gen(function* () {
  const gate = yield* Deferred.make<void>();
  const h = yield* makeHarness(gate);
  const opening = yield* h.manager.ask(privateInput, "alice").pipe(Effect.forkScoped);
  const control = yield* Queue.take(h.opened);
  expect(yield* h.manager.close(privateInput.sessionId, "alice")).toEqual({ closed: true });
  expect(Exit.isFailure(yield* Fiber.await(opening))).toBe(true);
  expect(control.closeCount).toBe(1);
  yield* Deferred.succeed(gate, undefined);
  const answer = yield* h.manager.ask(privateInput, "alice");
  const retried = yield* Queue.take(h.opened);
  const turn = yield* Queue.take(retried.started);
  yield* h.complete(retried, turn, "Retry answer");
  yield* Stream.runCollect(answer);
}).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)));

it.effect("releases the runtime when the consumer cancels before a terminal event", () => Effect.gen(function* () {
  const h = yield* makeHarness();
  const answer = yield* h.manager.ask(privateInput, "alice");
  const control = yield* Queue.take(h.opened);
  const turn = yield* Queue.take(control.started);
  yield* Queue.offer(control.events, { type: "message.updated", driver: ProviderDriverKind.make("codex"), message: { ...message(2, "Partial"), threadId: turn.threadId, runId: turn.runId, role: "assistant" } });
  expect(yield* answer.pipe(Stream.take(1), Stream.runCollect)).toEqual([{ type: "assistant.delta", delta: "Partial" }]);
  expect(control.closeCount).toBe(1);
  expect(control.subscriptionCount).toBe(0);
  expect(yield* h.manager.close(privateInput.sessionId, "alice")).toEqual({ closed: false });
}).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)));

it.effect("releases an accepted ask even when its response stream is never consumed", () => Effect.gen(function* () {
  const h = yield* makeHarness();
  yield* h.manager.ask(privateInput, "alice").pipe(Effect.scoped);
  const control = yield* Queue.take(h.opened);
  expect(control.closeCount).toBe(1);
  expect(control.subscriptionCount).toBe(0);
}).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)));
