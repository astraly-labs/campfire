import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ThreadShell,
  ReviewLoopBudget,
  ReviewLoopEndedPhase,
  ReviewLoopEndReason,
  ReviewLoopFixingPhase,
  ReviewLoopId,
  ReviewLoopLivePhase,
  ReviewLoopPhase,
  ReviewLoopReviewingPhase,
  ThreadId,
  ThreadPullRequestLink,
  ThreadPullRequestReviewLoop,
  ThreadPullRequestReviewLoopAuthor,
  ThreadPullRequestReviewLoopReviewer,
} from "@t3tools/contracts";

function isLiveReviewLoopPhase(phase: ReviewLoopPhase): phase is ReviewLoopLivePhase {
  return phase.status !== "ended";
}

export type ReviewLoopPhaseKey =
  | "scoping"
  | `reviewing-${ReviewLoopReviewingPhase["round"]}`
  | `fixing-${ReviewLoopFixingPhase["round"]}`
  | "ended";

/**
 * The phase part of the ids a loop derives. A changed key orphans the loops in flight. The budget
 * is not in the key: a loop meets each key once, because only the step out of review 3 changes it.
 */
export function reviewLoopPhaseKey(phase: ReviewLoopPhase): ReviewLoopPhaseKey {
  switch (phase.status) {
    case "scoping":
      return "scoping";
    case "reviewing":
      return `reviewing-${phase.round}`;
    case "fixing":
      return `fixing-${phase.round}`;
    case "ended":
      return "ended";
  }
}

export type ReviewLoopOutcome =
  | "approved"
  | "needs_human"
  | "stopped"
  | "failed"
  | "merged"
  | "closed";

const OUTCOME_BY_REASON = {
  approved: "approved",
  budget_ended: "needs_human",
  stuck: "needs_human",
  stopped: "stopped",
  review_stopped: "stopped",
  author_stopped: "stopped",
  review_failed: "failed",
  author_failed: "failed",
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
 * waiting while the author writes the brief or answers a review.
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
            ? `Waiting for review ${author.phase.round} of ${author.phase.budget} on pull request #${link.number}`
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
          description: `Waiting for the author on pull request #${link.number}`,
          kind: "monitor",
        },
      ];
}

export interface ReviewLoopChip {
  readonly tone: "working" | "success" | "warning" | "muted" | "error";
  readonly label: string;
  readonly detail: string;
  readonly loopId: ReviewLoopId;
  readonly live: boolean;
  /** The review thread for an author record, the source thread for a reviewer marker. */
  readonly otherThreadId: ThreadId;
  readonly role: ThreadPullRequestReviewLoop["role"];
}

const OUTCOME_CHIP = {
  approved: { tone: "success", label: "Approved" },
  needs_human: { tone: "warning", label: "Needs you" },
  stopped: { tone: "muted", label: "Stopped" },
  failed: { tone: "error", label: "Failed" },
  merged: { tone: "muted", label: "Merged" },
  closed: { tone: "muted", label: "Closed" },
} satisfies Record<ReviewLoopOutcome, Pick<ReviewLoopChip, "tone" | "label">>;

/** The last review of a budget has no fix. */
const MAX_FIXES = { 3: 2, 5: 4 } as const satisfies Record<ReviewLoopBudget, number>;

function reviewCount(reviews: number): string {
  return reviews === 1 ? "1 review" : `${reviews} reviews`;
}

function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** The brief is the author's turn before review 1. Every later author turn answers a review. */
function authorTurn(reviews: ReviewLoopEndedPhase["reviews"]): string {
  return reviews === 0 ? "The brief" : `Fix ${reviews}`;
}

function endedDetail(phase: ReviewLoopEndedPhase): string {
  const why = phase.detail === undefined ? "" : `: ${phase.detail}`;
  switch (phase.reason) {
    case "approved":
      return `Approved at review ${phase.reviews} of ${phase.budget}.${
        phase.detail === undefined ? "" : ` Not pushed: ${phase.detail}.`
      }`;
    case "budget_ended":
      return `No approval after ${phase.reviews} of ${phase.budget} reviews.${
        phase.detail === undefined ? "" : ` ${sentence(phase.detail)}`
      }`;
    case "stuck":
      return phase.detail === undefined
        ? `A finding stays disputed after review ${phase.reviews}.`
        : `${phase.detail} ${phase.detail.includes(",") ? "stay" : "stays"} disputed after review ${phase.reviews}.`;
    case "stopped":
      return `Stopped after ${reviewCount(phase.reviews)}.`;
    case "review_stopped":
      return `Review ${phase.reviews + 1} stopped${why}.`;
    case "review_failed":
      return `Review ${phase.reviews + 1} failed${why}.`;
    case "author_stopped":
      return `${authorTurn(phase.reviews)} stopped${why}.`;
    case "author_failed":
      return `${authorTurn(phase.reviews)} failed${why}.`;
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
    case "scoping":
      return {
        tone: "working",
        label: "Brief",
        detail: "This thread's agent is writing the review brief.",
      };
    case "reviewing":
      return {
        tone: "working",
        label: `Review ${phase.round}/${phase.budget}`,
        detail: `${reviewerLabel} is on review ${phase.round} of ${phase.budget}.`,
      };
    case "fixing": {
      const blocking = phase.open.filter((finding) => finding.severity !== "nit");
      return {
        tone: "working",
        label: `Fix ${phase.round}/${MAX_FIXES[phase.budget]}`,
        detail: `This thread's agent is answering review ${phase.round}.${
          blocking.length === 0
            ? ""
            : ` Open: ${blocking.map((finding) => `${finding.id} [${finding.severity}]`).join(", ")}.`
        }`,
      };
    }
    case "ended":
      return { ...OUTCOME_CHIP[reviewLoopOutcome(phase.reason)], detail: endedDetail(phase) };
  }
}

function reviewerDetail(phase: ReviewLoopPhase): string {
  switch (phase.status) {
    case "scoping":
      return "The author's agent is writing the review brief.";
    case "reviewing":
      return `This thread is on review ${phase.round} of ${phase.budget}.`;
    case "fixing":
      return `The author's agent is answering review ${phase.round}.`;
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
