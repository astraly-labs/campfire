import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ReviewLoopFindingId,
  type ReviewLoopLivePhase,
  type ReviewLoopPhase,
  ThreadId,
  type ThreadPullRequestSnapshot,
  type ThreadPullRequestStack,
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
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
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
const authorOffProjectId = ProjectId.make("project:review-loop:author-off");
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
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
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
        [authorOffProjectId]: {
          providerInstances: { [authorModel.instanceId]: { enabled: false } },
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

const syncSnapshot = (
  threadId: ThreadId,
  snapshot: Partial<ThreadPullRequestSnapshot>,
  stack: ThreadPullRequestStack | null = null,
) =>
  dispatch({
    type: "thread.pull-request-link.sync",
    commandId: CommandId.make(`sync:${threadId}:${JSON.stringify([snapshot, stack])}`),
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
    stack,
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
  request: { type: "start", reviewer: reviewerModel, budget: 3, ...request },
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

const loopMessages = (threadId: ThreadId) =>
  Effect.map(threadOf(threadId), (projection) =>
    projection.messages.filter(
      (message) =>
        message.role === "user" &&
        message.createdBy === "agent" &&
        message.creationSource === "server",
    ),
  );

const scoping = { status: "scoping", budget: 3 } as const;
const reviewing1 = { status: "reviewing", budget: 3, round: 1 } as const;
const openS1 = [{ id: ReviewLoopFindingId.make("S1"), severity: "should" }] as const;

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

const ended = (
  reason: "stopped" | "approved",
  reviews: 0 | 1 | 2 | 3,
  budget: 3 | 5 = 3,
): ReviewLoopPhase => ({
  status: "ended",
  reason,
  reviews,
  budget,
  endedAt: "2026-11-02T10:00:00.000Z",
});

it.layer(layerTest)("review loop commands", (it) => {
  it.effect(
    "a start records the brief turn, creates the review thread, and asks this thread for the brief in one commit",
    () =>
      Effect.gen(function* () {
        const sourceId = ThreadId.make("thread:loop:start");
        yield* createSource(sourceId);
        const command = start(sourceId, "start");
        const result = yield* dispatch(command);

        const loop = liveAuthorLoop((yield* linkOf(sourceId))!);
        assert.deepInclude(loop, { role: "author", phase: scoping });
        assert.notProperty(loop, "note");
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
        assert.lengthOf(review.messages, 0);
        const [brief] = yield* loopMessages(sourceId);
        assert.deepInclude(brief, {
          id: IdAllocator.derive.reviewLoopMessage({ loopId: loop!.id, phase: scoping }),
          senderThreadId: loop!.reviewThreadId,
        });
        assert.isTrue(brief!.id.endsWith(":scoping"));
        assert.strictEqual(
          brief!.text.split("\n")[0],
          "**Review loop started** for #42. Composer 1 reviews this change, up to 3 reviews.",
        );
        assert.include(brief!.text, "`git merge-base HEAD origin/<default branch>`");

        const committed = result.storedEvents.map(({ event }) => `${event.type} ${event.threadId}`);
        assert.includeMembers(committed, [
          `thread.pull-request-synced ${sourceId}`,
          `thread.created ${loop!.reviewThreadId}`,
          `message.updated ${sourceId}`,
        ]);

        const replay = yield* dispatch(command);
        assert.equal(replay.sequence, result.sequence);
        assert.lengthOf(yield* loopMessages(sourceId), 1);
        assert.lengthOf((yield* threadOf(loop!.reviewThreadId)).messages, 0);
        assert.deepEqual(liveAuthorLoop((yield* linkOf(sourceId))!), loop);
      }),
  );

  it.effect(
    "a start keeps the budget and the note, and the brief request leaves the note out",
    () =>
      Effect.gen(function* () {
        const sourceId = ThreadId.make("thread:loop:start-five");
        yield* createSource(sourceId);
        yield* syncSnapshot(sourceId, {});
        yield* dispatch(
          start(sourceId, "start-five", { budget: 5, note: "Look hard at the retry path." }),
        );

        const loop = liveAuthorLoop((yield* linkOf(sourceId))!);
        assert.deepInclude(loop, {
          note: "Look hard at the retry path.",
          phase: { status: "scoping", budget: 5 },
        });
        const [brief] = yield* loopMessages(sourceId);
        assert.include(brief!.text.split("\n")[0], "up to 5 reviews.");
        assert.include(brief!.text, "`git merge-base HEAD origin/main`");
        assert.notInclude(brief!.text, "Look hard at the retry path.");
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

  it.effect(
    "a start is refused before the orchestrator when the reviewer's or this thread's provider is off",
    () =>
      Effect.gen(function* () {
        const threads = yield* ThreadManagementService.ThreadManagementService;
        for (const [name, offProjectId] of [
          ["reviewer-off", reviewerOffProjectId],
          ["author-off", authorOffProjectId],
        ] as const) {
          const sourceId = ThreadId.make(`thread:loop:${name}`);
          yield* createSource(sourceId, { projectId: offProjectId });
          const command = start(sourceId, name);

          assert.equal(
            yield* refusal(command),
            "ThreadManagementProviderInstanceDisabledError",
            name,
          );
          assert.isFalse(yield* threads.hasReceipt(command.commandId), name);
          assert.isUndefined((yield* linkOf(sourceId))?.reviewLoop, name);
          assert.lengthOf(yield* loopMessages(sourceId), 0, name);
        }
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
        budget: 3,
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
      const fixing1 = { status: "fixing", budget: 3, round: 1, open: openS1 } as const;

      yield* dispatch(
        advance(sourceId, loop, loop.phase, reviewing1, {
          target: "review",
          text: "Review 1 of 3",
        }),
      );
      const request = (yield* threadOf(loop.reviewThreadId)).messages.find(
        (message) => message.text === "Review 1 of 3",
      );
      assert.deepInclude(request, {
        id: IdAllocator.derive.reviewLoopMessage({ loopId: loop.id, phase: reviewing1 }),
        senderThreadId: sourceId,
        createdBy: "agent",
      });

      const result = yield* dispatch(
        advance(sourceId, loop, reviewing1, fixing1, {
          target: "source",
          text: "Review 1 relayed",
        }),
      );
      assert.deepEqual(liveAuthorLoop((yield* linkOf(sourceId))!)?.phase, fixing1);
      const delivery = (yield* threadOf(sourceId)).messages.find(
        (message) => message.text === "Review 1 relayed",
      );
      assert.deepInclude(delivery, {
        id: IdAllocator.derive.reviewLoopMessage({ loopId: loop.id, phase: fixing1 }),
        createdBy: "agent",
        creationSource: "server",
        senderThreadId: loop.reviewThreadId,
      });
      assert.includeMembers(
        result.storedEvents.map(({ event }) => `${event.type} ${event.threadId}`),
        [`thread.pull-request-synced ${sourceId}`, `message.updated ${sourceId}`],
      );
    }),
  );

  it.effect("an advance takes review 3 of 3 to fix 3 of 5, and the loop runs on to review 4", () =>
    Effect.gen(function* () {
      const sourceId = ThreadId.make("thread:loop:extension");
      yield* createSource(sourceId);
      const loop = yield* startLoop(sourceId, "extension");
      const steps: ReadonlyArray<readonly [ReviewLoopLivePhase, "source" | "review"]> = [
        [reviewing1, "review"],
        [{ status: "fixing", budget: 3, round: 1, open: [] }, "source"],
        [{ status: "reviewing", budget: 3, round: 2 }, "review"],
        [{ status: "fixing", budget: 3, round: 2, open: [] }, "source"],
        [{ status: "reviewing", budget: 3, round: 3 }, "review"],
        [{ status: "fixing", budget: 5, round: 3, open: openS1 }, "source"],
        [{ status: "reviewing", budget: 5, round: 4 }, "review"],
      ];
      let from: ReviewLoopLivePhase = loop.phase;
      for (const [to, target] of steps) {
        yield* dispatch(
          advance(sourceId, loop, from, to, { target, text: `Step to ${to.status}` }),
        );
        assert.deepEqual(liveAuthorLoop((yield* linkOf(sourceId))!)?.phase, to);
        from = to;
      }
    }),
  );

  it.effect("an advance refuses a stale, illegal, or misdirected step", () =>
    Effect.gen(function* () {
      const sourceId = ThreadId.make("thread:loop:advance-guards");
      yield* createSource(sourceId);
      const loop = yield* startLoop(sourceId, "advance-guards");
      const fixing1 = { status: "fixing", budget: 3, round: 1, open: [] } as const;
      assert.equal(
        yield* refusal({
          ...advance(sourceId, loop, scoping, fixing1, { target: "source", text: "x" }),
          commandId: CommandId.make("advance-guard:skips review 1"),
        }),
        "OrchestratorDispatchError",
      );
      yield* dispatch(
        advance(sourceId, loop, scoping, reviewing1, { target: "review", text: "Review 1" }),
      );
      const reviewing2 = { status: "reviewing", budget: 3, round: 2 } as const;
      const fixing1Of5 = { status: "fixing", budget: 5, round: 1, open: [] } as const;

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
          advance(sourceId, loop, reviewing1, ended("approved", 1), {
            target: "review",
            text: "x",
          }),
        ],
        [
          "a budget raise before review 3",
          advance(sourceId, loop, reviewing1, fixing1Of5, { target: "source", text: "x" }),
        ],
        [
          "a from that claims budget 5",
          advance(sourceId, loop, { ...reviewing1, budget: 5 }, fixing1Of5, {
            target: "source",
            text: "x",
          }),
        ],
        ["an end in another budget", advance(sourceId, loop, reviewing1, ended("stopped", 0, 5))],
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
    "the step from the brief into review 1 takes the source thread's lock before the review thread's",
    () =>
      Effect.gen(function* () {
        const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const sourceId = ThreadId.make("thread:loop:lock-order");
        yield* createSource(sourceId);
        const loop = yield* startLoop(sourceId, "lock-order");

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
          advance(sourceId, loop, scoping, reviewing1, { target: "review", text: "Review 1" }),
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        assert.includeMembers([...(yield* locks.activeKeys)], [sourceId, loop.reviewThreadId]);
        assert.deepEqual(liveAuthorLoop((yield* linkOf(sourceId))!)?.phase, scoping);
        yield* Deferred.succeed(released, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(step);
        assert.deepEqual(liveAuthorLoop((yield* linkOf(sourceId))!)?.phase, reviewing1);
      }),
  );

  it.effect("a pull request sync that rebuilds the linked pull request keeps the loop", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* projects.apply({
        sequence: 0,
        eventId: EventId.make(`seed:${projectId}`),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: "2026-11-02T09:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "Login",
          workspaceRoot: "/workspace/login",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-11-02T09:00:00.000Z",
          updatedAt: "2026-11-02T09:00:00.000Z",
        },
      });
      const sourceId = ThreadId.make("thread:loop:legacy-sync");
      yield* createSource(sourceId);
      const loop = yield* startLoop(sourceId, "legacy-sync");
      const linked = {
        projectId,
        repository: pullRequest.repository,
        number: pullRequest.number,
        url: pullRequestUrl,
      };

      for (const threadId of [sourceId, loop.reviewThreadId]) {
        yield* dispatch({
          type: "thread.pull-request.sync",
          commandId: CommandId.make(`pull-request-sync:${threadId}`),
          threadId,
          projectId,
          snapshotSequence: yield* sink.latestSequence({ threadId }),
          expected: {
            workspaceRoot: "/workspace/login",
            branch: "feature/login",
            worktreePath: "/workspace/login",
            linkedPullRequest: null,
            branchPullRequest: null,
          },
          branchPullRequest: linked,
          linkedPullRequest: linked,
        });
      }

      const rebuilt = yield* linkOf(sourceId);
      assert.equal(rebuilt?.source, "manual");
      assert.deepEqual(liveAuthorLoop(rebuilt!), loop);
      assert.equal(reviewerMarker((yield* linkOf(loop.reviewThreadId))!)?.id, loop.id);
    }),
  );

  it.effect(
    "archive, Stop, and a stack unlink end the source's loop as stopped and keep the marker",
    () =>
      Effect.gen(function* () {
        const stack: ThreadPullRequestStack = {
          kind: "native",
          id: "stack-1",
          number: 41,
          url: "https://github.com/pingdotgg/t3code/pull/41",
          base: "main",
          layers: [
            { number: 41, headBranch: "feature/base", state: "open" },
            { number: 42, headBranch: "feature/login", state: "open" },
          ],
        };
        for (const name of ["archive", "stop", "stack-unlink"] as const) {
          const sourceId = ThreadId.make(`thread:loop:ends-on-${name}`);
          yield* createSource(sourceId);
          if (name === "stack-unlink") yield* syncSnapshot(sourceId, {}, stack);
          const loop = yield* startLoop(sourceId, `ends-on-${name}`);
          const commandId = CommandId.make(`ends-on-${name}`);
          yield* dispatch(
            name === "archive"
              ? { type: "thread.archive", commandId, threadId: sourceId }
              : name === "stop"
                ? { type: "thread.stop", commandId, threadId: sourceId }
                : {
                    type: "thread.pull-request.unlink",
                    commandId,
                    threadId: sourceId,
                    ...pullRequest,
                  },
          );

          const record = (yield* linkOf(sourceId))?.reviewLoop;
          assert.deepInclude(
            record?.role === "author" ? record.phase : undefined,
            { status: "ended", reason: "stopped", reviews: 0 },
            name,
          );
          assert.equal(reviewerMarker((yield* linkOf(loop.reviewThreadId))!)?.id, loop.id, name);
        }
      }),
  );

  it.effect("settling is refused while the source writes the brief, and the loop stays live", () =>
    Effect.gen(function* () {
      const sourceId = ThreadId.make("thread:loop:settle-during-brief");
      yield* createSource(sourceId);
      const loop = yield* startLoop(sourceId, "settle-during-brief");

      assert.equal(
        yield* refusal({
          type: "thread.settle",
          commandId: CommandId.make("settle-during-brief"),
          threadId: sourceId,
        }),
        "OrchestratorDispatchError",
      );
      assert.deepEqual(liveAuthorLoop((yield* linkOf(sourceId))!), loop);
    }),
  );

  it.effect("Stop in the review thread keeps its marker and the source's loop", () =>
    Effect.gen(function* () {
      const sourceId = ThreadId.make("thread:loop:review-stop");
      yield* createSource(sourceId);
      const loop = yield* startLoop(sourceId, "review-stop");
      yield* dispatch({
        type: "thread.stop",
        commandId: CommandId.make("review-stop"),
        threadId: loop.reviewThreadId,
      });

      assert.equal(reviewerMarker((yield* linkOf(loop.reviewThreadId))!)?.id, loop.id);
      assert.deepEqual(liveAuthorLoop((yield* linkOf(sourceId))!), loop);
    }),
  );
});
