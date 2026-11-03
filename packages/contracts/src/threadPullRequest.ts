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

/**
 * How many reviews a loop may run. 5 when the user allows it at start, or when review 3 of 3
 * leaves a blocker or should with a risk area open.
 */
export const ReviewLoopBudget = Schema.Literals([3, 5]);
export type ReviewLoopBudget = typeof ReviewLoopBudget.Type;

export const ReviewLoopFindingId = Schema.String.check(Schema.isPattern(/^S[1-9]\d*$/)).pipe(
  Schema.brand("ReviewLoopFindingId"),
);
export type ReviewLoopFindingId = typeof ReviewLoopFindingId.Type;

/** `unknown` is a severity the server could not read. It blocks approval like a should. */
export const ReviewLoopFindingSeverity = Schema.Literals(["blocker", "should", "nit", "unknown"]);
export type ReviewLoopFindingSeverity = typeof ReviewLoopFindingSeverity.Type;

export const ReviewLoopFindingRef = Schema.Struct({
  id: ReviewLoopFindingId,
  severity: ReviewLoopFindingSeverity,
});
export type ReviewLoopFindingRef = typeof ReviewLoopFindingRef.Type;

/** What the review being answered left open, nits included, in id order. */
const ReviewLoopOpenFindings = Schema.Array(ReviewLoopFindingRef).check(Schema.isMaxLength(40));

/**
 * Why a review loop ended. Clients derive the outcome they show from it
 * (`@t3tools/shared/pullRequestReviewLoop`), so the outcome is never stored beside it.
 */
export const ReviewLoopEndReason = Schema.Literals([
  /** The reviewer wrote APPROVE and left no blocker or should open. */
  "approved",
  /** The last review of the budget was not approved. */
  "budget_ended",
  /** The author still disputes a finding that the reviewer kept open after its last reply. */
  "stuck",
  /** The user stopped the loop, or stopped, archived, settled, or unlinked the source thread. */
  "stopped",
  /** The review run stopped, its queue is paused, or the review thread is gone. */
  "review_stopped",
  /** The review run failed, ended without a message, or its provider is off. */
  "review_failed",
  /** The brief or a fix stopped, or its queue is paused. */
  "author_stopped",
  /** The brief or a fix failed, or this thread's provider is off. */
  "author_failed",
  "pr_merged",
  "pr_closed",
  /** A step could not commit, or the message the loop waited for is gone. */
  "aborted",
]);
export type ReviewLoopEndReason = typeof ReviewLoopEndReason.Type;

/** The author's turn before review 1, in which it writes the review brief. */
const ReviewLoopScoping = Schema.Struct({
  status: Schema.Literal("scoping"),
  budget: ReviewLoopBudget,
});
const ReviewLoopReviewingOf3 = Schema.Struct({
  status: Schema.Literal("reviewing"),
  budget: Schema.Literal(3),
  round: Schema.Literals([1, 2, 3]),
});
const ReviewLoopReviewingOf5 = Schema.Struct({
  status: Schema.Literal("reviewing"),
  budget: Schema.Literal(5),
  round: Schema.Literals([1, 2, 3, 4, 5]),
});
/** The author answers review `round`. The last review of a budget has no fix. */
const ReviewLoopFixingOf3 = Schema.Struct({
  status: Schema.Literal("fixing"),
  budget: Schema.Literal(3),
  round: Schema.Literals([1, 2]),
  open: ReviewLoopOpenFindings,
});
const ReviewLoopFixingOf5 = Schema.Struct({
  status: Schema.Literal("fixing"),
  budget: Schema.Literal(5),
  round: Schema.Literals([1, 2, 3, 4]),
  open: ReviewLoopOpenFindings,
});

export const ReviewLoopLivePhase = Schema.Union([
  ReviewLoopScoping,
  ReviewLoopReviewingOf3,
  ReviewLoopReviewingOf5,
  ReviewLoopFixingOf3,
  ReviewLoopFixingOf5,
]);
export type ReviewLoopLivePhase = typeof ReviewLoopLivePhase.Type;
export type ReviewLoopScopingPhase = Extract<ReviewLoopLivePhase, { readonly status: "scoping" }>;
export type ReviewLoopReviewingPhase = Extract<
  ReviewLoopLivePhase,
  { readonly status: "reviewing" }
>;
export type ReviewLoopFixingPhase = Extract<ReviewLoopLivePhase, { readonly status: "fixing" }>;

export const ReviewLoopEndedPhase = Schema.Struct({
  status: Schema.Literal("ended"),
  reason: ReviewLoopEndReason,
  /** Reviews that finished before the end. */
  reviews: Schema.Literals([0, 1, 2, 3, 4, 5]),
  /** The budget the loop ran under at the end. */
  budget: ReviewLoopBudget,
  /** Why, in a few words, such as the failed run's error or the disputed ids. */
  detail: Schema.optional(TrimmedNonEmptyString),
  endedAt: IsoDateTime,
});
export type ReviewLoopEndedPhase = typeof ReviewLoopEndedPhase.Type;

/**
 * The loop's state machine, where B is the budget:
 *
 *   scoping -> reviewing 1 -> fixing 1 -> reviewing 2 -> ... -> reviewing B
 *
 * Review 3 of 3 can also step to fixing 3 of 5, the only step that changes the budget. Any live
 * phase can end.
 */
export const ReviewLoopPhase = Schema.Union([
  ReviewLoopScoping,
  ReviewLoopReviewingOf3,
  ReviewLoopReviewingOf5,
  ReviewLoopFixingOf3,
  ReviewLoopFixingOf5,
  ReviewLoopEndedPhase,
]);
export type ReviewLoopPhase = typeof ReviewLoopPhase.Type;

/** The user's optional note for the reviewer. Review request 1 quotes it after the brief. */
export const ReviewLoopNote = TrimmedNonEmptyString.check(Schema.isMaxLength(2000));

/**
 * The whole loop state, on the source thread's link. An ended record stays until the next loop
 * on this link replaces it, so clients can show the outcome.
 */
export const ThreadPullRequestReviewLoopAuthor = Schema.Struct({
  role: Schema.Literal("author"),
  id: ReviewLoopId,
  reviewThreadId: ThreadId,
  note: Schema.optional(ReviewLoopNote),
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
  reviewLoop: ForwardCompatibleOptional(ThreadPullRequestReviewLoop),
});
export type ThreadPullRequestLink = typeof ThreadPullRequestLink.Type;
