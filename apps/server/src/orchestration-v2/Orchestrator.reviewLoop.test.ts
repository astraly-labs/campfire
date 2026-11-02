import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ReviewLoopLivePhase,
  type ReviewLoopPhase,
  ThreadId,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { liveAuthorLoop, reviewerMarker } from "@t3tools/shared/pullRequestReviewLoop";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
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
const pullRequest = { host: "github.com", repository: "pingdotgg/t3code", number: 42 };
const pullRequestUrl = "https://github.com/pingdotgg/t3code/pull/42";

const adapter = (model: ModelSelection, driver: string) =>
  ({
    instanceId: model.instanceId,
    driver: ProviderDriverKind.make(driver),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Runs here never reach a provider"),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
// No effect worker: runs stay unstarted, so each test sees exactly what one command committed.
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "review-loop-commands" },
        ProviderAdapterRegistry.layerFromAdapters([
          adapter(authorModel, "codex"),
          adapter(reviewerModel, "cursor"),
        ]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
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
      },
    }),
  ),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provideMerge(ThreadCommandExecutor.layer),
);

type ClientCommand<Type extends OrchestrationV2Command["type"]> = Extract<
  OrchestrationV2Command,
  { readonly type: Type }
>;

const dispatch = (command: OrchestrationV2ServerCommand) =>
  Effect.flatMap(ThreadManagementService.ThreadManagementService, (threads) =>
    threads.dispatch(command),
  );

const refusal = (command: OrchestrationV2ServerCommand) =>
  dispatch(command).pipe(
    Effect.flip,
    Effect.map((error) => error._tag),
  );

const createThread = (threadId: ThreadId, options: { readonly projectId?: ProjectId } = {}) =>
  dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId: options.projectId ?? projectId,
    title: "Fix the login check",
    modelSelection: authorModel,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: "feature/login",
    worktreePath: "/workspace/login",
    createdBy: "user",
    creationSource: "web",
  });

const linkPullRequest = (threadId: ThreadId) =>
  dispatch({
    type: "thread.pull-request.link",
    commandId: CommandId.make(`link:${threadId}`),
    threadId,
    ...pullRequest,
    url: pullRequestUrl,
    source: "created",
  });

const createSource = (threadId: ThreadId, options: { readonly projectId?: ProjectId } = {}) =>
  Effect.andThen(createThread(threadId, options), linkPullRequest(threadId));

const syncSnapshot = (threadId: ThreadId, snapshot: Partial<ThreadPullRequestSnapshot>) =>
  dispatch({
    type: "thread.pull-request-link.sync",
    commandId: CommandId.make(`sync:${threadId}:${JSON.stringify(snapshot)}`),
    threadId,
    ...pullRequest,
    snapshot: {
      state: "open",
      title: "Fix the login check",
      headBranch: "feature/login",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-11-02T10:00:00.000Z",
      ...snapshot,
    },
    stack: null,
  });

const start = (
  threadId: ThreadId,
  name: string,
  request: Partial<
    Extract<ClientCommand<"thread.pull-request.review-loop">["request"], { type: "start" }>
  > = {},
): ClientCommand<"thread.pull-request.review-loop"> => ({
  type: "thread.pull-request.review-loop",
  commandId: CommandId.make(`review-loop:${name}`),
  threadId,
  ...pullRequest,
  createdBy: "user",
  creationSource: "web",
  request: { type: "start", reviewer: reviewerModel, prompt: "/review #42", ...request },
});

const stop = (
  threadId: ThreadId,
  name: string,
  loopId: ReturnType<typeof IdAllocator.derive.reviewLoop>,
): ClientCommand<"thread.pull-request.review-loop"> => ({
  type: "thread.pull-request.review-loop",
  commandId: CommandId.make(`review-loop:stop:${name}`),
  threadId,
  ...pullRequest,
  createdBy: "user",
  creationSource: "web",
  request: { type: "stop", loopId },
});

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

/** Starts a loop and returns its author record. */
const startLoop = (threadId: ThreadId, name: string) =>
  Effect.gen(function* () {
    yield* dispatch(start(threadId, name));
    const link = yield* linkOf(threadId);
    const loop = link === null ? undefined : liveAuthorLoop(link);
    assert.isDefined(loop);
    return loop!;
  });

const advance = (
  sourceId: ThreadId,
  loop: {
    readonly id: ReturnType<typeof IdAllocator.derive.reviewLoop>;
    readonly reviewThreadId: ThreadId;
  },
  from: ReviewLoopLivePhase,
  to: ReviewLoopPhase,
  post?: { readonly target: "source" | "review"; readonly text: string },
): OrchestrationV2ServerCommand => ({
  type: "thread.pull-request-review-loop.advance",
  commandId: IdAllocator.derive.reviewLoopTransition({ loopId: loop.id, from, to }),
  threadId: sourceId,
  ...pullRequest,
  loopId: loop.id,
  reviewThreadId: loop.reviewThreadId,
  from,
  to,
  ...(post === undefined
    ? {}
    : {
        post: {
          ...post,
          messageId: IdAllocator.derive.reviewLoopMessage({ loopId: loop.id, phase: to }),
        },
      }),
});

const release = (
  reviewThreadId: ThreadId,
  loopId: ReturnType<typeof IdAllocator.derive.reviewLoop>,
): OrchestrationV2ServerCommand => ({
  type: "thread.pull-request-review-loop.release",
  commandId: IdAllocator.derive.reviewLoopRelease({ loopId }),
  threadId: reviewThreadId,
  ...pullRequest,
  loopId,
});

const ended = (reason: "stopped" | "clean", reviews: 0 | 1 | 2 | 3): ReviewLoopPhase => ({
  status: "ended",
  reason,
  reviews,
  endedAt: "2026-11-02T10:00:00.000Z",
});

it.layer(layerTest)("review loop commands", (it) => {
  it.effect(
    "a start records the loop, creates the review thread, and sends review request 1 in one commit",
    () =>
      Effect.gen(function* () {
        const sourceId = ThreadId.make("thread:loop:start");
        yield* createSource(sourceId);
        const command = start(sourceId, "start");
        const result = yield* dispatch(command);

        const loop = liveAuthorLoop((yield* linkOf(sourceId))!);
        assert.deepInclude(loop, {
          role: "author",
          prompt: "/review #42",
          phase: { status: "reviewing", round: 1 },
        });
        const review = yield* threadOf(loop!.reviewThreadId);
        assert.deepInclude(review.thread, {
          kind: "review",
          reviewPullRequestNumber: 42,
          modelSelection: reviewerModel,
          runtimeMode: "approval-required",
          branch: "feature/login",
          worktreePath: "/workspace/login",
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: loop!.reviewThreadId,
          },
        });
        assert.deepEqual(reviewerMarker((yield* linkOf(loop!.reviewThreadId))!), {
          role: "reviewer",
          id: loop!.id,
          sourceThreadId: sourceId,
        });
        const request = review.messages.find((message) => message.role === "user");
        assert.deepInclude(request, {
          id: IdAllocator.derive.reviewLoopMessage({ loopId: loop!.id, phase: loop!.phase }),
          createdBy: "agent",
          creationSource: "server",
          senderThreadId: sourceId,
        });
        assert.isTrue(request!.text.startsWith("/review #42\n"));
        assert.notEqual(review.runs[0]?.status, "queued");

        const committed = result.storedEvents.map(({ event }) => `${event.type} ${event.threadId}`);
        assert.includeMembers(committed, [
          `thread.pull-request-synced ${sourceId}`,
          `thread.created ${loop!.reviewThreadId}`,
          `message.updated ${loop!.reviewThreadId}`,
        ]);

        const replay = yield* dispatch(command);
        assert.equal(replay.sequence, result.sequence);
        assert.lengthOf((yield* threadOf(loop!.reviewThreadId)).messages, 1);
        assert.deepEqual(liveAuthorLoop((yield* linkOf(sourceId))!), loop);
      }),
  );

  it.effect("a start links a pull request the thread has not linked", () =>
    Effect.gen(function* () {
      const sourceId = ThreadId.make("thread:loop:start-links");
      yield* createThread(sourceId);
      yield* dispatch(
        start(sourceId, "start-links", { link: { url: pullRequestUrl, source: "manual" } }),
      );

      const link = yield* linkOf(sourceId);
      assert.deepInclude(link, { url: pullRequestUrl, source: "manual" });
      assert.isDefined(liveAuthorLoop(link!));
    }),
  );

  it.effect("a start is refused for a thread that cannot own a loop", () =>
    Effect.gen(function* () {
      const running = ThreadId.make("thread:loop:refused-running");
      yield* createSource(running);
      const loop = yield* startLoop(running, "refused-running");
      assert.equal(
        yield* refusal(start(running, "refused-running-again")),
        "OrchestratorDispatchError",
      );
      assert.equal(
        yield* refusal(
          start(loop.reviewThreadId, "refused-reviewer", {
            link: { url: pullRequestUrl, source: "manual" },
          }),
        ),
        "OrchestratorDispatchError",
      );

      const archived = ThreadId.make("thread:loop:refused-archived");
      yield* createSource(archived);
      yield* dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive"),
        threadId: archived,
      });
      assert.equal(
        yield* refusal(start(archived, "refused-archived")),
        "OrchestratorDispatchError",
      );

      const settled = ThreadId.make("thread:loop:refused-settled");
      yield* createSource(settled);
      yield* dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle"),
        threadId: settled,
      });
      assert.equal(yield* refusal(start(settled, "refused-settled")), "OrchestratorDispatchError");

      const parent = ThreadId.make("thread:loop:refused-parent");
      yield* createThread(parent);
      yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("parent-turn"),
        threadId: parent,
        messageId: MessageId.make("message:parent-turn"),
        text: "Delegate the fix.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const parentRun = (yield* threadOf(parent)).runs[0]!;
      yield* dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate"),
        parentThreadId: parent,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: "Fix the login check.",
        modelSelection: authorModel,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const child = (yield* threadOf(parent)).subagents[0]!.childThreadId!;
      assert.equal(
        yield* refusal(
          start(child, "refused-subagent", { link: { url: pullRequestUrl, source: "manual" } }),
        ),
        "OrchestratorDispatchError",
      );
      assert.isNull(yield* linkOf(child));
    }),
  );

  it.effect("a start is refused unless the pull request is this thread's open one", () =>
    Effect.gen(function* () {
      const unlinked = ThreadId.make("thread:loop:refused-unlinked");
      yield* createThread(unlinked);
      assert.equal(
        yield* refusal(start(unlinked, "refused-unlinked")),
        "OrchestratorDispatchError",
      );

      for (const [name, snapshot] of [
        ["merged", { state: "merged" }],
        ["closed", { state: "closed" }],
        ["other-branch", { headBranch: "feature/other" }],
      ] as const) {
        const sourceId = ThreadId.make(`thread:loop:refused-${name}`);
        yield* createSource(sourceId);
        yield* syncSnapshot(sourceId, snapshot);
        assert.equal(
          yield* refusal(start(sourceId, `refused-${name}`)),
          "OrchestratorDispatchError",
          name,
        );
        assert.isUndefined((yield* linkOf(sourceId))?.reviewLoop, name);
      }

      // Clients are refused earlier, by the provider "off" check; this is the orchestrator's own guard.
      const unknownReviewer = ThreadId.make("thread:loop:refused-unknown-reviewer");
      yield* createSource(unknownReviewer);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const error = yield* orchestrator
        .dispatch(
          start(unknownReviewer, "refused-unknown-reviewer", {
            reviewer: { instanceId: ProviderInstanceId.make("missing"), model: "x" },
          }),
        )
        .pipe(Effect.flip);
      assert.equal(error._tag, "OrchestratorProviderAdapterError");
      assert.isUndefined((yield* linkOf(unknownReviewer))?.reviewLoop);
    }),
  );

  it.effect("a start is refused before the orchestrator when the reviewer's provider is off", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const sourceId = ThreadId.make("thread:loop:reviewer-off");
      yield* createSource(sourceId, { projectId: reviewerOffProjectId });
      const command = start(sourceId, "reviewer-off");

      assert.equal(yield* refusal(command), "ThreadManagementProviderInstanceDisabledError");
      assert.isFalse(yield* threads.hasReceipt(command.commandId));
      assert.isUndefined((yield* linkOf(sourceId))?.reviewLoop);
    }),
  );

  it.effect("a stop ends the live loop and keeps the pull request watch", () =>
    Effect.gen(function* () {
      const sourceId = ThreadId.make("thread:loop:stop");
      yield* createSource(sourceId);
      yield* dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("watch"),
        threadId: sourceId,
        ...pullRequest,
        watching: true,
      });
      const loop = yield* startLoop(sourceId, "stop");

      assert.equal(
        yield* refusal(
          stop(
            sourceId,
            "other-loop",
            IdAllocator.derive.reviewLoop({ commandId: CommandId.make("other") }),
          ),
        ),
        "OrchestratorDispatchError",
      );
      yield* dispatch(stop(sourceId, "stop", loop.id));
      const link = yield* linkOf(sourceId);
      const record = link?.reviewLoop;
      assert.deepInclude(record?.role === "author" ? record.phase : undefined, {
        status: "ended",
        reason: "stopped",
        reviews: 0,
      });
      assert.isDefined(link?.watch);
      assert.equal(
        yield* refusal(stop(sourceId, "stop-again", loop.id)),
        "OrchestratorDispatchError",
      );
    }),
  );

  it.effect("an advance records the phase and sends the step's message in one commit", () =>
    Effect.gen(function* () {
      const sourceId = ThreadId.make("thread:loop:advance");
      yield* createSource(sourceId);
      const loop = yield* startLoop(sourceId, "advance");
      const fixing = { status: "fixing", round: 1 } as const;

      const result = yield* dispatch(
        advance(sourceId, loop, loop.phase, fixing, { target: "source", text: "Review 1 of 3" }),
      );
      assert.deepEqual(liveAuthorLoop((yield* linkOf(sourceId))!)?.phase, fixing);
      const delivery = (yield* threadOf(sourceId)).messages.find(
        (message) => message.text === "Review 1 of 3",
      );
      assert.deepInclude(delivery, {
        id: IdAllocator.derive.reviewLoopMessage({ loopId: loop.id, phase: fixing }),
        createdBy: "agent",
        creationSource: "server",
        senderThreadId: loop.reviewThreadId,
      });
      assert.includeMembers(
        result.storedEvents.map(({ event }) => `${event.type} ${event.threadId}`),
        [`thread.pull-request-synced ${sourceId}`, `message.updated ${sourceId}`],
      );

      yield* dispatch(
        advance(
          sourceId,
          loop,
          fixing,
          { status: "reviewing", round: 2 },
          {
            target: "review",
            text: "Review 2 of 3",
          },
        ),
      );
      const request = (yield* threadOf(loop.reviewThreadId)).messages.find(
        (message) => message.text === "Review 2 of 3",
      );
      assert.deepInclude(request, { senderThreadId: sourceId, createdBy: "agent" });
    }),
  );

  it.effect("an advance refuses a stale, illegal, or misdirected step", () =>
    Effect.gen(function* () {
      const sourceId = ThreadId.make("thread:loop:advance-guards");
      yield* createSource(sourceId);
      const loop = yield* startLoop(sourceId, "advance-guards");
      const reviewing1 = { status: "reviewing", round: 1 } as const;
      const fixing1 = { status: "fixing", round: 1 } as const;
      const reviewing2 = { status: "reviewing", round: 2 } as const;

      for (const [name, command] of [
        ["stale", advance(sourceId, loop, fixing1, reviewing2, { target: "review", text: "x" })],
        [
          "skips a fix",
          advance(sourceId, loop, reviewing1, reviewing2, { target: "review", text: "x" }),
        ],
        [
          "delivery into the review thread",
          advance(sourceId, loop, reviewing1, fixing1, { target: "review", text: "x" }),
        ],
        ["delivery with no message", advance(sourceId, loop, reviewing1, fixing1)],
        [
          "end note into the review thread",
          advance(sourceId, loop, reviewing1, ended("clean", 1), { target: "review", text: "x" }),
        ],
      ] as const) {
        assert.equal(
          yield* refusal({ ...command, commandId: CommandId.make(`advance-guard:${name}`) }),
          "OrchestratorDispatchError",
          name,
        );
      }
      assert.deepEqual(liveAuthorLoop((yield* linkOf(sourceId))!)?.phase, reviewing1);

      yield* dispatch(
        advance(sourceId, loop, reviewing1, fixing1, { target: "source", text: "Review 1" }),
      );
      yield* dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make("unlink-review"),
        threadId: loop.reviewThreadId,
        ...pullRequest,
      });
      assert.equal(
        yield* refusal(
          advance(sourceId, loop, fixing1, reviewing2, { target: "review", text: "Review 2" }),
        ),
        "OrchestratorDispatchError",
      );
      assert.deepEqual(liveAuthorLoop((yield* linkOf(sourceId))!)?.phase, fixing1);
    }),
  );

  it.effect("a release removes the reviewer marker only once the loop is not live", () =>
    Effect.gen(function* () {
      const sourceId = ThreadId.make("thread:loop:release");
      yield* createSource(sourceId);
      const loop = yield* startLoop(sourceId, "release");
      assert.equal(
        yield* refusal(release(loop.reviewThreadId, loop.id)),
        "OrchestratorDispatchError",
      );

      const archivedSourceId = ThreadId.make("thread:loop:release-archived");
      yield* createSource(archivedSourceId);
      const archivedLoop = yield* startLoop(archivedSourceId, "release-archived");
      yield* dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-review"),
        threadId: archivedLoop.reviewThreadId,
      });
      yield* dispatch(stop(archivedSourceId, "release-archived", archivedLoop.id));
      yield* dispatch(release(archivedLoop.reviewThreadId, archivedLoop.id));
      assert.isUndefined((yield* linkOf(archivedLoop.reviewThreadId))?.reviewLoop);
      assert.isDefined(reviewerMarker((yield* linkOf(loop.reviewThreadId))!));
    }),
  );

  it.effect(
    "an advance into the review thread takes the source thread's lock before the review thread's",
    () =>
      Effect.gen(function* () {
        const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const sourceId = ThreadId.make("thread:loop:lock-order");
        yield* createSource(sourceId);
        const loop = yield* startLoop(sourceId, "lock-order");
        const fixing1 = { status: "fixing", round: 1 } as const;
        yield* dispatch(
          advance(sourceId, loop, loop.phase, fixing1, { target: "source", text: "Review 1" }),
        );

        const held = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const holder = yield* locks
          .withLock(
            loop.reviewThreadId,
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(released))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(held);
        const step = yield* dispatch(
          advance(
            sourceId,
            loop,
            fixing1,
            { status: "reviewing", round: 2 },
            {
              target: "review",
              text: "Review 2",
            },
          ),
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        assert.includeMembers([...(yield* locks.activeKeys)], [sourceId, loop.reviewThreadId]);
        assert.deepEqual(liveAuthorLoop((yield* linkOf(sourceId))!)?.phase, fixing1);
        yield* Deferred.succeed(released, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(step);
        assert.deepEqual(liveAuthorLoop((yield* linkOf(sourceId))!)?.phase, {
          status: "reviewing",
          round: 2,
        });
      }),
  );
});
