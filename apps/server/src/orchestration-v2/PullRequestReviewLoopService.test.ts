import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type ReviewLoopId,
  type ReviewLoopPhase,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { liveAuthorLoop, reviewerMarker } from "@t3tools/shared/pullRequestReviewLoop";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as PullRequestReviewLoopService from "./PullRequestReviewLoopService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const authorModel = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const reviewerModel = {
  instanceId: ProviderInstanceId.make("cursor"),
  model: "composer-1",
} satisfies ModelSelection;
const projectId = ProjectId.make("project:review-loop");
const reviewerOffProjectId = ProjectId.make("project:review-loop:reviewer-off");
const authorOffProjectId = ProjectId.make("project:review-loop:author-off");
const pullRequest = { host: "github.com", repository: "pingdotgg/t3code", number: 42 };

interface Reply {
  readonly text: string;
  readonly status?: "completed" | "failed" | "interrupted";
  readonly until?: Deferred.Deferred<void>;
}

const unsupported = () => Effect.die("Unexpected provider operation in the review loop tests");

const scriptedAdapter = (
  model: ModelSelection,
  driverName: string,
  replies: Array<Reply>,
): ProviderAdapter.ProviderAdapterV2["Service"] => {
  const driver = ProviderDriverKind.make(driverName);
  return {
    instanceId: model.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerTurn = (
          turn: ProviderAdapter.ProviderAdapterV2TurnInput,
          status: "running" | "completed" | "failed" | "interrupted",
          at: DateTime.Utc,
        ) => ({
          type: "provider_turn.updated" as const,
          driver,
          providerTurn: {
            id: ProviderTurnId.make(`provider-turn:${turn.threadId}:${turn.runOrdinal}`),
            providerThreadId: turn.providerThread.id,
            nodeId: turn.rootNodeId,
            runAttemptId: turn.attemptId,
            nativeTurnRef: {
              driver,
              nativeId: `native-turn:${turn.threadId}:${turn.runOrdinal}`,
              strength: "strong" as const,
            },
            ordinal: turn.runOrdinal,
            status,
            startedAt: at,
            completedAt: status === "running" ? null : at,
          },
        });
        const finish = (turn: ProviderAdapter.ProviderAdapterV2TurnInput, reply: Reply) =>
          Effect.gen(function* () {
            const at = yield* DateTime.now;
            const status = reply.status ?? "completed";
            const providerTurnId = ProviderTurnId.make(
              `provider-turn:${turn.threadId}:${turn.runOrdinal}`,
            );
            yield* PubSub.publishAll(events, [
              providerTurn(turn, status, at),
              {
                type: "turn_item.updated",
                driver,
                turnItem: {
                  id: TurnItemId.make(`turn-item:${turn.threadId}:${turn.runOrdinal}:assistant`),
                  threadId: turn.threadId,
                  runId: turn.runId,
                  nodeId: turn.rootNodeId,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: turn.runOrdinal * 100 + 1,
                  status,
                  title: null,
                  startedAt: at,
                  completedAt: at,
                  updatedAt: at,
                  type: "assistant_message",
                  messageId: MessageId.make(`message:${turn.threadId}:${turn.runOrdinal}:reply`),
                  text: reply.text,
                  streaming: false,
                },
              },
              {
                type: "turn.terminal",
                driver,
                providerThreadId: turn.providerThread.id,
                providerTurnId,
                runOrdinal: turn.runOrdinal,
                ...(status === "failed"
                  ? {
                      status,
                      failureItemOrdinal: turn.runOrdinal * 100 + 2,
                      failure: makeProviderFailure({
                        message: reply.text,
                        code: "scripted_failure",
                        class: "provider_error",
                      }),
                    }
                  : { status, failure: null }),
                threadDisposition: "reusable",
              },
            ]);
          });
        return {
          instanceId: model.instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: model.instanceId,
            status: "ready",
            cwd: input.runtimePolicy.cwd ?? "/workspace",
            model: input.modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromPubSub(events),
          ensureThread: (thread) =>
            Effect.succeed({
              id: ProviderThreadId.make(`native:${thread.threadId}`),
              driver,
              providerInstanceId: model.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: thread.threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle" as const,
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: unsupported,
          startTurn: (turn) =>
            Effect.gen(function* () {
              const reply = replies.shift() ?? { text: "Done." };
              if (reply.until === undefined) return yield* finish(turn, reply);
              yield* PubSub.publish(events, providerTurn(turn, "running", yield* DateTime.now));
              yield* Deferred.await(reply.until).pipe(
                Effect.andThen(finish(turn, reply)),
                Effect.forkDetach,
              );
            }),
          steerTurn: unsupported,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: unsupported,
          readThreadSnapshot: unsupported,
          rollbackThread: unsupported,
          forkThread: unsupported,
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };
};

interface Script {
  readonly reviews: Array<Reply>;
  readonly fixes: Array<Reply>;
}

const layerFor = (script: Script) => {
  const database = SqlitePersistence.layerMemory;
  return ThreadManagementService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ProjectionStore.layer.pipe(Layer.provide(database)),
        EffectOutbox.layer.pipe(Layer.provide(database)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "review-loop" },
          ProviderAdapterRegistry.layerFromAdapters([
            scriptedAdapter(authorModel, "codex", script.fixes),
            scriptedAdapter(reviewerModel, "cursor", script.reviews),
          ]),
          { databaseLayer: database },
        ),
      ),
    ),
    Layer.provideMerge(
      ServerSettings.layerTest({
        providerInstances: { [reviewerModel.instanceId]: { driver: "cursor", enabled: true } },
        projectSettingsOverrides: {
          [reviewerOffProjectId]: {
            providerInstances: { [reviewerModel.instanceId]: { enabled: false } },
          },
          [authorOffProjectId]: {
            providerInstances: { [authorModel.instanceId]: { enabled: false } },
          },
        },
      }),
    ),
    Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(database))),
    Layer.provideMerge(
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: (instanceId) =>
          Effect.succeed(
            instanceId === reviewerModel.instanceId
              ? ({
                  snapshot: { getSnapshot: Effect.succeed({ displayName: "Cursor" }) },
                } as unknown as ProviderInstance)
              : undefined,
          ),
      }),
    ),
  );
};

const runWith = <A, E, R>(script: Script, test: Effect.Effect<A, E, R>) =>
  test.pipe(Effect.scoped, Effect.provide(layerFor(script)));

const dispatch = (command: OrchestrationV2ServerCommand) =>
  Effect.flatMap(ThreadManagementService.ThreadManagementService, (threads) =>
    threads.dispatch(command),
  );

const threadOf = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(threadId),
  );

const linkOf = (threadId: ThreadId) =>
  Effect.map(
    threadOf(threadId),
    (projection) =>
      projection.thread.pullRequests?.find((link) => link.number === pullRequest.number) ?? null,
  );

const phaseOf = (sourceId: ThreadId) =>
  Effect.map(linkOf(sourceId), (link) =>
    link?.reviewLoop?.role === "author" ? link.reviewLoop.phase : null,
  );

const loopMessages = (threadId: ThreadId) =>
  Effect.map(threadOf(threadId), (projection) =>
    projection.messages
      .filter(
        (message) =>
          message.role === "user" &&
          message.createdBy === "agent" &&
          message.creationSource === "server",
      )
      .map((message) => message.text),
  );

const startLoop = (
  sourceId: ThreadId,
  options: { readonly projectId?: ProjectId; readonly name?: string } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${sourceId}`),
      threadId: sourceId,
      projectId: options.projectId ?? projectId,
      title: "Fix the login check",
      modelSelection: authorModel,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/login",
      worktreePath: yield* checkpointWorkspace("review-loop"),
      createdBy: "user",
      creationSource: "web",
    });
    yield* dispatch({
      type: "thread.pull-request.link",
      commandId: CommandId.make(`link:${sourceId}`),
      threadId: sourceId,
      ...pullRequest,
      url: "https://github.com/pingdotgg/t3code/pull/42",
      source: "created",
    });
    yield* orchestrator.dispatch({
      type: "thread.pull-request.review-loop",
      commandId: CommandId.make(`review-loop:${options.name ?? sourceId}`),
      threadId: sourceId,
      ...pullRequest,
      createdBy: "user",
      creationSource: "web",
      request: { type: "start", reviewer: reviewerModel, budget: 3 },
    });
    const link = yield* linkOf(sourceId);
    const loop = link === null ? undefined : liveAuthorLoop(link);
    assert.isDefined(loop);
    return loop!;
  });

const awaitTurn = (
  threadId: ThreadId,
  loop: { readonly id: ReviewLoopId },
  phase: ReviewLoopPhase,
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const messageId = IdAllocator.derive.reviewLoopMessage({ loopId: loop.id, phase });
    const runId = (yield* threadOf(threadId)).messages.find(
      (message) => message.id === messageId,
    )?.runId;
    assert.isDefined(runId);
    yield* sink.stream({ threadId, eventType: "run.updated" }).pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "run.updated" &&
          event.payload.id === runId &&
          ThreadManagementService.isTerminalRunStatus(event.payload.status),
      ),
      Stream.runHead,
    );
  });

const stepRepeatedly = (
  reactor: PullRequestReviewLoopService.PullRequestReviewLoopService["Service"],
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    for (let step = 0; step < 3; step += 1) yield* reactor.advanceThread(threadId);
    yield* reactor.sweep;
  });

const reviewing = (round: 1 | 2 | 3) => ({ status: "reviewing", budget: 3, round }) as const;
const fixing = (round: 1 | 2) => ({ status: "fixing", budget: 3, round, open: [] }) as const;
const changes = (finding: string): Reply => ({ text: `VERDICT: CHANGES\n${finding}` });

it.live(
  "a loop approved at review 2 posts each step once and then frees both threads",
  () =>
    runWith(
      {
        reviews: [
          changes("src/login.ts:12 skips the token check."),
          { text: "VERDICT: APPROVE\nThe token check is fixed." },
        ],
        fixes: [{ text: "Fixed the token check." }, { text: "Pushed once and reported." }],
      },
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const reactor = yield* PullRequestReviewLoopService.make;
        const sourceId = ThreadId.make("thread:loop:approved");
        const loop = yield* startLoop(sourceId);
        assert.deepEqual(
          (yield* orchestrator.getThreadShell(sourceId))?.pendingBackgroundTasks?.map(
            (task) => task.kind,
          ),
          ["monitor"],
        );

        yield* awaitTurn(loop.reviewThreadId, loop, reviewing(1));
        yield* stepRepeatedly(reactor, loop.reviewThreadId);
        assert.deepEqual(yield* phaseOf(sourceId), fixing(1));
        const delivered = yield* loopMessages(sourceId);
        assert.lengthOf(delivered, 1);
        assert.strictEqual(
          delivered[0]!.split("\n")[0],
          "**Review 1 of 3** from Cursor · composer-1 on #42: changes. The reviewer did not tag its findings with ids.",
        );
        assert.include(delivered[0], "src/login.ts:12 skips the token check.");

        yield* awaitTurn(sourceId, loop, fixing(1));
        yield* stepRepeatedly(reactor, sourceId);
        assert.deepEqual(yield* phaseOf(sourceId), reviewing(2));
        const requests = yield* loopMessages(loop.reviewThreadId);
        assert.lengthOf(requests, 2);
        assert.include(requests[1], "> Fixed the token check.");

        yield* awaitTurn(loop.reviewThreadId, loop, reviewing(2));
        yield* stepRepeatedly(reactor, loop.reviewThreadId);
        const phase = yield* phaseOf(sourceId);
        assert.deepInclude(phase, { status: "ended", reason: "approved", reviews: 2, budget: 3 });
        const told = yield* loopMessages(sourceId);
        assert.lengthOf(told, 2);
        assert.isTrue(told[1]!.startsWith("**Review loop approved.** Review 2 of 3"));
        assert.isUndefined(reviewerMarker((yield* linkOf(loop.reviewThreadId))!));

        yield* awaitTurn(sourceId, loop, phase!);
        yield* stepRepeatedly(reactor, sourceId);
        assert.lengthOf(yield* loopMessages(sourceId), 2);
        assert.lengthOf(yield* loopMessages(loop.reviewThreadId), 2);
        const shell = yield* orchestrator.getThreadShell(sourceId);
        assert.equal(shell?.status, "completed");
        assert.deepEqual(shell?.pendingBackgroundTasks ?? [], []);
      }),
    ),
  { timeout: 60_000 },
);

it.live(
  "the event tail drives a loop to its budget: three reviews, two fixes, then the user",
  () =>
    runWith(
      {
        reviews: [
          changes("S1 [should] src/login.ts:12 skips the token check."),
          { text: "Two things look off, but I am not sure." },
          changes("S3 [should] src/login.ts:30 drops the retry."),
        ],
        fixes: [{ text: "Fixed one." }, { text: "Fixed two." }, { text: "Finding three remains." }],
      },
      Effect.gen(function* () {
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const sink = yield* EventSink.EventSinkV2;
        // The live tail starts where it subscribes. This one replays from the first event, so the
        // test never depends on when the tail's fiber gets to subscribe.
        const reactor = yield* PullRequestReviewLoopService.make.pipe(
          Effect.provideService(ThreadManagementService.ThreadManagementService, {
            ...threads,
            streamDomainEvents: threads.streamStoredEvents.pipe(
              Stream.map((stored) => stored.event),
            ),
          }),
        );
        yield* reactor.start();
        const sourceId = ThreadId.make("thread:loop:cap");
        const loop = yield* startLoop(sourceId);

        yield* sink.stream({ threadId: sourceId, eventType: "thread.pull-request-synced" }).pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "thread.pull-request-synced" &&
              event.payload.pullRequests?.some(
                (link) =>
                  link.reviewLoop?.role === "author" && link.reviewLoop.phase.status === "ended",
              ) === true,
          ),
          Stream.runHead,
        );
        const phase = yield* phaseOf(sourceId);
        assert.deepInclude(phase, {
          status: "ended",
          reason: "budget_ended",
          reviews: 3,
          budget: 3,
        });
        yield* awaitTurn(sourceId, loop, phase!);
        yield* reactor.sweep;

        const requests = yield* loopMessages(loop.reviewThreadId);
        assert.deepEqual(
          requests.map((text) => text.split("\n")[0]),
          [1, 2, 3].map(
            (round) =>
              `T3 Code review loop: review ${round} of 3 for pull request #42 (https://github.com/pingdotgg/t3code/pull/42).`,
          ),
        );
        const told = yield* loopMessages(sourceId);
        assert.deepEqual(
          told.map((text) => text.split("\n")[0]),
          [
            "**Review 1 of 3** from Cursor · composer-1 on #42: changes. Open: S1 should.",
            "**Review 2 of 3** from Cursor · composer-1 on #42: changes. The reviewer gave no verdict line, so T3 Code treats this review as changes. The reviewer did not tag its findings with ids.",
            "**Review loop needs you.** Review 3 of 3 from Cursor · composer-1 on #42 still has open findings: S3 should. The loop is out of reviews. Budget end is not approval.",
          ],
        );
        assert.isUndefined(reviewerMarker((yield* linkOf(loop.reviewThreadId))!));
      }),
    ),
  { timeout: 60_000 },
);

it.live("a reactor built after a review ended delivers it once from its first sweep", () =>
  runWith(
    { reviews: [changes("Finding one.")], fixes: [] },
    Effect.gen(function* () {
      const sourceId = ThreadId.make("thread:loop:restart");
      const loop = yield* startLoop(sourceId);
      yield* awaitTurn(loop.reviewThreadId, loop, reviewing(1));

      const reactor = yield* PullRequestReviewLoopService.make;
      yield* reactor.sweep;
      yield* reactor.sweep;
      assert.deepEqual(yield* phaseOf(sourceId), fixing(1));
      assert.lengthOf(yield* loopMessages(sourceId), 1);
    }),
  ),
);

it.live("a failed review ends the loop and tells the source thread why", () =>
  runWith(
    { reviews: [{ text: "The provider hit its usage limit.", status: "failed" }], fixes: [] },
    Effect.gen(function* () {
      const reactor = yield* PullRequestReviewLoopService.make;
      const sourceId = ThreadId.make("thread:loop:review-failed");
      const loop = yield* startLoop(sourceId);
      yield* awaitTurn(loop.reviewThreadId, loop, reviewing(1));
      yield* reactor.advanceThread(loop.reviewThreadId);

      assert.deepInclude(yield* phaseOf(sourceId), {
        status: "ended",
        reason: "review_failed",
        reviews: 0,
        detail: "The provider hit its usage limit",
      });
      const told = yield* loopMessages(sourceId);
      assert.lengthOf(told, 1);
      assert.strictEqual(
        told[0]!.split("\n")[0],
        "**Review loop stopped.** Review 1 of 3 on #42 failed: The provider hit its usage limit.",
      );
      assert.isUndefined(reviewerMarker((yield* linkOf(loop.reviewThreadId))!));
    }),
  ),
);

it.live("a stopped fix ends the loop quietly", () =>
  runWith(
    {
      reviews: [changes("Finding one.")],
      fixes: [{ text: "Stopped halfway.", status: "interrupted" }],
    },
    Effect.gen(function* () {
      const reactor = yield* PullRequestReviewLoopService.make;
      const sourceId = ThreadId.make("thread:loop:fix-stopped");
      const loop = yield* startLoop(sourceId);
      yield* awaitTurn(loop.reviewThreadId, loop, reviewing(1));
      yield* reactor.advanceThread(loop.reviewThreadId);
      yield* awaitTurn(sourceId, loop, fixing(1));
      yield* reactor.advanceThread(sourceId);

      assert.deepInclude(yield* phaseOf(sourceId), {
        status: "ended",
        reason: "author_stopped",
        reviews: 1,
      });
      assert.lengthOf(yield* loopMessages(sourceId), 1);
      assert.lengthOf(yield* loopMessages(loop.reviewThreadId), 1);
    }),
  ),
);

it.live("cancelling the queued review bubble ends the loop quietly", () =>
  Effect.gen(function* () {
    const busy = yield* Deferred.make<void>();
    yield* runWith(
      {
        reviews: [changes("Finding one.")],
        fixes: [{ text: "Updated the docs.", until: busy }],
      },
      Effect.gen(function* () {
        const reactor = yield* PullRequestReviewLoopService.make;
        const sourceId = ThreadId.make("thread:loop:delivery-cancelled");
        const loop = yield* startLoop(sourceId);
        yield* awaitTurn(loop.reviewThreadId, loop, reviewing(1));
        yield* dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("user-turn"),
          threadId: sourceId,
          messageId: MessageId.make("message:user-turn"),
          text: "Update the docs while the review runs.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* reactor.advanceThread(loop.reviewThreadId);
        const deliveryId = IdAllocator.derive.reviewLoopMessage({
          loopId: loop.id,
          phase: fixing(1),
        });
        const delivery = (yield* threadOf(sourceId)).runs.find(
          (run) => run.userMessageId === deliveryId,
        );
        assert.equal(delivery?.status, "queued");
        yield* dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("cancel-delivery"),
          threadId: sourceId,
          runId: delivery!.id,
        });
        yield* Deferred.succeed(busy, undefined);
        yield* awaitTurn(sourceId, loop, fixing(1));
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.stream({ threadId: sourceId, eventType: "run.updated" }).pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "run.updated" &&
              event.payload.userMessageId === MessageId.make("message:user-turn") &&
              event.payload.status === "completed",
          ),
          Stream.runHead,
        );
        yield* reactor.advanceThread(sourceId);

        assert.deepInclude(yield* phaseOf(sourceId), {
          status: "ended",
          reason: "author_stopped",
          reviews: 1,
        });
        assert.lengthOf(yield* loopMessages(loop.reviewThreadId), 1);
      }),
    );
  }),
);

it.live("the reviewer's provider turned off before a ping ends the loop and says so", () =>
  runWith(
    { reviews: [changes("Finding one.")], fixes: [{ text: "Fixed one." }] },
    Effect.gen(function* () {
      const reactor = yield* PullRequestReviewLoopService.make;
      const sourceId = ThreadId.make("thread:loop:reviewer-off");
      const loop = yield* startLoop(sourceId, { projectId: reviewerOffProjectId });
      yield* awaitTurn(loop.reviewThreadId, loop, reviewing(1));
      yield* reactor.advanceThread(loop.reviewThreadId);
      yield* awaitTurn(sourceId, loop, fixing(1));
      yield* reactor.advanceThread(sourceId);

      assert.deepInclude(yield* phaseOf(sourceId), {
        status: "ended",
        reason: "review_failed",
        reviews: 1,
        detail: "the reviewer's provider is off for this project",
      });
      const told = yield* loopMessages(sourceId);
      assert.lengthOf(told, 2);
      assert.isTrue(
        told[1]!.startsWith(
          "**Review loop stopped.** Review 2 of 3 on #42 failed: the reviewer's provider is off for this project.",
        ),
      );
      assert.lengthOf(yield* loopMessages(loop.reviewThreadId), 1);
    }),
  ),
);

it.live("the source thread's provider turned off refuses review 1 and fails fix 1", () =>
  runWith(
    { reviews: [changes("Finding one.")], fixes: [] },
    Effect.gen(function* () {
      const reactor = yield* PullRequestReviewLoopService.make;
      const sourceId = ThreadId.make("thread:loop:author-off");
      const loop = yield* startLoop(sourceId, { projectId: authorOffProjectId });
      yield* awaitTurn(loop.reviewThreadId, loop, reviewing(1));
      yield* reactor.advanceThread(loop.reviewThreadId);

      assert.deepInclude(yield* phaseOf(sourceId), {
        status: "ended",
        reason: "author_failed",
        reviews: 1,
        detail: "this thread's provider is off for this project",
      });
      assert.lengthOf(yield* loopMessages(sourceId), 0);
      assert.isUndefined(reviewerMarker((yield* linkOf(loop.reviewThreadId))!));
    }),
  ),
);

it.live("a step whose id an earlier rejection burned ends the loop as aborted", () =>
  runWith(
    { reviews: [changes("Finding one.")], fixes: [] },
    Effect.gen(function* () {
      const reactor = yield* PullRequestReviewLoopService.make;
      const sourceId = ThreadId.make("thread:loop:burned");
      const loop = yield* startLoop(sourceId);
      yield* awaitTurn(loop.reviewThreadId, loop, reviewing(1));
      const stale = yield* dispatch({
        type: "thread.pull-request-review-loop.advance",
        commandId: IdAllocator.derive.reviewLoopTransition({
          loopId: loop.id,
          from: reviewing(1),
          to: fixing(1),
        }),
        threadId: sourceId,
        ...pullRequest,
        loopId: loop.id,
        reviewThreadId: loop.reviewThreadId,
        from: fixing(1),
        to: reviewing(2),
      }).pipe(Effect.flip);
      assert.equal(stale._tag, "OrchestratorDispatchError");

      yield* reactor.advanceThread(loop.reviewThreadId);
      assert.deepInclude(yield* phaseOf(sourceId), {
        status: "ended",
        reason: "aborted",
        reviews: 0,
      });
      assert.lengthOf(yield* loopMessages(sourceId), 0);
      assert.isUndefined(reviewerMarker((yield* linkOf(loop.reviewThreadId))!));
    }),
  ),
);

it.live("a second loop on the same pull request starts cleanly after the first ended", () =>
  runWith(
    { reviews: [], fixes: [] },
    Effect.gen(function* () {
      const reactor = yield* PullRequestReviewLoopService.make;
      const sourceId = ThreadId.make("thread:loop:second");
      const first = yield* startLoop(sourceId, { name: "second:first" });
      yield* dispatch({
        type: "thread.pull-request.review-loop",
        commandId: CommandId.make("review-loop:second:stop"),
        threadId: sourceId,
        ...pullRequest,
        createdBy: "user",
        creationSource: "web",
        request: { type: "stop", loopId: first.id },
      });
      yield* reactor.advanceThread(sourceId);
      assert.isUndefined(reviewerMarker((yield* linkOf(first.reviewThreadId))!));

      yield* dispatch({
        type: "thread.pull-request.review-loop",
        commandId: CommandId.make("review-loop:second:again"),
        threadId: sourceId,
        ...pullRequest,
        createdBy: "user",
        creationSource: "web",
        request: { type: "start", reviewer: reviewerModel, budget: 3 },
      });
      const second = liveAuthorLoop((yield* linkOf(sourceId))!);
      assert.isDefined(second);
      assert.notEqual(second!.id, first.id);
      assert.notEqual(second!.reviewThreadId, first.reviewThreadId);
      assert.deepEqual(second!.phase, reviewing(1));
      assert.equal(reviewerMarker((yield* linkOf(second!.reviewThreadId))!)?.id, second!.id);
    }),
  ),
);
