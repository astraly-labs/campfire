import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ThreadShell,
  ReviewLoopEndedPhase,
  ReviewLoopEndReason,
  ReviewLoopId,
  ReviewLoopLivePhase,
  ReviewLoopPhase,
  ThreadId,
  ThreadPullRequestLink,
  ThreadPullRequestReviewLoop,
  ThreadPullRequestReviewLoopAuthor,
  ThreadPullRequestReviewLoopReviewer,
} from "@t3tools/contracts";
import { ReviewLoopFixRound, ReviewLoopReviewRound } from "@t3tools/contracts";

export const REVIEW_LOOP_MAX_REVIEWS = ReviewLoopReviewRound.literals.length;
const REVIEW_LOOP_MAX_FIXES = ReviewLoopFixRound.literals.length;

/** The start dialog's prompt until the user edits it. */
export function defaultReviewLoopPrompt(pullRequestNumber: number): string {
  return `/review #${pullRequestNumber}`;
}

export function isLiveReviewLoopPhase(phase: ReviewLoopPhase): phase is ReviewLoopLivePhase {
  return phase.status !== "ended";
}

export type ReviewLoopPhaseKey =
  | `reviewing-${ReviewLoopReviewRound}`
  | `fixing-${ReviewLoopFixRound}`
  | "ended";

/** The phase part of the ids a loop derives. A changed key orphans the loops in flight. */
export function reviewLoopPhaseKey(phase: ReviewLoopPhase): ReviewLoopPhaseKey {
  switch (phase.status) {
    case "reviewing":
      return `reviewing-${phase.round}`;
    case "fixing":
      return `fixing-${phase.round}`;
    case "ended":
      return "ended";
  }
}

const REVIEWS_BEFORE_REVIEW = { 1: 0, 2: 1, 3: 2 } as const;

export function reviewsFinishedBefore(phase: ReviewLoopLivePhase): ReviewLoopEndedPhase["reviews"] {
  return phase.status === "reviewing" ? REVIEWS_BEFORE_REVIEW[phase.round] : phase.round;
}

export type ReviewLoopOutcome =
  | "clean"
  | "needs_human"
  | "stopped"
  | "failed"
  | "merged"
  | "closed";

const OUTCOME_BY_REASON = {
  clean: "clean",
  needs_human: "needs_human",
  stopped: "stopped",
  review_stopped: "stopped",
  fix_stopped: "stopped",
  review_failed: "failed",
  fix_failed: "failed",
  aborted: "failed",
  pr_merged: "merged",
  pr_closed: "closed",
} satisfies Record<ReviewLoopEndReason, ReviewLoopOutcome>;

export function reviewLoopOutcome(reason: ReviewLoopEndReason): ReviewLoopOutcome {
  return OUTCOME_BY_REASON[reason];
}

export type LiveReviewLoopAuthor = ThreadPullRequestReviewLoopAuthor & {
  readonly phase: ReviewLoopLivePhase;
};

function isLiveAuthorLoop(
  loop: ThreadPullRequestReviewLoop | undefined,
): loop is LiveReviewLoopAuthor {
  return loop?.role === "author" && isLiveReviewLoopPhase(loop.phase);
}

export function liveAuthorLoop(
  link: Pick<ThreadPullRequestLink, "reviewLoop">,
): LiveReviewLoopAuthor | undefined {
  return isLiveAuthorLoop(link.reviewLoop) ? link.reviewLoop : undefined;
}

export function reviewerMarker(
  link: Pick<ThreadPullRequestLink, "reviewLoop">,
): ThreadPullRequestReviewLoopReviewer | undefined {
  return link.reviewLoop?.role === "reviewer" ? link.reviewLoop : undefined;
}

/**
 * The hold a link's review loop puts on its thread, like a watch's. A live author loop keeps the
 * source thread waiting while the reviewer works. A reviewer marker keeps the review thread
 * waiting while the author fixes.
 */
export function reviewLoopMonitorTasks(
  link: Pick<ThreadPullRequestLink, "reviewLoop" | "number" | "source">,
): Array<OrchestrationV2PendingBackgroundTask> {
  if (link.source === "stack-dismissed") return [];
  const author = liveAuthorLoop(link);
  if (author !== undefined) {
    return [
      {
        taskId: `review-loop:${author.id}`,
        description:
          author.phase.status === "reviewing"
            ? `Waiting for review ${author.phase.round} of ${REVIEW_LOOP_MAX_REVIEWS} on pull request #${link.number}`
            : `Review loop on pull request #${link.number}`,
        kind: "monitor",
      },
    ];
  }
  const marker = reviewerMarker(link);
  return marker === undefined
    ? []
    : [
        {
          taskId: `review-loop:${marker.id}:reviewer`,
          description: `Waiting for fixes to pull request #${link.number}`,
          kind: "monitor",
        },
      ];
}

export interface ReviewLoopChip {
  readonly tone: "working" | "success" | "warning" | "muted" | "error";
  readonly label: string;
  /** One sentence for the chip's menu. */
  readonly detail: string;
  readonly loopId: ReviewLoopId;
  readonly live: boolean;
  /** The review thread for an author record, the source thread for a reviewer marker. */
  readonly otherThreadId: ThreadId;
  readonly role: ThreadPullRequestReviewLoop["role"];
}

const OUTCOME_CHIP = {
  clean: { tone: "success", label: "Clean" },
  needs_human: { tone: "warning", label: "Needs you" },
  stopped: { tone: "muted", label: "Stopped" },
  failed: { tone: "error", label: "Failed" },
  merged: { tone: "muted", label: "Merged" },
  closed: { tone: "muted", label: "Closed" },
} satisfies Record<ReviewLoopOutcome, Pick<ReviewLoopChip, "tone" | "label">>;

function reviewCount(reviews: number): string {
  return reviews === 1 ? "1 review" : `${reviews} reviews`;
}

function endedDetail(phase: ReviewLoopEndedPhase): string {
  const why = phase.detail === undefined ? "" : `: ${phase.detail}`;
  switch (phase.reason) {
    case "clean":
      return `Clean after ${reviewCount(phase.reviews)}.`;
    case "needs_human":
      return `Review ${phase.reviews} of ${REVIEW_LOOP_MAX_REVIEWS} still has findings.`;
    case "stopped":
      return `Stopped after ${reviewCount(phase.reviews)}.`;
    case "review_stopped":
      return `Review ${phase.reviews + 1} stopped${why}.`;
    case "review_failed":
      return `Review ${phase.reviews + 1} failed${why}.`;
    case "fix_stopped":
      return `Fix ${phase.reviews} stopped${why}.`;
    case "fix_failed":
      return `Fix ${phase.reviews} failed${why}.`;
    case "pr_merged":
      return "The pull request was merged.";
    case "pr_closed":
      return "The pull request was closed.";
    case "aborted":
      return `The loop stopped on an error${why}.`;
  }
}

function authorChip(
  phase: ReviewLoopPhase,
  reviewerLabel: string,
): Pick<ReviewLoopChip, "tone" | "label" | "detail"> {
  switch (phase.status) {
    case "reviewing":
      return {
        tone: "working",
        label: `Review ${phase.round}/${REVIEW_LOOP_MAX_REVIEWS}`,
        detail: `${reviewerLabel} is on review ${phase.round} of ${REVIEW_LOOP_MAX_REVIEWS}.`,
      };
    case "fixing":
      return {
        tone: "working",
        label: `Fix ${phase.round}/${REVIEW_LOOP_MAX_FIXES}`,
        detail: `This thread's agent is working on review ${phase.round}.`,
      };
    case "ended":
      return { ...OUTCOME_CHIP[reviewLoopOutcome(phase.reason)], detail: endedDetail(phase) };
  }
}

function reviewerDetail(phase: ReviewLoopPhase): string {
  switch (phase.status) {
    case "reviewing":
      return `This thread is on review ${phase.round} of ${REVIEW_LOOP_MAX_REVIEWS}.`;
    case "fixing":
      return `The author's agent is working on review ${phase.round}.`;
    case "ended":
      return endedDetail(phase);
  }
}

/**
 * The chip for one link's review loop, or null when it has none. A reviewer marker holds no
 * phase, so the review thread's chip reads it from the source thread's shell when the client
 * has it.
 */
export function reviewLoopChip(input: {
  readonly link: Pick<ThreadPullRequestLink, "reviewLoop" | "number">;
  readonly sourceShell?: Pick<OrchestrationV2ThreadShell, "title" | "pullRequests"> | null;
  /** The review thread's model, such as "Cursor · composer-1". */
  readonly reviewerLabel: string | null;
}): ReviewLoopChip | null {
  const loop = input.link.reviewLoop;
  if (loop === undefined) return null;
  if (loop.role === "author") {
    return {
      ...authorChip(loop.phase, input.reviewerLabel ?? "The reviewer"),
      loopId: loop.id,
      live: isLiveReviewLoopPhase(loop.phase),
      otherThreadId: loop.reviewThreadId,
      role: "author",
    };
  }
  const sourceLoop = input.sourceShell?.pullRequests?.find(
    (link) => link.reviewLoop?.id === loop.id,
  )?.reviewLoop;
  const sourcePhase = sourceLoop?.role === "author" ? sourceLoop.phase : undefined;
  const about = `Reviews #${input.link.number}${
    input.sourceShell == null ? "" : ` for "${input.sourceShell.title}"`
  }.`;
  return {
    tone:
      sourcePhase === undefined || isLiveReviewLoopPhase(sourcePhase)
        ? "working"
        : OUTCOME_CHIP[reviewLoopOutcome(sourcePhase.reason)].tone,
    label: "Reviewer",
    detail: sourcePhase === undefined ? about : `${about} ${reviewerDetail(sourcePhase)}`,
    loopId: loop.id,
    live: sourcePhase === undefined || isLiveReviewLoopPhase(sourcePhase),
    otherThreadId: loop.sourceThreadId,
    role: "reviewer",
  };
}
