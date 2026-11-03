import { describe, expect, it } from "vite-plus/test";
import type {
  ReviewLoopBudget,
  ReviewLoopEndedPhase,
  ReviewLoopFindingSeverity,
  ReviewLoopPhase,
} from "@t3tools/contracts";
import { ReviewLoopFindingId, ReviewLoopId, ThreadId } from "@t3tools/contracts";

import {
  liveAuthorLoop,
  reviewerMarker,
  reviewLoopChip,
  reviewLoopMonitorTasks,
  reviewLoopOutcome,
  reviewLoopPhaseKey,
} from "./pullRequestReviewLoop.ts";

const at = "2026-10-05T00:00:00.000Z";
const loopId = ReviewLoopId.make("loop-1");
const sourceThreadId = ThreadId.make("thread:source");
const reviewThreadId = ThreadId.make("thread:review");
const author = (phase: ReviewLoopPhase) => ({
  role: "author" as const,
  id: loopId,
  reviewThreadId,
  startedAt: at,
  phase,
});
const reviewer = { role: "reviewer" as const, id: loopId, sourceThreadId };
const ref = (id: string, severity: ReviewLoopFindingSeverity) => ({
  id: ReviewLoopFindingId.make(id),
  severity,
});
const ended = (
  reason: ReviewLoopEndedPhase["reason"],
  reviews: ReviewLoopEndedPhase["reviews"],
  budget: ReviewLoopBudget = 3,
  detail?: string,
): ReviewLoopEndedPhase => ({
  status: "ended",
  reason,
  reviews,
  budget,
  ...(detail === undefined ? {} : { detail }),
  endedAt: at,
});

describe("reviewLoopPhaseKey", () => {
  it.each([
    [{ status: "scoping", budget: 3 }, "scoping"],
    [{ status: "reviewing", budget: 3, round: 1 }, "reviewing-1"],
    [{ status: "fixing", budget: 3, round: 2, open: [] }, "fixing-2"],
    [{ status: "reviewing", budget: 5, round: 3 }, "reviewing-3"],
    [{ status: "fixing", budget: 5, round: 3, open: [] }, "fixing-3"],
    [{ status: "reviewing", budget: 5, round: 4 }, "reviewing-4"],
  ] as const)("keys %o as %s, whatever its budget", (phase, key) => {
    expect(reviewLoopPhaseKey(phase)).toBe(key);
  });

  it("keys every ended phase the same", () => {
    expect(reviewLoopPhaseKey(ended("approved", 1))).toBe("ended");
    expect(reviewLoopPhaseKey(ended("stopped", 0, 5))).toBe("ended");
  });
});

describe("reviewLoopOutcome", () => {
  it.each([
    ["approved", "approved"],
    ["budget_ended", "needs_human"],
    ["stuck", "needs_human"],
    ["stopped", "stopped"],
    ["review_stopped", "stopped"],
    ["author_stopped", "stopped"],
    ["review_failed", "failed"],
    ["author_failed", "failed"],
    ["aborted", "failed"],
    ["pr_merged", "merged"],
    ["pr_closed", "closed"],
  ] as const)("%s shows as %s", (reason, outcome) => {
    expect(reviewLoopOutcome(reason)).toBe(outcome);
  });
});

describe("liveAuthorLoop and reviewerMarker", () => {
  it("finds a live author loop, the brief included, but not an ended one", () => {
    const live = author({ status: "fixing", budget: 3, round: 1, open: [] });
    const briefing = author({ status: "scoping", budget: 5 });
    expect(liveAuthorLoop({ reviewLoop: live })).toBe(live);
    expect(liveAuthorLoop({ reviewLoop: briefing })).toBe(briefing);
    expect(liveAuthorLoop({ reviewLoop: author(ended("approved", 2)) })).toBeUndefined();
    expect(liveAuthorLoop({ reviewLoop: reviewer })).toBeUndefined();
    expect(liveAuthorLoop({})).toBeUndefined();
  });

  it("finds a reviewer marker only on the review thread's link", () => {
    expect(reviewerMarker({ reviewLoop: reviewer })).toBe(reviewer);
    expect(
      reviewerMarker({ reviewLoop: author({ status: "reviewing", budget: 3, round: 1 }) }),
    ).toBeUndefined();
    expect(reviewerMarker({})).toBeUndefined();
  });
});

describe("reviewLoopMonitorTasks", () => {
  const link = (reviewLoop: Parameters<typeof reviewLoopMonitorTasks>[0]["reviewLoop"]) => ({
    number: 7,
    source: "agent" as const,
    reviewLoop,
  });

  it.each([
    [{ status: "reviewing", budget: 5, round: 2 }, "Waiting for review 2 of 5 on pull request #7"],
    [{ status: "reviewing", budget: 3, round: 3 }, "Waiting for review 3 of 3 on pull request #7"],
    [{ status: "scoping", budget: 3 }, "Review loop on pull request #7"],
    [{ status: "fixing", budget: 5, round: 3, open: [] }, "Review loop on pull request #7"],
  ] as const)("holds the source thread in %o with %s", (phase, description) => {
    expect(reviewLoopMonitorTasks(link(author(phase))).map((task) => task.description)).toEqual([
      description,
    ]);
  });

  it("holds the review thread while the author works", () => {
    expect(reviewLoopMonitorTasks(link(reviewer)).map((task) => task.description)).toEqual([
      "Waiting for the author on pull request #7",
    ]);
  });
});

describe("reviewLoopChip", () => {
  const chipFor = (phase: ReviewLoopPhase) =>
    reviewLoopChip({
      link: { number: 7, reviewLoop: author(phase) },
      reviewerLabel: "Codex · GPT-6.1-Sol",
    });

  it("shows nothing for a link without a loop", () => {
    expect(reviewLoopChip({ link: { number: 7 }, reviewerLabel: null })).toBeNull();
  });

  it.each([
    [{ status: "scoping", budget: 3 }, "Brief", "This thread's agent is writing the review brief."],
    [
      { status: "reviewing", budget: 3, round: 2 },
      "Review 2/3",
      "Codex · GPT-6.1-Sol is on review 2 of 3.",
    ],
    [
      { status: "reviewing", budget: 5, round: 5 },
      "Review 5/5",
      "Codex · GPT-6.1-Sol is on review 5 of 5.",
    ],
    [
      { status: "fixing", budget: 3, round: 1, open: [] },
      "Fix 1/2",
      "This thread's agent is answering review 1.",
    ],
    [
      { status: "fixing", budget: 3, round: 2, open: [ref("S3", "nit")] },
      "Fix 2/2",
      "This thread's agent is answering review 2.",
    ],
    [
      {
        status: "fixing",
        budget: 5,
        round: 3,
        open: [ref("S1", "blocker"), ref("S2", "should"), ref("S4", "nit"), ref("S5", "unknown")],
      },
      "Fix 3/4",
      "This thread's agent is answering review 3. Open: S1 [blocker], S2 [should], S5 [unknown].",
    ],
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
    [ended("approved", 2), "success", "Approved", "Approved at review 2 of 3."],
    [
      ended("approved", 2, 3, "this thread's provider is off"),
      "success",
      "Approved",
      "Approved at review 2 of 3. Not pushed: this thread's provider is off.",
    ],
    [ended("budget_ended", 3), "warning", "Needs you", "No approval after 3 of 3 reviews."],
    [ended("budget_ended", 5, 5), "warning", "Needs you", "No approval after 5 of 5 reviews."],
    [
      ended("budget_ended", 3, 3, "this thread's provider is off"),
      "warning",
      "Needs you",
      "No approval after 3 of 3 reviews. This thread's provider is off.",
    ],
    [ended("stuck", 2, 3, "S2"), "warning", "Needs you", "S2 stays disputed after review 2."],
    [
      ended("stuck", 3, 5, "S2, S7"),
      "warning",
      "Needs you",
      "S2, S7 stay disputed after review 3.",
    ],
    [ended("stopped", 1), "muted", "Stopped", "Stopped after 1 review."],
    [ended("stopped", 0), "muted", "Stopped", "Stopped after 0 reviews."],
    [
      ended("review_stopped", 1, 3, "the review thread was archived"),
      "muted",
      "Stopped",
      "Review 2 stopped: the review thread was archived.",
    ],
    [
      ended("review_failed", 1, 3, "rate limited"),
      "error",
      "Failed",
      "Review 2 failed: rate limited.",
    ],
    [ended("author_stopped", 0), "muted", "Stopped", "The brief stopped."],
    [ended("author_stopped", 1), "muted", "Stopped", "Fix 1 stopped."],
    [
      ended("author_failed", 0, 3, "rate limited"),
      "error",
      "Failed",
      "The brief failed: rate limited.",
    ],
    [
      ended("author_failed", 2, 3, "rate limited"),
      "error",
      "Failed",
      "Fix 2 failed: rate limited.",
    ],
    [ended("pr_merged", 1), "muted", "Merged", "The pull request was merged."],
    [ended("pr_closed", 0), "muted", "Closed", "The pull request was closed."],
    [
      ended("aborted", 1, 3, "the awaited message is gone"),
      "error",
      "Failed",
      "The loop stopped on an error: the awaited message is gone.",
    ],
  ] as const)("shows %o as %s %s", (phase, tone, label, detail) => {
    expect(chipFor(phase)).toMatchObject({ tone, label, detail, live: false });
  });

  it("shows a reviewer marker with the phase and budget from the source thread", () => {
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

    expect(chip({ status: "fixing", budget: 3, round: 2, open: [] })).toEqual({
      tone: "working",
      label: "Reviewer",
      detail: `Reviews #7 for "Fix login". The author's agent is answering review 2.`,
      loopId,
      live: true,
      otherThreadId: sourceThreadId,
      role: "reviewer",
    });
    expect(chip({ status: "scoping", budget: 3 })?.detail).toBe(
      `Reviews #7 for "Fix login". The author's agent is writing the review brief.`,
    );
    expect(chip({ status: "reviewing", budget: 5, round: 4 })?.detail).toBe(
      `Reviews #7 for "Fix login". This thread is on review 4 of 5.`,
    );
    expect(chip(ended("approved", 3))).toMatchObject({ tone: "success", live: false });
    expect(chip(ended("stuck", 2, 3, "S2"))).toMatchObject({ tone: "warning", live: false });
  });

  it("shows a reviewer marker as live while the source thread is not loaded", () => {
    expect(
      reviewLoopChip({ link: { number: 7, reviewLoop: reviewer }, reviewerLabel: null }),
    ).toMatchObject({ tone: "working", label: "Reviewer", detail: "Reviews #7.", live: true });
  });
});
