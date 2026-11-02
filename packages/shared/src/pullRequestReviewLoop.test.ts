import { describe, expect, it } from "vite-plus/test";
import type { ReviewLoopEndedPhase, ReviewLoopPhase } from "@t3tools/contracts";
import { ReviewLoopId, ThreadId } from "@t3tools/contracts";

import {
  defaultReviewLoopPrompt,
  liveAuthorLoop,
  reviewerMarker,
  reviewLoopChip,
  reviewLoopOutcome,
  reviewLoopPhaseKey,
  reviewsFinishedBefore,
} from "./pullRequestReviewLoop.ts";

const at = "2026-10-05T00:00:00.000Z";
const loopId = ReviewLoopId.make("loop-1");
const sourceThreadId = ThreadId.make("thread:source");
const reviewThreadId = ThreadId.make("thread:review");
const author = (phase: ReviewLoopPhase) => ({
  role: "author" as const,
  id: loopId,
  reviewThreadId,
  prompt: "/review #7",
  startedAt: at,
  phase,
});
const reviewer = { role: "reviewer" as const, id: loopId, sourceThreadId };
const ended = (
  reason: ReviewLoopEndedPhase["reason"],
  reviews: ReviewLoopEndedPhase["reviews"],
  detail?: string,
): ReviewLoopEndedPhase => ({
  status: "ended",
  reason,
  reviews,
  ...(detail === undefined ? {} : { detail }),
  endedAt: at,
});

describe("defaultReviewLoopPrompt", () => {
  it("asks for a review of the pull request by number", () => {
    expect(defaultReviewLoopPrompt(42)).toBe("/review #42");
  });
});

describe("loop phases", () => {
  it.each([
    [{ status: "reviewing", round: 1 }, "reviewing-1", 0],
    [{ status: "fixing", round: 1 }, "fixing-1", 1],
    [{ status: "reviewing", round: 2 }, "reviewing-2", 1],
    [{ status: "fixing", round: 2 }, "fixing-2", 2],
    [{ status: "reviewing", round: 3 }, "reviewing-3", 2],
  ] as const)("%o is keyed %s and follows %s finished reviews", (phase, key, reviews) => {
    expect(reviewLoopPhaseKey(phase)).toBe(key);
    expect(reviewsFinishedBefore(phase)).toBe(reviews);
  });

  it("keys every ended phase the same", () => {
    expect(reviewLoopPhaseKey(ended("clean", 1))).toBe("ended");
    expect(reviewLoopPhaseKey(ended("stopped", 0))).toBe("ended");
  });
});

describe("reviewLoopOutcome", () => {
  it.each([
    ["clean", "clean"],
    ["needs_human", "needs_human"],
    ["stopped", "stopped"],
    ["review_stopped", "stopped"],
    ["fix_stopped", "stopped"],
    ["review_failed", "failed"],
    ["fix_failed", "failed"],
    ["aborted", "failed"],
    ["pr_merged", "merged"],
    ["pr_closed", "closed"],
  ] as const)("%s shows as %s", (reason, outcome) => {
    expect(reviewLoopOutcome(reason)).toBe(outcome);
  });
});

describe("liveAuthorLoop and reviewerMarker", () => {
  it("finds a live author loop, but not an ended one", () => {
    const live = author({ status: "fixing", round: 1 });
    expect(liveAuthorLoop({ reviewLoop: live })).toBe(live);
    expect(liveAuthorLoop({ reviewLoop: author(ended("clean", 2)) })).toBeUndefined();
    expect(liveAuthorLoop({ reviewLoop: reviewer })).toBeUndefined();
    expect(liveAuthorLoop({})).toBeUndefined();
  });

  it("finds a reviewer marker only on the review thread's link", () => {
    expect(reviewerMarker({ reviewLoop: reviewer })).toBe(reviewer);
    expect(
      reviewerMarker({ reviewLoop: author({ status: "reviewing", round: 1 }) }),
    ).toBeUndefined();
    expect(reviewerMarker({})).toBeUndefined();
  });
});

describe("reviewLoopChip", () => {
  const chipFor = (phase: ReviewLoopPhase) =>
    reviewLoopChip({
      link: { number: 7, reviewLoop: author(phase) },
      reviewerLabel: "Cursor · composer-1",
    });

  it("shows nothing for a link without a loop", () => {
    expect(reviewLoopChip({ link: { number: 7 }, reviewerLabel: null })).toBeNull();
  });

  it.each([
    [{ status: "reviewing", round: 2 }, "Review 2/3", "Cursor · composer-1 is on review 2 of 3."],
    [{ status: "fixing", round: 1 }, "Fix 1/2", "This thread's agent is working on review 1."],
  ] as const)("shows the live phase %o as %s", (phase, label, detail) => {
    expect(chipFor(phase)).toEqual({
      tone: "working",
      label,
      detail,
      loopId,
      live: true,
      otherThreadId: reviewThreadId,
      role: "author",
    });
  });

  it.each([
    [ended("clean", 2), "success", "Clean", "Clean after 2 reviews."],
    [ended("needs_human", 3), "warning", "Needs you", "Review 3 of 3 still has findings."],
    [ended("stopped", 1), "muted", "Stopped", "Stopped after 1 review."],
    [
      ended("review_stopped", 0, "the review thread was archived"),
      "muted",
      "Stopped",
      "Review 1 stopped: the review thread was archived.",
    ],
    [
      ended("review_failed", 1, "rate limited"),
      "error",
      "Failed",
      "Review 2 failed: rate limited.",
    ],
    [ended("fix_stopped", 2), "muted", "Stopped", "Fix 2 stopped."],
    [ended("fix_failed", 1, "rate limited"), "error", "Failed", "Fix 1 failed: rate limited."],
    [ended("pr_merged", 1), "muted", "Merged", "The pull request was merged."],
    [ended("pr_closed", 0), "muted", "Closed", "The pull request was closed."],
    [
      ended("aborted", 1, "the awaited message is gone"),
      "error",
      "Failed",
      "The loop stopped on an error: the awaited message is gone.",
    ],
  ] as const)("shows %o as %s %s", (phase, tone, label, detail) => {
    expect(chipFor(phase)).toMatchObject({ tone, label, detail, live: false });
  });

  it("shows a reviewer marker with the phase from the source thread", () => {
    const chip = (phase: ReviewLoopPhase) =>
      reviewLoopChip({
        link: { number: 7, reviewLoop: reviewer },
        sourceShell: {
          title: "Fix login",
          pullRequests: [
            {
              host: "github.com",
              repository: "acme/app",
              number: 7,
              url: "https://github.com/acme/app/pull/7",
              source: "agent",
              linkedAt: at,
              snapshot: null,
              stack: null,
              reviewLoop: author(phase),
            },
          ],
        },
        reviewerLabel: null,
      });

    expect(chip({ status: "fixing", round: 2 })).toEqual({
      tone: "working",
      label: "Reviewer",
      detail: `Reviews #7 for "Fix login". The author's agent is working on review 2.`,
      loopId,
      live: true,
      otherThreadId: sourceThreadId,
      role: "reviewer",
    });
    expect(chip({ status: "reviewing", round: 3 })?.detail).toBe(
      `Reviews #7 for "Fix login". This thread is on review 3 of 3.`,
    );
    expect(chip(ended("clean", 3))).toMatchObject({ tone: "success", live: false });
  });

  it("shows a reviewer marker as live while the source thread is not loaded", () => {
    expect(
      reviewLoopChip({ link: { number: 7, reviewLoop: reviewer }, reviewerLabel: null }),
    ).toMatchObject({ tone: "working", label: "Reviewer", detail: "Reviews #7.", live: true });
  });
});
