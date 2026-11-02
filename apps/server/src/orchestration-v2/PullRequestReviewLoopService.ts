import type {
  MessageId,
  ModelSelection,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2ServerCommand,
  ReviewLoopEndedPhase,
  ReviewLoopId,
  RunId,
  ThreadId,
  ThreadPullRequestKey,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import {
  type LiveReviewLoopAuthor,
  liveAuthorLoop,
  reviewerMarker,
  reviewsFinishedBefore,
} from "@t3tools/shared/pullRequestReviewLoop";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
} from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  awaitedThread,
  decideReviewLoop,
  type ReviewLoopDecision,
  reviewLoopEndText,
  reviewLoopStepProgress,
} from "./pullRequestReviewLoop.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const SWEEP_INTERVAL = "2 minutes";

type Step = Extract<ReviewLoopDecision, { readonly kind: "advance" }>;

const logFailure =
  (message: string, fields: Record<string, unknown>) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...fields, cause });

function takesPart(thread: OrchestrationV2AppThread): boolean {
  return (
    thread.deletedAt === null &&
    threadPullRequestsOf(thread).some(
      (link) => liveAuthorLoop(link) !== undefined || reviewerMarker(link) !== undefined,
    )
  );
}

function ownsLoop(
  thread: OrchestrationV2AppThread,
  key: ThreadPullRequestKey,
  loopId: ReviewLoopId,
): boolean {
  return threadPullRequestsOf(thread).some(
    (link) =>
      threadPullRequestKeysEqual(link, key) &&
      link.reviewLoop?.role === "author" &&
      link.reviewLoop.id === loopId,
  );
}

function holdsMarker(
  thread: OrchestrationV2AppThread,
  key: ThreadPullRequestKey,
  loopId: ReviewLoopId,
): boolean {
  return threadPullRequestsOf(thread).some(
    (link) => threadPullRequestKeysEqual(link, key) && reviewerMarker(link)?.id === loopId,
  );
}

function stepCommand(
  source: OrchestrationV2AppThread,
  link: ThreadPullRequestLink,
  loop: LiveReviewLoopAuthor,
  step: Step,
) {
  return {
    type: "thread.pull-request-review-loop.advance",
    commandId: IdAllocator.derive.reviewLoopTransition({
      loopId: loop.id,
      from: loop.phase,
      to: step.to,
    }),
    threadId: source.id,
    ...normalizeThreadPullRequestKey(link),
    loopId: loop.id,
    reviewThreadId: loop.reviewThreadId,
    from: loop.phase,
    to: step.to,
    ...(step.post === undefined
      ? {}
      : {
          post: {
            ...step.post,
            messageId: IdAllocator.derive.reviewLoopMessage({ loopId: loop.id, phase: step.to }),
          },
        }),
  } satisfies OrchestrationV2ServerCommand;
}

/**
 * Drives every review loop. A step reads durable state, asks `decideReviewLoop` what comes next,
 * and dispatches it with an id derived from the loop and its phase, so a repeated step replays
 * its receipt. Terminal runs and lifecycle events of the threads in a loop trigger a step. A
 * sweep every two minutes catches what no event announces, such as background work that ends
 * without a run, and anything that happened while the server was down.
 */
export class PullRequestReviewLoopService extends Context.Service<
  PullRequestReviewLoopService,
  {
    /** The event tail and the sweep, both parked until activation. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Steps every loop the projections show. Runs at activation and every two minutes. */
    readonly sweep: Effect.Effect<void>;
    /** Steps the loops this thread takes part in, as their source or their reviewer. */
    readonly advanceThread: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/PullRequestReviewLoopService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  // Lets the event tail skip other threads' events without a read. A thread leaves only when a
  // read shows it in no live loop, and the sweep adds back any thread an event missed.
  const participants = new Set<ThreadId>();

  const readThread = (threadId: ThreadId) =>
    projections
      .getThread(threadId)
      .pipe(
        Effect.asSome,
        Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeedNone }),
      );

  const reviewerLabel = (model: ModelSelection) =>
    Effect.gen(function* () {
      const instance = yield* providerInstances.getInstance(model.instanceId);
      const name =
        instance === undefined ? undefined : (yield* instance.snapshot.getSnapshot).displayName;
      return `${name ?? model.instanceId} · ${model.model}`;
    });

  const continuationsPending = (runs: ReadonlyArray<OrchestrationV2Run>) =>
    Effect.forEach(
      runs.filter((run) => run.status === "cancelled"),
      (run) =>
        outbox
          .get(`effect:restart-continuation:${run.id}`)
          .pipe(
            Effect.map((effect) =>
              Option.exists(
                effect,
                (pending) => pending.status === "pending" || pending.status === "running",
              )
                ? [run.id]
                : [],
            ),
          ),
    ).pipe(Effect.map((ids) => new Set<RunId>(ids.flat())));

  const readStep = Effect.fn("PullRequestReviewLoopService.readStep")(function* (
    threadId: ThreadId,
    awaitedMessageId: MessageId,
  ) {
    const records = yield* projections.getThreadRecords(
      threadId,
      ["runs", "messages", "subagents", "providerThreads", "turnItems"],
      {
        messageIds: [awaitedMessageId],
        turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
        turnItemStatuses: ["pending", "running", "waiting"],
      },
    );
    const progress = reviewLoopStepProgress({
      awaitedMessage: records.messages[0],
      runs: records.runs,
      subagents: records.subagents,
      providerThreads: records.providerThreads,
      backgroundTurnItems: records.turnItems,
      activeProviderThreadId: records.thread.activeProviderThreadId,
      continuationPending: yield* continuationsPending(records.runs),
    });
    const settled =
      progress.kind === "settled"
        ? records.runs.find((run) => run.id === progress.run.id)
        : undefined;
    if (settled === undefined) return { progress, resultText: null };
    const output = yield* projections.getThreadRecords(threadId, ["messages", "turnItems"], {
      messageRoles: ["assistant"],
      messageRunIds: [settled.id],
      turnItemRunId: settled.id,
      turnItemTypes: ["assistant_message", "error"],
    });
    const result = subagentResultForRun(output, settled);
    return {
      progress,
      resultText: result.messageId === null && result.turnItemId === null ? null : result.text,
    };
  });

  /** Takes the next step of a live loop when its awaited turn allows. True when it ended. */
  const advanceLoop = Effect.fn("PullRequestReviewLoopService.advanceLoop")(function* (
    source: OrchestrationV2AppThread,
    link: ThreadPullRequestLink,
    loop: LiveReviewLoopAuthor,
  ) {
    const review = yield* readThread(loop.reviewThreadId);
    const reviewThread = Option.match(review, {
      onNone: () => "missing" as const,
      onSome: (thread) =>
        thread.deletedAt !== null
          ? ("deleted" as const)
          : thread.archivedAt !== null
            ? ("archived" as const)
            : holdsMarker(thread, link, loop.id)
              ? ("live" as const)
              : ("missing" as const),
    });
    const target = awaitedThread(loop, source.id);
    const awaited =
      target === loop.reviewThreadId && Option.isNone(review)
        ? { progress: { kind: "missing" as const }, resultText: null }
        : yield* readStep(
            target,
            IdAllocator.derive.reviewLoopMessage({ loopId: loop.id, phase: loop.phase }),
          );
    const facts = {
      reviewerLabel: Option.isSome(review)
        ? yield* reviewerLabel(review.value.modelSelection)
        : "The reviewer",
      pullRequest: Orchestrator.reviewLoopPullRequest(source, link),
      now: DateTime.formatIso(yield* DateTime.now),
    };
    const end = <Reason extends ReviewLoopEndedPhase["reason"]>(
      reason: Reason,
      reviews: ReviewLoopEndedPhase["reviews"],
      detail?: string,
    ): ReviewLoopEndedPhase & { readonly reason: Reason } => ({
      status: "ended",
      reason,
      reviews,
      ...(detail === undefined ? {} : { detail }),
      endedAt: facts.now,
    });
    const withProviderOff = (step: Step): Step => {
      if (step.to.status === "ended") return { kind: "advance", to: step.to };
      if (step.to.status === "fixing") {
        return {
          kind: "advance",
          to: end("fix_failed", step.to.round, "this thread's provider is off for this project"),
        };
      }
      const to = end(
        "review_failed",
        reviewsFinishedBefore(loop.phase),
        "the reviewer's provider is off for this project",
      );
      return {
        kind: "advance",
        to,
        post: { target: "source", text: reviewLoopEndText({ ...facts, to, reviewText: null }) },
      };
    };
    const commit = (
      step: Step,
    ): Effect.Effect<
      boolean,
      | Orchestrator.OrchestratorV2Error
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    > =>
      threads.dispatch(stepCommand(source, link, loop, step)).pipe(
        Effect.as(step.to.status === "ended"),
        Effect.catchTags({
          // The rejection burned this step's id, so it can never commit. The abort has its own.
          OrchestratorCommandPreviouslyRejectedError: (error) =>
            step.to.status === "ended" && step.to.reason === "aborted"
              ? Effect.fail(error)
              : commit({ kind: "advance", to: end("aborted", reviewsFinishedBefore(loop.phase)) }),
          // Refused before the orchestrator, so no id was burned.
          ThreadManagementProviderInstanceDisabledError: () => commit(withProviderOff(step)),
        }),
      );
    const decision = decideReviewLoop({ ...facts, ...awaited, loop, reviewThread });
    return decision.kind === "wait" ? false : yield* commit(decision);
  });

  const release = (
    review: OrchestrationV2AppThread,
    loopId: ReviewLoopId,
    link: ThreadPullRequestLink,
  ) =>
    review.deletedAt !== null || !holdsMarker(review, link, loopId)
      ? Effect.void
      : threads
          .dispatch({
            type: "thread.pull-request-review-loop.release",
            commandId: IdAllocator.derive.reviewLoopRelease({ loopId }),
            threadId: review.id,
            ...normalizeThreadPullRequestKey(link),
            loopId,
          })
          .pipe(Effect.asVoid);

  const advanceSource = (source: OrchestrationV2AppThread) =>
    Effect.forEach(
      threadPullRequestsOf(source),
      (link) =>
        Effect.gen(function* () {
          const record = link.reviewLoop;
          if (record?.role !== "author") return;
          // Deleting a thread leaves its links alone, so a deleted source still shows a live loop.
          const live = source.deletedAt === null ? liveAuthorLoop(link) : undefined;
          const ended = live === undefined || (yield* advanceLoop(source, link, live));
          if (!ended) return;
          const review = yield* readThread(record.reviewThreadId);
          if (Option.isSome(review)) yield* release(review.value, record.id, link);
        }),
      { discard: true },
    );

  const advanceThread: PullRequestReviewLoopService["Service"]["advanceThread"] = (threadId) =>
    Effect.gen(function* () {
      const thread = yield* readThread(threadId);
      if (Option.isNone(thread) || !takesPart(thread.value)) participants.delete(threadId);
      else participants.add(threadId);
      if (Option.isNone(thread)) return;
      yield* advanceSource(thread.value);
      for (const link of threadPullRequestsOf(thread.value)) {
        const marker = reviewerMarker(link);
        if (marker === undefined) continue;
        const source = yield* readThread(marker.sourceThreadId);
        if (Option.isSome(source) && ownsLoop(source.value, link, marker.id)) {
          yield* advanceSource(source.value);
        } else {
          yield* release(thread.value, marker.id, link);
        }
      }
    }).pipe(
      Effect.catchCause(logFailure("review loop step failed", { threadId })),
      Effect.withSpan("PullRequestReviewLoopService.advanceThread"),
    );

  const triggers = (event: OrchestrationV2DomainEvent): boolean => {
    switch (event.type) {
      case "run.updated":
        return (
          participants.has(event.threadId) &&
          ThreadManagementService.isTerminalRunStatus(event.payload.status)
        );
      case "thread.created":
      case "thread.pull-request-synced":
        return participants.has(event.threadId) || takesPart(event.payload);
      case "thread.archived":
      case "thread.settled":
      case "thread.deleted":
        return participants.has(event.threadId);
      default:
        return false;
    }
  };

  const sweep = projections.getReviewLoopThreadIds().pipe(
    Effect.flatMap((threadIds) => Effect.forEach(threadIds, advanceThread, { discard: true })),
    Effect.catchCause(logFailure("review loop sweep failed", {})),
    Effect.withSpan("PullRequestReviewLoopService.sweep"),
  );

  const start: PullRequestReviewLoopService["Service"]["start"] = () =>
    Effect.gen(function* () {
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, (event) =>
          triggers(event) ? advanceThread(event.threadId) : Effect.void,
        ).pipe(Effect.catchCause(logFailure("review loop event stream failed", {}))),
      );
      yield* forkParked(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.asVoid));
    });

  return PullRequestReviewLoopService.of({ start, sweep, advanceThread });
});

export const layer = Layer.effect(PullRequestReviewLoopService, make);
