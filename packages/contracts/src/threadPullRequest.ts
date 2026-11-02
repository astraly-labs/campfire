import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleOptional,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ReviewLoopId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  PullRequestActor,
  PullRequestChecksState,
  PullRequestMergeability,
  PullRequestReviewDecision,
  PullRequestState,
} from "./pullRequest.ts";

/**
 * Legacy single-PR link. Still emitted as the thread's derived current pull
 * request (see `@t3tools/shared/threadPullRequests`) so clients from before
 * `pullRequests` keep working independently of their release schedule.
 */
export const ThreadLinkedPullRequest = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});
export type ThreadLinkedPullRequest = typeof ThreadLinkedPullRequest.Type;

/** Who created a thread ↔ pull request link. `stack-dismissed` is a tombstone
 * for a native-stack member the user unlinked, so the sync reactor does not
 * re-add it; clients hide it. */
export const ThreadPullRequestLinkSource = Schema.Literals([
  "manual",
  "created",
  "agent",
  "stack",
  "stack-dismissed",
]);
export type ThreadPullRequestLinkSource = typeof ThreadPullRequestLinkSource.Type;

/**
 * Host state persisted on a link by the sync reactor; null until first sync. The overview
 * fields are optional: a host whose cheap read lacks them leaves them out, and snapshots
 * written before they existed still decode.
 */
export const ThreadPullRequestSnapshot = Schema.Struct({
  state: PullRequestState,
  title: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  isDraft: Schema.Boolean,
  updatedAt: Schema.NullOr(IsoDateTime),
  syncedAt: IsoDateTime,
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(PullRequestActor)),
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
  changedFiles: Schema.optional(NonNegativeInt),
  reviewDecision: Schema.optional(Schema.NullOr(PullRequestReviewDecision)),
  checksState: Schema.optional(Schema.NullOr(PullRequestChecksState)),
  mergeability: Schema.optional(PullRequestMergeability),
});
export type ThreadPullRequestSnapshot = typeof ThreadPullRequestSnapshot.Type;

export const ThreadPullRequestStackLayer = Schema.Struct({
  number: PositiveInt,
  headBranch: TrimmedNonEmptyString,
  state: PullRequestState,
});
export type ThreadPullRequestStackLayer = typeof ThreadPullRequestStackLayer.Type;

/** A host-native stack the pull request belongs to. Layers run bottom to top. */
export const ThreadPullRequestStack = Schema.Struct({
  kind: Schema.Literal("native"),
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  base: TrimmedNonEmptyString,
  layers: Schema.Array(ThreadPullRequestStackLayer),
});
export type ThreadPullRequestStack = typeof ThreadPullRequestStack.Type;

/** Identity of a pull request as a thread link sees it: host-level, so the
 * same PR linked from two projects (or two environments) compares equal. */
export const ThreadPullRequestKey = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type ThreadPullRequestKey = typeof ThreadPullRequestKey.Type;

/**
 * Present while the server watches the pull request for its thread. The server wakes the
 * thread's agent when checks finish on the head commit, someone else comments, or the branch
 * starts to conflict. The other fields record what the agent was last told, so each change is
 * reported once.
 */
export const ThreadPullRequestWatch = Schema.Struct({
  startedAt: IsoDateTime,
  /** Head commit at the last pass; null where the host does not report one. */
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  /** Failed checks on that commit the agent was told about; a rerun that fails again is news. */
  failedChecks: Schema.Array(TrimmedNonEmptyString),
  /** The agent was told the required checks on that commit passed. */
  passed: Schema.Boolean,
  /**
   * Names in the passing gate on that commit, so a required check that first shows up already
   * passed is news. Empty on watches saved before this field existed.
   */
  passedChecks: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Remarks from others created up to this host time were reported. */
  remarksThrough: IsoDateTime,
  /** Remarks created exactly at `remarksThrough` that were reported, so a late one still counts. */
  remarkIds: Schema.Array(TrimmedNonEmptyString),
  conflicting: Schema.Boolean,
  /** Comment-only wakes in a row. Watching stops at a limit, so bots cannot loop it. */
  wakes: NonNegativeInt,
});
export type ThreadPullRequestWatch = typeof ThreadPullRequestWatch.Type;

/** Review 3 is the last review, so a fourth review cannot be written down. */
export const ReviewLoopReviewRound = Schema.Literals([1, 2, 3]);
export type ReviewLoopReviewRound = typeof ReviewLoopReviewRound.Type;

/** Fix 2 is the last fix, so a third fix cannot be written down. */
export const ReviewLoopFixRound = Schema.Literals([1, 2]);
export type ReviewLoopFixRound = typeof ReviewLoopFixRound.Type;

/**
 * Why a review loop ended. Clients derive the outcome they show from it
 * (`@t3tools/shared/pullRequestReviewLoop`), so the outcome is never stored beside it.
 */
export const ReviewLoopEndReason = Schema.Literals([
  /** A review ended with the clean verdict line. */
  "clean",
  /** Review 3 was not clean. */
  "needs_human",
  /** The user stopped the loop, or stopped, archived, settled, or unlinked the source thread. */
  "stopped",
  /** The review run stopped, its queue is paused, or the review thread is gone. */
  "review_stopped",
  /** The review run failed, ended without a message, or its provider is off. */
  "review_failed",
  /** The fix run stopped, or its queue is paused. */
  "fix_stopped",
  /** The fix run failed, or its provider is off. */
  "fix_failed",
  "pr_merged",
  "pr_closed",
  /** A step could not commit. The server log has the cause. */
  "aborted",
]);
export type ReviewLoopEndReason = typeof ReviewLoopEndReason.Type;

const ReviewLoopReviewing = Schema.Struct({
  status: Schema.Literal("reviewing"),
  round: ReviewLoopReviewRound,
});
const ReviewLoopFixing = Schema.Struct({
  status: Schema.Literal("fixing"),
  round: ReviewLoopFixRound,
});

export const ReviewLoopLivePhase = Schema.Union([ReviewLoopReviewing, ReviewLoopFixing]);
export type ReviewLoopLivePhase = typeof ReviewLoopLivePhase.Type;

export const ReviewLoopEndedPhase = Schema.Struct({
  status: Schema.Literal("ended"),
  reason: ReviewLoopEndReason,
  /** Reviews that finished before the end. */
  reviews: Schema.Literals([0, 1, 2, 3]),
  /** Why, in a few words, such as the failed run's error. */
  detail: Schema.optional(TrimmedNonEmptyString),
  endedAt: IsoDateTime,
});
export type ReviewLoopEndedPhase = typeof ReviewLoopEndedPhase.Type;

/**
 * The loop's state machine:
 *
 *   reviewing 1 -> fixing 1 -> reviewing 2 -> fixing 2 -> reviewing 3
 *
 * Any live phase can end. A clean review ends the loop at any round, and review 3 always ends
 * it. The message a live phase waits for derives from the loop id and the phase, so it is
 * never stored.
 */
export const ReviewLoopPhase = Schema.Union([
  ReviewLoopReviewing,
  ReviewLoopFixing,
  ReviewLoopEndedPhase,
]);
export type ReviewLoopPhase = typeof ReviewLoopPhase.Type;

/** What the user confirmed in the start dialog. Every review request starts with it. */
export const ReviewLoopPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(2000));

/**
 * The whole loop state, on the source thread's link. An ended record stays until the next loop
 * on this link replaces it, so clients can show the outcome.
 */
export const ThreadPullRequestReviewLoopAuthor = Schema.Struct({
  role: Schema.Literal("author"),
  id: ReviewLoopId,
  reviewThreadId: ThreadId,
  prompt: ReviewLoopPrompt,
  startedAt: IsoDateTime,
  phase: ReviewLoopPhase,
});
export type ThreadPullRequestReviewLoopAuthor = typeof ThreadPullRequestReviewLoopAuthor.Type;

/**
 * On the review thread's link to the same pull request while its loop is live. It holds no
 * state: it keeps the review thread waiting between reviews and points back to the loop.
 */
export const ThreadPullRequestReviewLoopReviewer = Schema.Struct({
  role: Schema.Literal("reviewer"),
  id: ReviewLoopId,
  sourceThreadId: ThreadId,
});
export type ThreadPullRequestReviewLoopReviewer = typeof ThreadPullRequestReviewLoopReviewer.Type;

export const ThreadPullRequestReviewLoop = Schema.Union([
  ThreadPullRequestReviewLoopAuthor,
  ThreadPullRequestReviewLoopReviewer,
]);
export type ThreadPullRequestReviewLoop = typeof ThreadPullRequestReviewLoop.Type;

export const ThreadPullRequestLink = Schema.Struct({
  ...ThreadPullRequestKey.fields,
  url: TrimmedNonEmptyString,
  source: ThreadPullRequestLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.NullOr(ThreadPullRequestSnapshot),
  stack: Schema.NullOr(ThreadPullRequestStack),
  watch: Schema.optional(ThreadPullRequestWatch),
  /** A loop shape this build does not know decodes as absent instead of failing the thread. */
  reviewLoop: ForwardCompatibleOptional(ThreadPullRequestReviewLoop),
});
export type ThreadPullRequestLink = typeof ThreadPullRequestLink.Type;
