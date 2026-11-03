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
  ReviewLoopFindingId,
  type ReviewLoopFindingRef,
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
  readonly brief?: Reply;
  readonly reviews: Array<Reply>;
  readonly fixes: Array<Reply>;
}

const BRIEF = [
  "Base: 4f1c2ab",
  "Intent: Keep the token check when one refresh fails.",
  "Out of scope: none.",
  "Checks: vp test run src/login.test.ts passed.",
  "Diff: 1 file changed, 4 insertions(+)",
].join("\n");

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
            scriptedAdapter(authorModel, "codex", [
              script.brief ?? { text: BRIEF },
              ...script.fixes,
            ]),
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

const scoping = { status: "scoping", budget: 3 } as const;
const reviewing = (round: 1 | 2 | 3) => ({ status: "reviewing", budget: 3, round }) as const;
const fixing = (round: 1 | 2, open: ReadonlyArray<ReviewLoopFindingRef> = []) =>
  ({ status: "fixing", budget: 3, round, open }) as const;
const should = (id: string): ReviewLoopFindingRef => ({
  id: ReviewLoopFindingId.make(id),
  severity: "should",
});
const changes = (finding: string): Reply => ({ text: `VERDICT: CHANGES\n${finding}` });
const firstLines = (texts: ReadonlyArray<string>) => texts.map((text) => text.split("\n")[0]);

const BRIEF_REQUEST =
  "**Review loop started** for #42. Composer 1 reviews this change, up to 3 reviews.";

const passBrief = (
  reactor: PullRequestReviewLoopService.PullRequestReviewLoopService["Service"],
  sourceId: ThreadId,
  loop: { readonly id: ReviewLoopId },
) =>
  Effect.gen(function* () {
    yield* awaitTurn(sourceId, loop, scoping);
    yield* reactor.advanceThread(sourceId);
  });

const replayingReactor = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const reactor = yield* PullRequestReviewLoopService.make.pipe(
    Effect.provideService(ThreadManagementService.ThreadManagementService, {
      ...threads,
      streamDomainEvents: threads.streamStoredEvents.pipe(Stream.map((stored) => stored.event)),
    }),
  );
  yield* reactor.start();
  return reactor;
});

const recordedPhases = (sourceId: ThreadId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const phases = yield* sink
      .stream({ threadId: sourceId, eventType: "thread.pull-request-synced" })
      .pipe(
        Stream.map(({ event }) => {
          const link =
            event.type === "thread.pull-request-synced"
              ? event.payload.pullRequests?.find(
                  (candidate) => candidate.number === pullRequest.number,
                )
              : undefined;
          return link?.reviewLoop?.role === "author" ? link.reviewLoop.phase : null;
        }),
        Stream.filter((phase) => phase !== null),
        Stream.takeUntil((phase) => phase.status === "ended"),
        Stream.runCollect,
      );
    return phases
      .map((phase) =>
        phase.status === "ended"
          ? `ended ${phase.reason} after ${phase.reviews} of ${phase.budget}`
          : phase.status === "scoping"
            ? `scoping/${phase.budget}`
            : `${phase.status} ${phase.round}/${phase.budget}`,
      )
      .filter((phase, index, all) => phase !== all[index - 1]);
  });

it.live("the brief goes to the reviewer, and an approval at review 1 frees both threads", () =>
  runWith(
    {
      reviews: [
        {
          text: "VERDICT: APPROVE\nS1 [nit] src/login.ts:40 rename retryOnce. Fix: call it refreshWithRetry.",
        },
      ],
      fixes: [{ text: "Declined S1 as a follow-up. Pushed once." }],
    },
    Effect.gen(function* () {
      const reactor = yield* PullRequestReviewLoopService.make;
      const sourceId = ThreadId.make("thread:loop:approved-at-1");
      const loop = yield* startLoop(sourceId);
      assert.deepEqual(loop.phase, scoping);
      assert.deepEqual(firstLines(yield* loopMessages(sourceId)), [BRIEF_REQUEST]);
      assert.lengthOf(yield* loopMessages(loop.reviewThreadId), 0);

      yield* passBrief(reactor, sourceId, loop);
      assert.deepEqual(yield* phaseOf(sourceId), reviewing(1));
      const [request] = yield* loopMessages(loop.reviewThreadId);
      assert.strictEqual(
        request!.split("\n")[0],
        "T3 Code review loop: review 1 of 3 for pull request #42 (https://github.com/pingdotgg/t3code/pull/42).",
      );
      assert.include(request, "The author's brief:\n\n> Base: 4f1c2ab");

      yield* awaitTurn(loop.reviewThreadId, loop, reviewing(1));
      yield* reactor.advanceThread(loop.reviewThreadId);
      const phase = yield* phaseOf(sourceId);
      assert.deepInclude(phase, { status: "ended", reason: "approved", reviews: 1, budget: 3 });
      const told = yield* loopMessages(sourceId);
      assert.deepEqual(firstLines(told), [
        BRIEF_REQUEST,
        "**Review loop approved.** Review 1 of 3 from Cursor · composer-1 on #42 approved this change. Open nits: S1.",
      ]);
      assert.include(
        told[1],
        "`Reviewed with sol-loop: 1 round with Composer 1. Verdict: approved`",
      );
      assert.isUndefined(reviewerMarker((yield* linkOf(loop.reviewThreadId))!));
      assert.lengthOf(yield* loopMessages(loop.reviewThreadId), 1);
    }),
  ),
);

it.live(
  "a loop approved at review 2 posts each step once and then frees both threads",
  () =>
    runWith(
      {
        reviews: [
          changes("S1 [should] src/login.ts:12 skips the token check. Fix: check it."),
          { text: "VERDICT: APPROVE\nS1 resolved" },
        ],
        fixes: [
          { text: "fixed: S1 src/login.ts:12 checks the token.\nChanged: commit 9e0d1f7." },
          { text: "Pushed once and reported." },
        ],
      },
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const reactor = yield* PullRequestReviewLoopService.make;
        const sourceId = ThreadId.make("thread:loop:approved");
        const loop = yield* startLoop(sourceId);
        yield* passBrief(reactor, sourceId, loop);
        assert.deepEqual(
          (yield* orchestrator.getThreadShell(sourceId))?.pendingBackgroundTasks?.map(
            (task) => task.description,
          ),
          ["Waiting for review 1 of 3 on pull request #42"],
        );

        yield* awaitTurn(loop.reviewThreadId, loop, reviewing(1));
        yield* stepRepeatedly(reactor, loop.reviewThreadId);
        assert.deepEqual(yield* phaseOf(sourceId), fixing(1, [should("S1")]));
        const delivered = yield* loopMessages(sourceId);
        assert.deepEqual(firstLines(delivered), [
          BRIEF_REQUEST,
          "**Review 1 of 3** from Cursor · composer-1 on #42: changes. Open: S1 should.",
        ]);
        assert.include(delivered[1], "Commit locally. Do not push.");

        yield* awaitTurn(sourceId, loop, fixing(1));
        yield* stepRepeatedly(reactor, sourceId);
        assert.deepEqual(yield* phaseOf(sourceId), reviewing(2));
        const requests = yield* loopMessages(loop.reviewThreadId);
        assert.lengthOf(requests, 2);
        assert.include(requests[1], "> fixed: S1 src/login.ts:12 checks the token.");
        assert.include(
          requests[1],
          "Open from your last review: S1 [should]. Number new findings from S2.",
        );

        yield* awaitTurn(loop.reviewThreadId, loop, reviewing(2));
        yield* stepRepeatedly(reactor, loop.reviewThreadId);
        const phase = yield* phaseOf(sourceId);
        assert.deepInclude(phase, { status: "ended", reason: "approved", reviews: 2, budget: 3 });
        const told = yield* loopMessages(sourceId);
        assert.lengthOf(told, 3);
        assert.isTrue(told[2]!.startsWith("**Review loop approved.** Review 2 of 3"));
        assert.isUndefined(reviewerMarker((yield* linkOf(loop.reviewThreadId))!));

        yield* awaitTurn(sourceId, loop, phase!);
        yield* stepRepeatedly(reactor, sourceId);
        assert.lengthOf(yield* loopMessages(sourceId), 3);
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
        fixes: [{ text: "Fixed one." }, { text: "Fixed two." }, { text: "S3 stays open." }],
      },
      Effect.gen(function* () {
        const reactor = yield* replayingReactor;
        const sourceId = ThreadId.make("thread:loop:budget");
        const loop = yield* startLoop(sourceId);

        assert.deepEqual(yield* recordedPhases(sourceId), [
          "scoping/3",
          "reviewing 1/3",
          "fixing 1/3",
          "reviewing 2/3",
          "fixing 2/3",
          "reviewing 3/3",
          "ended budget_ended after 3 of 3",
        ]);
        const phase = yield* phaseOf(sourceId);
        yield* awaitTurn(sourceId, loop, phase!);
        yield* reactor.sweep;

        assert.deepEqual(
          firstLines(yield* loopMessages(loop.reviewThreadId)),
          [1, 2, 3].map(
            (round) =>
              `T3 Code review loop: review ${round} of 3 for pull request #42 (https://github.com/pingdotgg/t3code/pull/42).`,
          ),
        );
        assert.deepEqual(firstLines(yield* loopMessages(sourceId)), [
          BRIEF_REQUEST,
          "**Review 1 of 3** from Cursor · composer-1 on #42: changes. Open: S1 should.",
          "**Review 2 of 3** from Cursor · composer-1 on #42: changes. The reviewer gave no verdict line, so T3 Code treats this review as changes. The reviewer did not tag its findings with ids.",
          "**Review loop needs you.** Review 3 of 3 from Cursor · composer-1 on #42 still has open findings: S3 should. The loop is out of reviews. Budget end is not approval.",
        ]);
        assert.isUndefined(reviewerMarker((yield* linkOf(loop.reviewThreadId))!));
      }),
    ),
  { timeout: 60_000 },
);

it.live(
  "a concurrency blocker at review 3 extends the loop, and review 4 of 5 approves",
  () =>
    runWith(
      {
        reviews: [
          changes("S1 [should] src/session.ts:12 drops the token."),
          changes("S2 [should] src/session.ts:20 skips the retry."),
          changes(
            "S7 [blocker] [concurrency] src/session.ts:31 two tabs refresh at once. Fix: compare the token version.",
          ),
          { text: "VERDICT: APPROVE\nS7 resolved" },
        ],
        fixes: [
          { text: "fixed: S1" },
          { text: "fixed: S2" },
          { text: "fixed: S7 the write compares the token version." },
          { text: "Pushed once and reported." },
        ],
      },
      Effect.gen(function* () {
        const reactor = yield* replayingReactor;
        const sourceId = ThreadId.make("thread:loop:extension");
        const loop = yield* startLoop(sourceId);

        assert.deepEqual(yield* recordedPhases(sourceId), [
          "scoping/3",
          "reviewing 1/3",
          "fixing 1/3",
          "reviewing 2/3",
          "fixing 2/3",
          "reviewing 3/3",
          "fixing 3/5",
          "reviewing 4/5",
          "ended approved after 4 of 5",
        ]);
        const phase = yield* phaseOf(sourceId);
        yield* awaitTurn(sourceId, loop, phase!);
        yield* reactor.sweep;

        assert.deepEqual(
          firstLines(yield* loopMessages(loop.reviewThreadId)).map((line) =>
            line?.replace(
              " for pull request #42 (https://github.com/pingdotgg/t3code/pull/42).",
              "",
            ),
          ),
          [
            "T3 Code review loop: review 1 of 3",
            "T3 Code review loop: review 2 of 3",
            "T3 Code review loop: review 3 of 3",
            "T3 Code review loop: review 4 of 5",
          ],
        );
        const told = yield* loopMessages(sourceId);
        assert.include(
          firstLines(told),
          "**Review 3 of 5** from Cursor · composer-1 on #42: changes. Open: S7 blocker (concurrency). The loop now allows up to 5 reviews, because S7 is a concurrency finding.",
        );
        assert.include(
          told.at(-1),
          "`Reviewed with sol-loop: 4 rounds with Composer 1. Verdict: approved`",
        );
      }),
    ),
  { timeout: 60_000 },
);

it.live(
  "a dispute in fix 2 ends the loop as stuck before review 3",
  () =>
    runWith(
      {
        reviews: [
          changes("S2 [should] src/cache.ts:8 the cache is shared across requests."),
          changes("S2 [should] still open: src/server.ts:44 reuses the instance."),
        ],
        fixes: [
          { text: "disagree: S2 the cache is created per request in src/cache.ts:8." },
          { text: "disagree: S2 src/server.ts:44 builds a new one per request.\nLOOP: STUCK S2" },
          { text: "Both sides of S2 are above. Not pushed." },
        ],
      },
      Effect.gen(function* () {
        const reactor = yield* replayingReactor;
        const sourceId = ThreadId.make("thread:loop:stuck");
        const loop = yield* startLoop(sourceId);

        assert.deepEqual(yield* recordedPhases(sourceId), [
          "scoping/3",
          "reviewing 1/3",
          "fixing 1/3",
          "reviewing 2/3",
          "fixing 2/3",
          "ended stuck after 2 of 3",
        ]);
        const phase = yield* phaseOf(sourceId);
        assert.deepInclude(phase, { detail: "S2" });
        yield* awaitTurn(sourceId, loop, phase!);
        yield* reactor.sweep;

        assert.lengthOf(yield* loopMessages(loop.reviewThreadId), 2);
        assert.strictEqual(
          firstLines(yield* loopMessages(sourceId)).at(-1),
          "**Review loop needs you.** You still dispute S2 after two replies, and the reviewer keeps it open.",
        );
        assert.isUndefined(reviewerMarker((yield* linkOf(loop.reviewThreadId))!));
      }),
    ),
  { timeout: 60_000 },
);

it.live(
  "a reactor built after the brief ended steps once, from its first sweep, into review 1",
  () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      yield* runWith(
        { reviews: [{ text: "VERDICT: APPROVE", until: reading }], fixes: [] },
        Effect.gen(function* () {
          const sourceId = ThreadId.make("thread:loop:restart");
          const loop = yield* startLoop(sourceId);
          yield* awaitTurn(sourceId, loop, scoping);

          const reactor = yield* PullRequestReviewLoopService.make;
          yield* reactor.sweep;
          yield* reactor.sweep;
          assert.deepEqual(yield* phaseOf(sourceId), reviewing(1));
          assert.lengthOf(yield* loopMessages(loop.reviewThreadId), 1);
          yield* Deferred.succeed(reading, undefined);
        }),
      );
    }),
);

it.live("settling the source while the reviewer works ends the loop as stopped", () =>
  Effect.gen(function* () {
    const reviewing1 = yield* Deferred.make<void>();
    yield* runWith(
      { reviews: [{ ...changes("S1 [should] src/login.ts:12 x."), until: reviewing1 }], fixes: [] },
      Effect.gen(function* () {
        const reactor = yield* PullRequestReviewLoopService.make;
        const sourceId = ThreadId.make("thread:loop:settled");
        const loop = yield* startLoop(sourceId);
        yield* passBrief(reactor, sourceId, loop);
        yield* dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle-source"),
          threadId: sourceId,
        });

        assert.deepInclude(yield* phaseOf(sourceId), {
          status: "ended",
          reason: "stopped",
          reviews: 0,
          budget: 3,
        });
        yield* reactor.advanceThread(sourceId);
        assert.isUndefined(reviewerMarker((yield* linkOf(loop.reviewThreadId))!));
        yield* Deferred.succeed(reviewing1, undefined);
        yield* awaitTurn(loop.reviewThreadId, loop, reviewing(1));
        yield* reactor.advanceThread(loop.reviewThreadId);
        assert.deepEqual(firstLines(yield* loopMessages(sourceId)), [BRIEF_REQUEST]);
      }),
    );
  }),
);

it.live("a failed review ends the loop and tells the source thread why", () =>
  runWith(
    { reviews: [{ text: "The provider hit its usage limit.", status: "failed" }], fixes: [] },
    Effect.gen(function* () {
      const reactor = yield* PullRequestReviewLoopService.make;
      const sourceId = ThreadId.make("thread:loop:review-failed");
      const loop = yield* startLoop(sourceId);
      yield* passBrief(reactor, sourceId, loop);
      yield* awaitTurn(loop.reviewThreadId, loop, reviewing(1));
      yield* reactor.advanceThread(loop.reviewThreadId);

      assert.deepInclude(yield* phaseOf(sourceId), {
        status: "ended",
        reason: "review_failed",
        reviews: 0,
        budget: 3,
        detail: "The provider hit its usage limit",
      });
      assert.deepEqual(firstLines(yield* loopMessages(sourceId)), [
        BRIEF_REQUEST,
        "**Review loop stopped.** Review 1 of 3 on #42 failed: The provider hit its usage limit.",
      ]);
      assert.isUndefined(reviewerMarker((yield* linkOf(loop.reviewThreadId))!));
    }),
  ),
);

it.live("a failed brief ends the loop quietly before any review", () =>
  runWith(
    {
      brief: { text: "The provider hit its usage limit.", status: "failed" },
      reviews: [],
      fixes: [],
    },
    Effect.gen(function* () {
      const reactor = yield* PullRequestReviewLoopService.make;
      const sourceId = ThreadId.make("thread:loop:brief-failed");
      const loop = yield* startLoop(sourceId);
      yield* passBrief(reactor, sourceId, loop);

      assert.deepInclude(yield* phaseOf(sourceId), {
        status: "ended",
        reason: "author_failed",
        reviews: 0,
        budget: 3,
        detail: "The provider hit its usage limit",
      });
      assert.deepEqual(firstLines(yield* loopMessages(sourceId)), [BRIEF_REQUEST]);
      assert.lengthOf(yield* loopMessages(loop.reviewThreadId), 0);
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
      yield* passBrief(reactor, sourceId, loop);
      yield* awaitTurn(loop.reviewThreadId, loop, reviewing(1));
      yield* reactor.advanceThread(loop.reviewThreadId);
      yield* awaitTurn(sourceId, loop, fixing(1));
      yield* reactor.advanceThread(sourceId);

      assert.deepInclude(yield* phaseOf(sourceId), {
        status: "ended",
        reason: "author_stopped",
        reviews: 1,
        budget: 3,
      });
      assert.lengthOf(yield* loopMessages(sourceId), 2);
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
        yield* passBrief(reactor, sourceId, loop);
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

it.live("the reviewer's provider turned off after the brief ends the loop and says so", () =>
  runWith(
    { reviews: [], fixes: [] },
    Effect.gen(function* () {
      const reactor = yield* PullRequestReviewLoopService.make;
      const sourceId = ThreadId.make("thread:loop:reviewer-off");
      const loop = yield* startLoop(sourceId, { projectId: reviewerOffProjectId });
      yield* passBrief(reactor, sourceId, loop);

      assert.deepInclude(yield* phaseOf(sourceId), {
        status: "ended",
        reason: "review_failed",
        reviews: 0,
        budget: 3,
        detail: "the reviewer's provider is off for this project",
      });
      assert.deepEqual(firstLines(yield* loopMessages(sourceId)), [
        BRIEF_REQUEST,
        "**Review loop stopped.** Review 1 of 3 on #42 failed: the reviewer's provider is off for this project.",
      ]);
      assert.lengthOf(yield* loopMessages(loop.reviewThreadId), 0);
      assert.isUndefined(reviewerMarker((yield* linkOf(loop.reviewThreadId))!));
    }),
  ),
);

it.live("the source thread's provider turned off fails fix 1 without a note", () =>
  runWith(
    { reviews: [changes("S1 [should] src/login.ts:12 skips the token check.")], fixes: [] },
    Effect.gen(function* () {
      const reactor = yield* PullRequestReviewLoopService.make;
      const sourceId = ThreadId.make("thread:loop:author-off");
      const loop = yield* startLoop(sourceId, { projectId: authorOffProjectId });
      yield* passBrief(reactor, sourceId, loop);
      yield* awaitTurn(loop.reviewThreadId, loop, reviewing(1));
      yield* reactor.advanceThread(loop.reviewThreadId);

      assert.deepInclude(yield* phaseOf(sourceId), {
        status: "ended",
        reason: "author_failed",
        reviews: 1,
        budget: 3,
        detail: "this thread's provider is off for this project",
      });
      assert.deepEqual(firstLines(yield* loopMessages(sourceId)), [BRIEF_REQUEST]);
      assert.isUndefined(reviewerMarker((yield* linkOf(loop.reviewThreadId))!));
    }),
  ),
);

it.live("an approval that cannot reach the source says so on the record", () =>
  runWith(
    { reviews: [{ text: "VERDICT: APPROVE" }], fixes: [] },
    Effect.gen(function* () {
      const reactor = yield* PullRequestReviewLoopService.make;
      const sourceId = ThreadId.make("thread:loop:approved-author-off");
      const loop = yield* startLoop(sourceId, { projectId: authorOffProjectId });
      yield* passBrief(reactor, sourceId, loop);
      yield* awaitTurn(loop.reviewThreadId, loop, reviewing(1));
      yield* reactor.advanceThread(loop.reviewThreadId);

      assert.deepInclude(yield* phaseOf(sourceId), {
        status: "ended",
        reason: "approved",
        reviews: 1,
        budget: 3,
        detail: "this thread's provider is off",
      });
      assert.deepEqual(firstLines(yield* loopMessages(sourceId)), [BRIEF_REQUEST]);
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
      yield* passBrief(reactor, sourceId, loop);
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
        budget: 3,
      });
      assert.deepEqual(firstLines(yield* loopMessages(sourceId)), [BRIEF_REQUEST]);
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
      yield* awaitTurn(sourceId, first, scoping);

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
      assert.deepEqual(second!.phase, scoping);
      assert.equal(reviewerMarker((yield* linkOf(second!.reviewThreadId))!)?.id, second!.id);
    }),
  ),
);
