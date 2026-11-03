import type {
  ReviewLoopBudget,
  ReviewLoopEndedPhase,
  ReviewLoopFindingRef,
  ReviewLoopFindingSeverity,
  ReviewLoopFixingPhase,
  ReviewLoopLivePhase,
  ReviewLoopPhase,
  ReviewLoopReviewingPhase,
  ReviewLoopScopingPhase,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ReviewLoopFindingId,
  ReviewLoopId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  awaitedThread,
  carryLinkAutomation,
  decideReviewLoop,
  endedReviewLoopPhase,
  endLinkAutomation,
  isReviewLoopStep,
  makeReviewThread,
  readAuthorReply,
  readReview,
  reviewLoopStepProgress,
  reviewLoopSuccessor,
  reviewRequestText,
  scopingRequestText,
  withoutReviewLoop,
  type ReviewLoopDecision,
  type ReviewLoopFacts,
  type ReviewLoopStepProgress,
  type ReviewLoopStepRecords,
} from "./pullRequestReviewLoop.ts";

const isAppThread = Schema.is(OrchestrationV2AppThread);
const NOW = "2026-10-05T12:00:00.000Z";
const at = (minute: number) =>
  DateTime.makeUnsafe(`2026-10-05T12:${String(minute).padStart(2, "0")}:00.000Z`);
const loopId = ReviewLoopId.make("review-loop:1");
const sourceThreadId = ThreadId.make("thread:source");
const reviewThreadId = ThreadId.make("thread:review");
const pullRequest = {
  number: 42,
  url: "https://github.com/acme/app/pull/42",
  branch: "feature/session-retry",
  baseBranch: "main",
  state: "open",
} as const;

const ref = (id: string, severity: ReviewLoopFindingSeverity): ReviewLoopFindingRef => ({
  id: ReviewLoopFindingId.make(id),
  severity,
});
const scoping = (budget: ReviewLoopBudget): ReviewLoopScopingPhase => ({
  status: "scoping",
  budget,
});
const of3 = {
  reviewing: (round: 1 | 2 | 3): ReviewLoopReviewingPhase => ({
    status: "reviewing",
    budget: 3,
    round,
  }),
  fixing: (
    round: 1 | 2,
    open: ReadonlyArray<ReviewLoopFindingRef> = [],
  ): ReviewLoopFixingPhase => ({
    status: "fixing",
    budget: 3,
    round,
    open,
  }),
};
const of5 = {
  reviewing: (round: 1 | 2 | 3 | 4 | 5): ReviewLoopReviewingPhase => ({
    status: "reviewing",
    budget: 5,
    round,
  }),
  fixing: (
    round: 1 | 2 | 3 | 4,
    open: ReadonlyArray<ReviewLoopFindingRef> = [],
  ): ReviewLoopFixingPhase => ({ status: "fixing", budget: 5, round, open }),
};
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
  endedAt: NOW,
});
const authorLoop = (phase: ReviewLoopPhase, note?: string) => ({
  role: "author" as const,
  id: loopId,
  reviewThreadId,
  ...(note === undefined ? {} : { note }),
  startedAt: NOW,
  phase,
});
const marker = { role: "reviewer" as const, id: loopId, sourceThreadId };

const describePhase = (phase: ReviewLoopPhase): string => {
  switch (phase.status) {
    case "scoping":
      return `scoping/${phase.budget}`;
    case "reviewing":
    case "fixing":
      return `${phase.status} ${phase.round}/${phase.budget}`;
    case "ended":
      return `ended ${phase.reason} after ${phase.reviews} of ${phase.budget}`;
  }
};

const readingOf = (text: string): string => {
  const reading = readReview(text);
  if (reading.kind === "approved") return `approved, nits [${reading.nits.join(", ")}]`;
  const open = reading.open.map((finding) =>
    [finding.id, finding.severity, finding.area].filter((part) => part !== null).join(" "),
  );
  return `changes (${reading.verdict}), open [${open.join(", ")}], nits [${reading.nits.join(", ")}]`;
};

const BRIEF = [
  "Base: 4f1c2ab",
  "Intent: Keep the session token when one refresh fails.",
  "Out of scope: login page styles.",
  "Checks: vp test run src/auth/session.test.ts passed.",
  "Diff: 3 files changed, 48 insertions(+), 9 deletions(-)",
].join("\n");
const LEDGER = [
  "fixed: S1 src/auth/session.ts:58 keeps the token after one failed refresh.",
  "declined: S2 nit, follow-up.",
  "Changed: commit 9e0d1f7. Diff: 3 files changed, 61 insertions(+), 9 deletions(-)",
].join("\n");
const NOTE = "Look hard at the retry path.";

const APPROVED_WITH_NIT =
  "VERDICT: APPROVE\nS1 [nit] src/auth/session.ts:40 rename retryOnce. Fix: call it refreshWithRetry.";
const APPROVED_RESOLVED = "VERDICT: APPROVE\nS1 resolved\nS2 resolved";
const CHANGES_BLOCKER =
  "VERDICT: CHANGES\nS1 [blocker] src/auth/session.ts:58 drops the token. Fix: keep it.\nS2 [nit] src/auth/session.ts:12 naming. Fix: rename.";
const CONTRADICTION = "VERDICT: APPROVE\nS2 [should] src/cache.ts:9 is shared. Fix: scope it.";
const NO_VERDICT = "S1 [should] src/auth/session.ts:58 drops the token. Fix: keep it.";
const ONLY_NITS = "VERDICT: CHANGES\nS3 [nit] src/auth/session.ts:1 typo. Fix: fix it.";
const UNTAGGED = "VERDICT: CHANGES\nThe token is dropped on refresh in src/auth/session.ts:12.";
const CONCURRENCY =
  "VERDICT: CHANGES\nS7 [blocker] [concurrency] src/auth/session.ts:31 two tabs refresh at once. Fix: compare the token version.";
const AUTH_STILL_OPEN =
  "VERDICT: CHANGES\nS2 [should] [auth] still open: the retry skips the check.";
const AREA_ON_NIT = "VERDICT: CHANGES\nS7 [nit] [auth] src/auth/session.ts:3 naming. Fix: rename.";

describe("readReview", () => {
  it.each([
    ["R1 an approval", "VERDICT: APPROVE", "approved, nits []"],
    ["R2 an approval with a nit", APPROVED_WITH_NIT, "approved, nits [S1]"],
    ["R3 a blocker and a nit", CHANGES_BLOCKER, "changes (changes), open [S1 blocker], nits [S2]"],
    [
      "R4 APPROVE beside an open should",
      CONTRADICTION,
      "changes (approve), open [S2 should], nits []",
    ],
    ["R5 CHANGES with only nits", ONLY_NITS, "changes (changes), open [], nits [S3]"],
    [
      "R6 findings without a verdict line",
      NO_VERDICT,
      "changes (missing), open [S1 should], nits []",
    ],
    ["R7 empty text", "", "changes (missing), open [], nits []"],
    [
      "R8 both verdicts",
      "VERDICT: APPROVE\nVERDICT: CHANGES",
      "changes (changes), open [], nits []",
    ],
    [
      "R8 both verdicts, changes first",
      "VERDICT: CHANGES\nVERDICT: APPROVE",
      "changes (changes), open [], nits []",
    ],
    ["R9 a bold verdict with a period", "**Verdict:** Approve.", "approved, nits []"],
    ["R10 a verdict in a code fence", "```\n`VERDICT: APPROVE`\n```", "approved, nits []"],
    [
      "R11 an approval with a remark",
      "VERDICT: APPROVE (nits only)",
      "changes (changes), open [], nits []",
    ],
    ["R12 APPROVED", "VERDICT: APPROVED", "approved, nits []"],
    [
      "R13 APPROVE WITH CHANGES",
      "VERDICT: APPROVE WITH CHANGES",
      "changes (changes), open [], nits []",
    ],
    ["R14 a quoted verdict", "> VERDICT: APPROVE", "changes (missing), open [], nits []"],
    [
      "R15 a verdict mid-sentence",
      "I would write VERDICT: APPROVE here.",
      "changes (missing), open [], nits []",
    ],
    [
      "R16 a severity it cannot read",
      "VERDICT: APPROVE\nS1 [major] src/a.ts:1 drops it.",
      "changes (approve), open [S1 unknown], nits []",
    ],
    ["R17 resolved findings", APPROVED_RESOLVED, "approved, nits []"],
    [
      "R18 a should still open",
      "VERDICT: APPROVE\nS2 [should] still open: still racy",
      "changes (approve), open [S2 should], nits []",
    ],
    [
      "R19 still open without a severity",
      "VERDICT: APPROVE\nS2 still open: still racy",
      "changes (approve), open [S2 unknown], nits []",
    ],
    [
      "R20 resolved and still open",
      "VERDICT: CHANGES\nS1 resolved\nS1 [should] still open: the retry path",
      "changes (changes), open [S1 should], nits []",
    ],
    [
      "R21 a blocker with an area",
      CONCURRENCY,
      "changes (changes), open [S7 blocker concurrency], nits []",
    ],
    [
      "R22 an area in any case",
      "VERDICT: CHANGES\nS7 [should] [Data-Loss] src/a.ts:1 drops rows.",
      "changes (changes), open [S7 should data-loss], nits []",
    ],
    [
      "R23 an area that is not a risk area",
      "VERDICT: CHANGES\nS7 [should] [style] src/a.ts:1 hides a bug.",
      "changes (changes), open [S7 should], nits []",
    ],
    ["R24 an area on a nit", AREA_ON_NIT, "changes (changes), open [], nits [S7]"],
    [
      "R25 a still open should with an area",
      AUTH_STILL_OPEN,
      "changes (changes), open [S2 should auth], nits []",
    ],
    [
      "R26 a bullet and bold id",
      "VERDICT: CHANGES\n- **S1** [should] src/a.ts:3 drops it.",
      "changes (changes), open [S1 should], nits []",
    ],
    [
      "R27 a quoted old finding",
      "> S1 [should] src/a.ts:3 drops it.\nVERDICT: APPROVE\nS1 resolved",
      "approved, nits []",
    ],
    ["R28 findings without ids", UNTAGGED, "changes (changes), open [], nits []"],
    [
      "a numbered finding",
      "VERDICT: CHANGES\n1. S2 [blocker] src/a.ts:3 drops it.",
      "changes (changes), open [S2 blocker], nits []",
    ],
    ["a zero-padded id", "VERDICT: APPROVE\nS01 [nit] src/a.ts:3 rename.", "approved, nits [S1]"],
    [
      "a lowercase id and severity",
      "VERDICT: CHANGES\ns3 [Blocker] src/a.ts:3 drops it.",
      "changes (changes), open [S3 blocker], nits []",
    ],
    [
      "a severity with extra words",
      "VERDICT: APPROVE\nS1 [should fix] src/a.ts:3 drops it.",
      "changes (approve), open [S1 unknown], nits []",
    ],
    [
      "a severity before resolved",
      "VERDICT: APPROVE\nS1 [should] resolved: the test covers it.",
      "approved, nits []",
    ],
    [
      "a severity before unresolved",
      "VERDICT: CHANGES\nS1 [should] unresolved: still racy.",
      "changes (changes), open [S1 should], nits []",
    ],
    [
      "the strongest severity of an id",
      "VERDICT: CHANGES\nS1 [nit] src/a.ts:3 rename.\nS1 [blocker] src/a.ts:3 drops it.",
      "changes (changes), open [S1 blocker], nits []",
    ],
    [
      "ids in number order",
      "VERDICT: APPROVE\nS10 [nit] a.\nS2 [nit] b.",
      "approved, nits [S2, S10]",
    ],
  ] as const)("%s", (_case, text, reading) => {
    assert.strictEqual(readingOf(text), reading);
  });
});

describe("readAuthorReply", () => {
  const stuckIds = (text: string) => {
    const reply = readAuthorReply(text);
    return reply.kind === "continue" ? "continue" : `stuck [${reply.ids.join(", ")}]`;
  };

  it.each([
    ["A1 a ledger", LEDGER, "continue"],
    ["A2 a ledger, then the stuck line", `${LEDGER}\nLOOP: STUCK S2`, "stuck [S2]"],
    ["A3 two ids", "LOOP: STUCK S2, S5", "stuck [S2, S5]"],
    ["A4 a bold stuck line", "**LOOP: STUCK S2**", "stuck [S2]"],
    ["A5 lowercase with a period", "loop: stuck s2.", "stuck [S2]"],
    ["A6 no ids", "LOOP: STUCK", "continue"],
    ["A7 the line mid-sentence", "I could write LOOP: STUCK S2, but I fixed it.", "continue"],
    ["A8 a quoted stuck line", "> LOOP: STUCK S2", "continue"],
    [
      "A9 a dispute alone",
      "disagree: S2 the cache is created per request in src/cache.ts:8.",
      "continue",
    ],
    ["words after the ids", "LOOP: STUCK S2 (the ids)", "continue"],
  ] as const)("%s reads as %s", (_case, text, reading) => {
    assert.strictEqual(stuckIds(text), reading);
  });
});

describe("the state machine", () => {
  const live: ReadonlyArray<ReviewLoopLivePhase> = [
    scoping(3),
    of3.reviewing(1),
    of3.fixing(1),
    of3.reviewing(2),
    of3.fixing(2),
    of3.reviewing(3),
    scoping(5),
    of5.reviewing(1),
    of5.fixing(1),
    of5.reviewing(2),
    of5.fixing(2),
    of5.reviewing(3),
    of5.fixing(3),
    of5.reviewing(4),
    of5.fixing(4),
    of5.reviewing(5),
  ];
  const forward = new Set([
    "scoping/3 -> reviewing 1/3",
    "reviewing 1/3 -> fixing 1/3",
    "fixing 1/3 -> reviewing 2/3",
    "reviewing 2/3 -> fixing 2/3",
    "fixing 2/3 -> reviewing 3/3",
    "reviewing 3/3 -> fixing 3/5",
    "scoping/5 -> reviewing 1/5",
    "reviewing 1/5 -> fixing 1/5",
    "fixing 1/5 -> reviewing 2/5",
    "reviewing 2/5 -> fixing 2/5",
    "fixing 2/5 -> reviewing 3/5",
    "reviewing 3/5 -> fixing 3/5",
    "fixing 3/5 -> reviewing 4/5",
    "reviewing 4/5 -> fixing 4/5",
    "fixing 4/5 -> reviewing 5/5",
  ]);

  it("allows only the forward steps, and an end that keeps the budget", () => {
    for (const from of live) {
      for (const to of [...live, ended("stopped", 0, 3), ended("stopped", 0, 5)]) {
        const step = `${describePhase(from)} -> ${describePhase(to)}`;
        const legal = to.status === "ended" ? to.budget === from.budget : forward.has(step);
        assert.strictEqual(isReviewLoopStep(from, to), legal, step);
      }
    }
  });

  it("cannot write down a review or a fix past the budget", () => {
    // @ts-expect-error A loop of 3 has no fourth review.
    const fourthOf3: ReviewLoopPhase = { status: "reviewing", budget: 3, round: 4 };
    // @ts-expect-error A loop of 3 has no third fix.
    const thirdFixOf3: ReviewLoopPhase = { status: "fixing", budget: 3, round: 3, open: [] };
    // @ts-expect-error A loop of 5 has no sixth review.
    const sixthOf5: ReviewLoopPhase = { status: "reviewing", budget: 5, round: 6 };

    assert.isFalse(isReviewLoopStep(of3.fixing(2), fourthOf3));
    assert.isFalse(isReviewLoopStep(of3.reviewing(3), thirdFixOf3));
    assert.isFalse(isReviewLoopStep(of5.fixing(4), sixthOf5));
  });

  it("steps forward, and only review 3 of 3 extends", () => {
    const open = [ref("S7", "blocker")];
    assert.deepStrictEqual(reviewLoopSuccessor(scoping(5)), of5.reviewing(1));
    assert.deepStrictEqual(reviewLoopSuccessor(of5.fixing(4)), of5.reviewing(5));
    assert.deepStrictEqual(reviewLoopSuccessor(of3.reviewing(2), true, open), of3.fixing(2, open));
    assert.deepStrictEqual(reviewLoopSuccessor(of3.reviewing(3), true, open), of5.fixing(3, open));
    assert.isNull(reviewLoopSuccessor(of3.reviewing(3), false, open));
    assert.isNull(reviewLoopSuccessor(of5.reviewing(5), true, open));
  });

  it.each([
    [scoping(3), "stopped", 0],
    [scoping(3), "author_failed", 0],
    [of3.reviewing(2), "approved", 2],
    [of3.reviewing(3), "budget_ended", 3],
    [of3.reviewing(2), "review_failed", 1],
    [of3.reviewing(2), "author_failed", 2],
    [of3.reviewing(2), "stopped", 1],
    [of3.fixing(2), "stuck", 2],
    [of5.fixing(3), "author_stopped", 3],
    [of5.reviewing(4), "pr_merged", 3],
  ] as const)("ends %o as %s after %s reviews, in its budget", (from, reason, reviews) => {
    assert.deepStrictEqual(
      endedReviewLoopPhase(from, reason, NOW),
      ended(reason, reviews, from.budget),
    );
  });

  it("keeps the first line of an end's detail, without its period, cut at 200 characters", () => {
    assert.strictEqual(
      endedReviewLoopPhase(of3.reviewing(1), "review_failed", NOW, "rate limited.\nretry").detail,
      "rate limited",
    );
    assert.strictEqual(
      endedReviewLoopPhase(of3.reviewing(1), "review_failed", NOW, "x".repeat(300)).detail,
      `${"x".repeat(197)}...`,
    );
    assert.notProperty(
      endedReviewLoopPhase(of3.reviewing(1), "review_failed", NOW, "  "),
      "detail",
    );
  });
});

describe("awaitedThread", () => {
  it("waits on the review thread while reviewing and on the source thread otherwise", () => {
    assert.strictEqual(
      awaitedThread({ reviewThreadId, phase: of3.reviewing(2) }, sourceThreadId),
      reviewThreadId,
    );
    assert.strictEqual(
      awaitedThread({ reviewThreadId, phase: of3.fixing(2) }, sourceThreadId),
      sourceThreadId,
    );
    assert.strictEqual(
      awaitedThread({ reviewThreadId, phase: scoping(3) }, sourceThreadId),
      sourceThreadId,
    );
  });
});

const settled = (status: "completed" | "failed" | "interrupted" | "cancelled" | "rolled_back") =>
  ({
    kind: "settled",
    run: { id: RunId.make("run:1"), ordinal: 1, status, startedAt: at(0), completedAt: at(1) },
  }) satisfies ReviewLoopStepProgress;

const SOL_REVIEWER = {
  status: "live",
  reviewerLabel: "Codex · gpt-6.1-sol",
  reviewerModel: "gpt-6.1-sol",
} as const;

const facts = (
  phase: ReviewLoopLivePhase,
  overrides: Partial<ReviewLoopFacts> & { readonly note?: string } = {},
): ReviewLoopFacts => {
  const { note, ...rest } = overrides;
  return {
    loop: { ...authorLoop(phase, note), phase },
    pullRequest,
    reviewThread: SOL_REVIEWER,
    progress: settled("completed"),
    resultText: null,
    now: NOW,
    ...rest,
  };
};

const outcomeOf = (decision: ReviewLoopDecision) =>
  decision.kind === "wait"
    ? "wait"
    : { to: describePhase(decision.to), post: decision.post?.target ?? "none" };

const postText = (decision: ReviewLoopDecision): string => {
  assert(decision.kind === "advance" && decision.post !== undefined, "the step posts a message");
  return decision.post.text;
};

const DECISION_ROWS: ReadonlyArray<
  readonly [
    string,
    ReviewLoopLivePhase,
    Partial<ReviewLoopFacts>,
    string,
    "source" | "review" | "none",
  ]
> = [
  [
    "1: the pull request merged mid-fix",
    of3.fixing(1),
    { pullRequest: { ...pullRequest, state: "merged" }, progress: { kind: "working" } },
    "ended pr_merged after 1 of 3",
    "none",
  ],
  [
    "1: the pull request closed during the brief",
    scoping(5),
    { pullRequest: { ...pullRequest, state: "closed" } },
    "ended pr_closed after 0 of 5",
    "none",
  ],
  [
    "2: the review thread was archived mid-fix",
    of3.fixing(1),
    { reviewThread: { status: "archived" }, progress: { kind: "working" } },
    "ended review_stopped after 1 of 3",
    "source",
  ],
  [
    "2: the review thread was deleted during the brief",
    scoping(3),
    { reviewThread: { status: "deleted" } },
    "ended review_stopped after 0 of 3",
    "source",
  ],
  [
    "3: the awaited message is gone",
    of3.reviewing(2),
    { progress: { kind: "missing" } },
    "ended aborted after 1 of 3",
    "none",
  ],
  [
    "5: the brief is paused in the queue",
    scoping(3),
    { progress: { kind: "held" } },
    "ended author_stopped after 0 of 3",
    "none",
  ],
  [
    "5: the fix is paused in the queue",
    of3.fixing(2),
    { progress: { kind: "held" } },
    "ended author_stopped after 2 of 3",
    "none",
  ],
  [
    "6: the brief failed",
    scoping(3),
    { progress: settled("failed"), resultText: "rate limited\nretry later" },
    "ended author_failed after 0 of 3",
    "none",
  ],
  [
    "6: the fix failed",
    of3.fixing(1),
    { progress: settled("failed"), resultText: "rate limited" },
    "ended author_failed after 1 of 3",
    "none",
  ],
  [
    "7: the fix was interrupted",
    of3.fixing(1),
    { progress: settled("interrupted") },
    "ended author_stopped after 1 of 3",
    "none",
  ],
  [
    "7: the fix was cancelled",
    of5.fixing(3),
    { progress: settled("cancelled") },
    "ended author_stopped after 3 of 5",
    "none",
  ],
  [
    "7: the brief was rolled back",
    scoping(3),
    { progress: settled("rolled_back") },
    "ended author_stopped after 0 of 3",
    "none",
  ],
  ["8: the brief completed", scoping(3), { resultText: BRIEF }, "reviewing 1/3", "review"],
  ["8: the brief of 5 completed", scoping(5), { resultText: BRIEF }, "reviewing 1/5", "review"],
  ["8: the brief ended without text", scoping(3), {}, "reviewing 1/3", "review"],
  [
    "9: fix 2 is stuck",
    of3.fixing(2),
    { resultText: `${LEDGER}\nLOOP: STUCK S2` },
    "ended stuck after 2 of 3",
    "source",
  ],
  [
    "9: fix 3 of an extended loop is stuck",
    of5.fixing(3),
    { resultText: "LOOP: STUCK S7" },
    "ended stuck after 3 of 5",
    "source",
  ],
  [
    "9 not taken: a stuck line in fix 1",
    of3.fixing(1),
    { resultText: `${LEDGER}\nLOOP: STUCK S2` },
    "reviewing 2/3",
    "review",
  ],
  ["10: fix 1 completed", of3.fixing(1), { resultText: LEDGER }, "reviewing 2/3", "review"],
  ["10: fix 2 completed", of3.fixing(2), { resultText: LEDGER }, "reviewing 3/3", "review"],
  ["10: fix 3 of 5 completed", of5.fixing(3), { resultText: LEDGER }, "reviewing 4/5", "review"],
  ["10: fix 4 of 5 completed", of5.fixing(4), { resultText: LEDGER }, "reviewing 5/5", "review"],
  [
    "11: the review is paused in the queue",
    of3.reviewing(1),
    { progress: { kind: "held" } },
    "ended review_stopped after 0 of 3",
    "source",
  ],
  [
    "12: the review failed",
    of3.reviewing(2),
    { progress: settled("failed"), resultText: "rate limited." },
    "ended review_failed after 1 of 3",
    "source",
  ],
  [
    "13: the review was interrupted",
    of3.reviewing(3),
    { progress: settled("interrupted") },
    "ended review_stopped after 2 of 3",
    "source",
  ],
  [
    "13: the review was cancelled",
    of3.reviewing(3),
    { progress: settled("cancelled") },
    "ended review_stopped after 2 of 3",
    "source",
  ],
  [
    "13: the review was rolled back",
    of3.reviewing(3),
    { progress: settled("rolled_back") },
    "ended review_stopped after 2 of 3",
    "source",
  ],
  [
    "14: the review ended without a message",
    of3.reviewing(1),
    { resultText: null },
    "ended review_failed after 0 of 3",
    "source",
  ],
  [
    "15: review 1 approves with a nit",
    of3.reviewing(1),
    { resultText: APPROVED_WITH_NIT },
    "ended approved after 1 of 3",
    "source",
  ],
  [
    "15: review 4 of 5 approves",
    of5.reviewing(4),
    { resultText: APPROVED_RESOLVED },
    "ended approved after 4 of 5",
    "source",
  ],
  [
    "16: review 1 has a blocker",
    of3.reviewing(1),
    { resultText: CHANGES_BLOCKER },
    "fixing 1/3",
    "source",
  ],
  [
    "16: review 2 contradicts itself",
    of3.reviewing(2),
    { resultText: CONTRADICTION },
    "fixing 2/3",
    "source",
  ],
  [
    "16: review 1 has no verdict",
    of3.reviewing(1),
    { resultText: NO_VERDICT },
    "fixing 1/3",
    "source",
  ],
  [
    "16: review 3 of a loop the user allowed 5 needs no area",
    of5.reviewing(3),
    { resultText: CHANGES_BLOCKER },
    "fixing 3/5",
    "source",
  ],
  ["16: review 4 of 5", of5.reviewing(4), { resultText: CHANGES_BLOCKER }, "fixing 4/5", "source"],
  [
    "17: review 3 of 3 leaves a concurrency blocker",
    of3.reviewing(3),
    { resultText: CONCURRENCY },
    "fixing 3/5",
    "source",
  ],
  [
    "17: review 3 of 3 keeps an auth should open",
    of3.reviewing(3),
    { resultText: AUTH_STILL_OPEN },
    "fixing 3/5",
    "source",
  ],
  [
    "18: review 3 of 3 has a blocker without an area",
    of3.reviewing(3),
    { resultText: CHANGES_BLOCKER },
    "ended budget_ended after 3 of 3",
    "source",
  ],
  [
    "18: an area on a nit never extends",
    of3.reviewing(3),
    { resultText: AREA_ON_NIT },
    "ended budget_ended after 3 of 3",
    "source",
  ],
  [
    "18: 5 is the cap",
    of5.reviewing(5),
    { resultText: CONCURRENCY },
    "ended budget_ended after 5 of 5",
    "source",
  ],
  [
    "18: CHANGES with only nits at review 3 of 3",
    of3.reviewing(3),
    { resultText: ONLY_NITS },
    "ended budget_ended after 3 of 3",
    "source",
  ],
];

describe("decideReviewLoop", () => {
  it.each(DECISION_ROWS)("row %s", (_row, phase, overrides, to, post) => {
    assert.deepStrictEqual(outcomeOf(decideReviewLoop(facts(phase, overrides))), { to, post });
  });

  it.each([
    ["pending", scoping(3)],
    ["working", scoping(5)],
    ["pending", of3.reviewing(1)],
    ["working", of5.reviewing(4)],
    ["pending", of3.fixing(1)],
    ["working", of5.fixing(3)],
  ] as const)("row 4: waits while the step is %s", (kind, phase) => {
    assert.deepStrictEqual(decideReviewLoop(facts(phase, { progress: { kind } })), {
      kind: "wait",
    });
  });

  it("records an end's detail: the error, the gone thread, or the disputed ids", () => {
    const toOf = (decision: ReviewLoopDecision) => {
      assert(decision.kind === "advance");
      return decision.to;
    };
    assert.deepStrictEqual(
      toOf(decideReviewLoop(facts(scoping(3), { progress: { kind: "held" } }))),
      ended("author_stopped", 0, 3, "this thread's queue is paused"),
    );
    assert.deepStrictEqual(
      toOf(
        decideReviewLoop(
          facts(scoping(3), { progress: settled("failed"), resultText: "rate limited\nretry" }),
        ),
      ),
      ended("author_failed", 0, 3, "rate limited"),
    );
    assert.deepStrictEqual(
      toOf(decideReviewLoop(facts(of3.fixing(1), { reviewThread: { status: "archived" } }))),
      ended("review_stopped", 1, 3, "the review thread was archived"),
    );
    assert.deepStrictEqual(
      toOf(decideReviewLoop(facts(of3.fixing(2), { resultText: "LOOP: STUCK S2, S5" }))),
      ended("stuck", 2, 3, "S2, S5"),
    );
    assert.deepStrictEqual(
      toOf(
        decideReviewLoop(
          facts(of3.reviewing(2), { progress: settled("failed"), resultText: "rate limited." }),
        ),
      ),
      ended("review_failed", 1, 3, "rate limited"),
    );
  });

  it("carries what the review left open into the fix, nits included, in id order", () => {
    const decision = decideReviewLoop(
      facts(of3.reviewing(1), {
        resultText: "VERDICT: CHANGES\nS3 [nit] a.\nS1 [blocker] b.\nS2 [major] c.",
      }),
    );
    assert(decision.kind === "advance");
    assert.deepStrictEqual(
      decision.to,
      of3.fixing(1, [ref("S1", "blocker"), ref("S2", "unknown"), ref("S3", "nit")]),
    );
  });

  it("carries at most 40 open findings into the fix", () => {
    const review = [
      "VERDICT: CHANGES",
      ...Array.from({ length: 45 }, (_, index) => `S${index + 1} [should] src/a.ts:${index} x.`),
    ].join("\n");
    const decision = decideReviewLoop(facts(of3.reviewing(1), { resultText: review }));
    assert(decision.kind === "advance" && decision.to.status === "fixing");
    assert.strictEqual(decision.to.open.length, 40);
    assert.strictEqual(decision.to.open.at(-1)?.id, "S40");
  });
});

describe("what the agents read", () => {
  it("asks the author for the brief at start, without the user's note", () => {
    const text = scopingRequestText({ pullRequest, budget: 3, reviewerModel: "gpt-6.1-sol" });
    const lines = text.split("\n");

    assert.strictEqual(
      lines[0],
      "**Review loop started** for #42. GPT-6.1-Sol reviews this change, up to 3 reviews.",
    );
    assert.include(
      lines,
      "T3 Code review loop: write the review brief before review 1. Do not push during the loop.",
    );
    assert.include(
      lines,
      "- Find the base: `git fetch origin`, then `git merge-base HEAD origin/main`.",
    );
    assert.includeMembers(lines, [
      "  Base: <sha>",
      "  Intent: <1-2 sentences>",
      "  Out of scope: <1 sentence, or none>",
      "  Checks: <commands and results; name missing or failing checks>",
      "  Diff: <output of git diff --shortstat <base>>",
    ]);
    assert.notInclude(text, "note");
    assert.include(
      scopingRequestText({
        pullRequest: { ...pullRequest, baseBranch: null },
        budget: 5,
        reviewerModel: "gpt-6.1-sol",
      }),
      "up to 5 reviews",
    );
    assert.include(
      scopingRequestText({
        pullRequest: { ...pullRequest, baseBranch: null },
        budget: 3,
        reviewerModel: "gpt-6.1-sol",
      }),
      "`git merge-base HEAD origin/<default branch>`",
    );
  });

  it("row 8: sends the brief, then the user's note, to the reviewer as review 1", () => {
    const text = postText(decideReviewLoop(facts(scoping(3), { resultText: BRIEF, note: NOTE })));
    const lines = text.split("\n");

    assert.strictEqual(
      lines[0],
      "T3 Code review loop: review 1 of 3 for pull request #42 (https://github.com/acme/app/pull/42).",
    );
    assert.include(
      lines,
      "Review only. Do not edit, commit, push, comment on PRs, or start subagents.",
    );
    assert.include(
      text,
      [
        "The author's brief:",
        "",
        "> Base: 4f1c2ab",
        "> Intent: Keep the session token when one refresh fails.",
        "> Out of scope: login page styles.",
        "> Checks: vp test run src/auth/session.test.ts passed.",
        "> Diff: 3 files changed, 48 insertions(+), 9 deletions(-)",
        "",
        "The user's note:",
        "",
        "> Look hard at the retry path.",
        "",
        "If the brief has no Base line, use git merge-base HEAD origin/main.",
        "See: git diff <Base>; git status --short (read untracked files).",
      ].join("\n"),
    );
    assert.include(lines, "VERDICT: APPROVE or CHANGES");
    assert.include(lines, "S1 [blocker|should|nit] <file>:<line> <claim>. Fix: <suggestion>");
    assert.include(
      lines,
      "Keep ids stable. Write APPROVE when no blocker or should is open. Nits alone do not block.",
    );
  });

  it("row 8: sends review 1 without a note line when the user wrote none", () => {
    const text = postText(decideReviewLoop(facts(scoping(3), { resultText: BRIEF })));
    assert.notInclude(text, "The user's note:");
  });

  it("row 8: names the fallback base when the brief is weak or missing", () => {
    const weak = postText(
      decideReviewLoop(facts(scoping(3), { resultText: "Checks pass, brief above." })),
    );
    assert.include(weak, "The author's brief:\n\n> Checks pass, brief above.");
    assert.include(weak, "If the brief has no Base line, use git merge-base HEAD origin/main.");

    const missing = postText(decideReviewLoop(facts(scoping(3), { resultText: null })));
    assert.include(missing, "The author's agent ended its turn without a brief.");
    assert.include(missing, "If the brief has no Base line, use git merge-base HEAD origin/main.");

    const noBase = postText(
      decideReviewLoop(
        facts(scoping(3), {
          resultText: BRIEF,
          pullRequest: { ...pullRequest, baseBranch: null },
        }),
      ),
    );
    assert.include(
      noBase,
      "If the brief has no Base line, use git merge-base HEAD origin/<default branch>.",
    );
  });

  it("row 10: sends the ledger and the open ids to the reviewer", () => {
    const text = postText(
      decideReviewLoop(
        facts(of3.fixing(1, [ref("S1", "blocker"), ref("S2", "nit")]), { resultText: LEDGER }),
      ),
    );
    const lines = text.split("\n");

    assert.strictEqual(
      lines[0],
      "T3 Code review loop: review 2 of 3 for pull request #42 (https://github.com/acme/app/pull/42).",
    );
    assert.include(
      text,
      [
        "The author answered review 1. Its reply:",
        "",
        "> fixed: S1 src/auth/session.ts:58 keeps the token after one failed refresh.",
        "> declined: S2 nit, follow-up.",
        "> Changed: commit 9e0d1f7. Diff: 3 files changed, 61 insertions(+), 9 deletions(-)",
      ].join("\n"),
    );
    assert.include(
      lines,
      "Open from your last review: S1 [blocker], S2 [nit]. Number new findings from S3.",
    );
    assert.include(
      lines,
      "Check only the open ids and the code changed since your last review. Use the same base and diff as review 1.",
    );
    assert.include(
      lines,
      "Mark each old id: S1 resolved, or S2 [should] still open: <reason>. Repeat its severity and area.",
    );
    assert.include(lines, "VERDICT: APPROVE or CHANGES");
    assert.notInclude(text, "The author's brief:");
  });

  it("row 10: asks the reviewer to restate what is open when nothing parsed", () => {
    const text = postText(decideReviewLoop(facts(of3.fixing(1), { resultText: LEDGER })));
    assert.include(
      text.split("\n"),
      "Open from your last review: none parsed. Restate anything still open with an id and a severity.",
    );
    assert.include(
      postText(decideReviewLoop(facts(of3.fixing(2), { resultText: null }))),
      "The author's agent ended its turn on review 2 without a reply.",
    );
  });

  it("cuts a long ledger and points to the author's thread", () => {
    const text = postText(
      decideReviewLoop(facts(of3.fixing(1), { resultText: "x".repeat(9_000) })),
    );
    assert.include(text, "> (Cut at 8000 characters. The author's thread has the full text.)");
  });

  it("row 16: relays the review to the author with the ledger rules", () => {
    const text = postText(
      decideReviewLoop(facts(of3.reviewing(1), { resultText: CHANGES_BLOCKER })),
    );
    const lines = text.split("\n");

    assert.strictEqual(
      lines[0],
      "**Review 1 of 3** from Codex · gpt-6.1-sol on #42: changes. Open: S1 blocker. Nits: S2.",
    );
    assert.include(text, CHANGES_BLOCKER);
    assert.include(lines, "- Commit locally. Do not push. T3 Code tells you when to push.");
    assert.include(
      lines,
      "- End your turn with one message that holds your ledger: `fixed: S1 <evidence>`, `disagree: S2 <evidence>`, `declined: S3 <reason>`, then `Changed: <commit, or nothing>. Diff: <shortstat>`.",
    );
    assert.strictEqual(
      lines.at(-1),
      "- Do not contact the reviewer. When your turn ends, T3 Code sends your ledger to the reviewer for review 2 of 3.",
    );
    assert.notInclude(text, "LOOP: STUCK");
  });

  it("row 16: offers the stuck line from fix 2 on", () => {
    const lines = postText(
      decideReviewLoop(facts(of3.reviewing(2), { resultText: CHANGES_BLOCKER })),
    ).split("\n");
    assert.strictEqual(
      lines.at(-2),
      "- If you still dispute an id that the reviewer kept open after your last reply, end with the line LOOP: STUCK S2 (the ids). T3 Code then stops the loop, and the user decides.",
    );
  });

  it.each([
    [
      "a contradiction",
      CONTRADICTION,
      "**Review 1 of 3** from Codex · gpt-6.1-sol on #42: changes. Open: S2 should. The reviewer wrote APPROVE but left S2 open, so T3 Code treats this review as changes.",
    ],
    [
      "no verdict line",
      NO_VERDICT,
      "**Review 1 of 3** from Codex · gpt-6.1-sol on #42: changes. Open: S1 should. The reviewer gave no verdict line, so T3 Code treats this review as changes.",
    ],
    [
      "untagged findings",
      UNTAGGED,
      "**Review 1 of 3** from Codex · gpt-6.1-sol on #42: changes. The reviewer did not tag its findings with ids.",
    ],
    [
      "a severity it cannot read",
      "VERDICT: CHANGES\nS4 [major] src/a.ts:1 drops it.",
      "**Review 1 of 3** from Codex · gpt-6.1-sol on #42: changes. Open: S4 (unknown severity).",
    ],
  ] as const)("row 16: tells the author why it reads %s as changes", (_case, review, header) => {
    assert.strictEqual(
      postText(decideReviewLoop(facts(of3.reviewing(1), { resultText: review }))).split("\n")[0],
      header,
    );
  });

  it.each([
    [
      CONCURRENCY,
      "**Review 3 of 5** from Codex · gpt-6.1-sol on #42: changes. Open: S7 blocker (concurrency). The loop now allows up to 5 reviews, because S7 is a concurrency finding.",
    ],
    [
      AUTH_STILL_OPEN,
      "**Review 3 of 5** from Codex · gpt-6.1-sol on #42: changes. Open: S2 should (auth). The loop now allows up to 5 reviews, because S2 is an auth finding.",
    ],
  ] as const)("row 17: names the finding that extended the loop", (review, header) => {
    const text = postText(decideReviewLoop(facts(of3.reviewing(3), { resultText: review })));
    assert.strictEqual(text.split("\n")[0], header);
    assert.include(text, "T3 Code sends your ledger to the reviewer for review 4 of 5.");
  });

  it("row 16: names no extension in a loop that started at 5", () => {
    const header = postText(
      decideReviewLoop(facts(of5.reviewing(3), { resultText: CONCURRENCY })),
    ).split("\n")[0];
    assert.strictEqual(
      header,
      "**Review 3 of 5** from Codex · gpt-6.1-sol on #42: changes. Open: S7 blocker (concurrency).",
    );
  });

  it("row 15: tells the author to push once with the sol-loop line", () => {
    const text = postText(
      decideReviewLoop(facts(of3.reviewing(1), { resultText: APPROVED_WITH_NIT })),
    );
    const lines = text.split("\n");

    assert.strictEqual(
      lines[0],
      "**Review loop approved.** Review 1 of 3 from Codex · gpt-6.1-sol on #42 approved this change. Open nits: S1.",
    );
    assert.include(lines, "T3 Code review loop has ended: approved.");
    assert.include(
      lines,
      "- Fix a nit only if the fix is comment, doc, or format only. Decline the other nits in one line each, as follow-ups. Do not change behavior code. The approval covers the current behavior diff.",
    );
    assert.include(
      lines,
      "- If you have a concern of your own about this change, tell the user and do not push.",
    );
    assert.include(
      lines,
      "- Otherwise commit, then push once to feature/session-retry. Add this line to the pull request description, above the line that names the model and harness: `Reviewed with sol-loop: 1 round with GPT-6.1-Sol. Sol verdict: approved`",
    );
    assert.include(text, "and whether you pushed.");
  });

  it("row 15: counts rounds, and says Verdict for a reviewer that is not Sol", () => {
    const four = postText(
      decideReviewLoop(facts(of5.reviewing(4), { resultText: APPROVED_RESOLVED })),
    );
    assert.include(
      four,
      "`Reviewed with sol-loop: 4 rounds with GPT-6.1-Sol. Sol verdict: approved`",
    );
    assert.include(four.split("\n")[0], "approved this change.");
    assert.notInclude(four, "Open nits");

    const composer = postText(
      decideReviewLoop(
        facts(of3.reviewing(2), {
          resultText: "VERDICT: APPROVE",
          reviewThread: {
            status: "live",
            reviewerLabel: "Cursor · composer-2",
            reviewerModel: "composer-2",
          },
        }),
      ),
    );
    assert.include(
      composer,
      "`Reviewed with sol-loop: 2 rounds with Composer 2. Verdict: approved`",
    );
  });

  it("row 18: hands the budget end to the user without a push", () => {
    const text = postText(
      decideReviewLoop(facts(of3.reviewing(3), { resultText: CHANGES_BLOCKER })),
    );
    const lines = text.split("\n");

    assert.strictEqual(
      lines[0],
      "**Review loop needs you.** Review 3 of 3 from Codex · gpt-6.1-sol on #42 still has open findings: S1 blocker. The loop is out of reviews. Budget end is not approval.",
    );
    assert.include(lines, "T3 Code review loop has ended without approval.");
    assert.include(
      lines,
      "- Answer these findings once more: the smallest fix where you agree, evidence where you disagree, one line for each nit. Commit locally. Do not push.",
    );
    assert.include(
      lines,
      "- For each finding that stays open, show both sides in 2 to 3 lines each. The user decides.",
    );
    assert.include(text, "and that you did not push.");
    assert.strictEqual(
      postText(decideReviewLoop(facts(of3.reviewing(3), { resultText: ONLY_NITS }))).split("\n")[0],
      "**Review loop needs you.** Review 3 of 3 from Codex · gpt-6.1-sol on #42 did not approve this change. The loop is out of reviews. Budget end is not approval.",
    );
  });

  it("row 9: hands a dispute to the user without a push", () => {
    const text = postText(
      decideReviewLoop(facts(of3.fixing(2), { resultText: `${LEDGER}\nLOOP: STUCK S2` })),
    );
    const lines = text.split("\n");

    assert.strictEqual(
      lines[0],
      "**Review loop needs you.** You still dispute S2 after two replies, and the reviewer keeps it open.",
    );
    assert.include(lines, "T3 Code review loop has ended without approval: stuck.");
    assert.include(
      lines,
      "- For S2, show both sides in 2 to 3 lines each: the reviewer's last reason and your evidence. The user decides.",
    );
    assert.include(lines, "- Do not push and do not start a review.");
    assert.include(
      postText(decideReviewLoop(facts(of3.fixing(2), { resultText: "LOOP: STUCK S2, S5" }))),
      "You still dispute S2, S5 after two replies, and the reviewer keeps them open.",
    );
  });

  it.each([
    [
      "the review thread was archived mid-fix",
      of3.fixing(1),
      { reviewThread: { status: "archived" } } as const,
      "**Review loop stopped.** Review 2 of 3 on #42 stopped: the review thread was archived.",
    ],
    [
      "the review thread was deleted during the brief",
      scoping(3),
      { reviewThread: { status: "deleted" } } as const,
      "**Review loop stopped.** Review 1 of 3 on #42 stopped: the review thread was deleted.",
    ],
    [
      "the review failed",
      of3.reviewing(2),
      { progress: settled("failed"), resultText: "rate limited." },
      "**Review loop stopped.** Review 2 of 3 on #42 failed: rate limited.",
    ],
    [
      "the review was paused",
      of3.reviewing(1),
      { progress: { kind: "held" } } as const,
      "**Review loop stopped.** Review 1 of 3 on #42 stopped: it is paused in the review thread's queue.",
    ],
  ] as const)("tells the author when %s", (_case, phase, overrides, headline) => {
    const lines = postText(decideReviewLoop(facts(phase, overrides))).split("\n");
    assert.strictEqual(lines[0], headline);
    assert.strictEqual(
      lines.at(-1),
      "T3 Code review loop has ended. Tell the user this in one sentence, and say whether this thread has changes that are not pushed. Do not push, do not change code, and do not start a review.",
    );
  });

  it("cuts a long review and points to the review thread", () => {
    const text = postText(
      decideReviewLoop(
        facts(of3.reviewing(1), { resultText: `VERDICT: CHANGES\n${"x".repeat(25_000)}` }),
      ),
    );
    assert.include(text, "(Cut at 20000 characters. The review thread has the full text.)");
    assert.isBelow(text.length, 22_000);
  });

  it("reads the reply format it asks the reviewer for", () => {
    const lines = reviewRequestText({
      from: scoping(3),
      pullRequest,
      authorReply: BRIEF,
      note: null,
    }).split("\n");
    const example = lines.find((line) => line.startsWith("S1 [blocker|should|nit] "));
    assert(example !== undefined, "review 1 shows the finding format");
    for (const severity of ["blocker", "should"]) {
      assert.strictEqual(
        readingOf(`VERDICT: CHANGES\n${example.replace("blocker|should|nit", severity)}`),
        `changes (changes), open [S1 ${severity}], nits []`,
      );
    }
    assert.strictEqual(
      readingOf(`VERDICT: APPROVE\n${example.replace("blocker|should|nit", "nit")}`),
      "approved, nits [S1]",
    );
    const areas = lines
      .find((line) => line.includes(" Areas: "))
      ?.split(" Areas: ")[1]
      ?.replace(/\.$/, "")
      .split(", ");
    assert.deepStrictEqual(areas, ["security", "permissions", "auth", "data-loss", "concurrency"]);
    for (const area of areas ?? []) {
      assert.strictEqual(
        readingOf(`VERDICT: CHANGES\nS1 [blocker] [${area}] src/a.ts:1 claim. Fix: x`),
        `changes (changes), open [S1 blocker ${area}], nits []`,
      );
    }
    assert.include(lines, "VERDICT: APPROVE or CHANGES");
  });
});

describe("walks through the decision", () => {
  const walk = (
    start: ReviewLoopLivePhase,
    replies: Readonly<Record<string, string | null>>,
    note?: string,
  ) => {
    const visited: Array<string> = [];
    const posts: Array<string> = [];
    let phase: ReviewLoopPhase = start;
    for (let steps = 0; phase.status !== "ended" && steps < 20; steps++) {
      const from: ReviewLoopLivePhase = phase;
      const key = describePhase(from);
      const decision = decideReviewLoop(
        facts(from, { resultText: replies[key] ?? null, ...(note === undefined ? {} : { note }) }),
      );
      assert(decision.kind === "advance", `${key} steps`);
      assert.isTrue(isReviewLoopStep(from, decision.to), `${key} -> ${describePhase(decision.to)}`);
      visited.push(describePhase(decision.to));
      posts.push(`${decision.post?.target ?? "none"}: ${decision.post?.text.split("\n")[0] ?? ""}`);
      phase = decision.to;
    }
    return { visited, posts };
  };

  it("A: the brief, then an approval at review 1 with a nit", () => {
    assert.deepStrictEqual(
      walk(scoping(3), { "scoping/3": BRIEF, "reviewing 1/3": APPROVED_WITH_NIT }).visited,
      ["reviewing 1/3", "ended approved after 1 of 3"],
    );
  });

  it("B: an approval at review 2 after a fix", () => {
    assert.deepStrictEqual(
      walk(scoping(3), {
        "scoping/3": BRIEF,
        "reviewing 1/3": CHANGES_BLOCKER,
        "fixing 1/3": LEDGER,
        "reviewing 2/3": "VERDICT: APPROVE\nS1 resolved\nS2 [nit] still open: naming",
      }).visited,
      ["reviewing 1/3", "fixing 1/3", "reviewing 2/3", "ended approved after 2 of 3"],
    );
  });

  it("C: three reviews without approval end the budget", () => {
    assert.deepStrictEqual(
      walk(scoping(3), {
        "scoping/3": BRIEF,
        "reviewing 1/3": CHANGES_BLOCKER,
        "fixing 1/3": LEDGER,
        "reviewing 2/3": CHANGES_BLOCKER,
        "fixing 2/3": LEDGER,
        "reviewing 3/3": CHANGES_BLOCKER,
      }).visited,
      [
        "reviewing 1/3",
        "fixing 1/3",
        "reviewing 2/3",
        "fixing 2/3",
        "reviewing 3/3",
        "ended budget_ended after 3 of 3",
      ],
    );
  });

  it("D: a concurrency blocker at review 3 extends the loop to 5", () => {
    assert.deepStrictEqual(
      walk(scoping(3), {
        "scoping/3": BRIEF,
        "reviewing 1/3": CHANGES_BLOCKER,
        "fixing 1/3": LEDGER,
        "reviewing 2/3": CHANGES_BLOCKER,
        "fixing 2/3": LEDGER,
        "reviewing 3/3": CONCURRENCY,
        "fixing 3/5": LEDGER,
        "reviewing 4/5": "VERDICT: APPROVE\nS7 resolved",
      }).visited,
      [
        "reviewing 1/3",
        "fixing 1/3",
        "reviewing 2/3",
        "fixing 2/3",
        "reviewing 3/3",
        "fixing 3/5",
        "reviewing 4/5",
        "ended approved after 4 of 5",
      ],
    );
  });

  it("E: a dispute in fix 2 ends the loop as stuck before review 3", () => {
    const { visited } = walk(scoping(3), {
      "scoping/3": BRIEF,
      "reviewing 1/3": NO_VERDICT,
      "fixing 1/3": "disagree: S1 the token is kept in src/auth/session.ts:58.",
      "reviewing 2/3": "VERDICT: CHANGES\nS1 [should] still open: src/server.ts:44 reuses it.",
      "fixing 2/3": "disagree: S1 src/server.ts:44 builds a new one.\nLOOP: STUCK S1",
    });
    assert.deepStrictEqual(visited, [
      "reviewing 1/3",
      "fixing 1/3",
      "reviewing 2/3",
      "fixing 2/3",
      "ended stuck after 2 of 3",
    ]);
    assert.notInclude(visited, "reviewing 3/3");
  });

  it("F: 5 reviews are the cap, even with a risk finding each time", () => {
    const replies = Object.fromEntries(
      ["reviewing 1/3", "reviewing 2/3", "reviewing 3/3", "reviewing 4/5", "reviewing 5/5"].map(
        (key) => [key, CONCURRENCY],
      ),
    );
    const { visited } = walk(scoping(3), {
      ...replies,
      "scoping/3": BRIEF,
      "fixing 1/3": LEDGER,
      "fixing 2/3": LEDGER,
      "fixing 3/5": LEDGER,
      "fixing 4/5": LEDGER,
    });
    assert.deepStrictEqual(visited.slice(-3), [
      "fixing 4/5",
      "reviewing 5/5",
      "ended budget_ended after 5 of 5",
    ]);
    assert.strictEqual(visited.filter((phase) => phase.startsWith("reviewing")).length, 5);
  });

  it("the brief turn: every brief, weak or missing, reaches review 1 with the note and a base", () => {
    for (const brief of [BRIEF, "Checks pass, brief above.", null]) {
      const { visited, posts } = walk(
        scoping(3),
        { "scoping/3": brief, "reviewing 1/3": "VERDICT: APPROVE" },
        NOTE,
      );
      assert.deepStrictEqual(visited, ["reviewing 1/3", "ended approved after 1 of 3"]);
      assert.deepStrictEqual(posts, [
        "review: T3 Code review loop: review 1 of 3 for pull request #42 (https://github.com/acme/app/pull/42).",
        "source: **Review loop approved.** Review 1 of 3 from Codex · gpt-6.1-sol on #42 approved this change.",
      ]);
      const request = postText(
        decideReviewLoop(facts(scoping(3), { resultText: brief, note: NOTE })),
      );
      assert.include(request, "The user's note:\n\n> Look hard at the retry path.");
      assert.include(
        request,
        "If the brief has no Base line, use git merge-base HEAD origin/main.",
      );
    }
  });
});

describe("reviewLoopStepProgress", () => {
  const awaitedRunId = RunId.make("run:awaited");
  const run = (
    id: string,
    ordinal: number,
    status: ReviewLoopStepRecords["runs"][number]["status"],
    times: { readonly started?: number; readonly completed?: number } = {},
    queueHeld?: boolean,
  ) => ({
    id: RunId.make(id),
    ordinal,
    status,
    startedAt: times.started === undefined ? null : at(times.started),
    completedAt: times.completed === undefined ? null : at(times.completed),
    ...(queueHeld === undefined ? {} : { queueHeld }),
  });
  const awaitedRun = (
    status: ReviewLoopStepRecords["runs"][number]["status"],
    times: { readonly started?: number; readonly completed?: number } = {
      started: 1,
      completed: 2,
    },
    queueHeld?: boolean,
  ) => run("run:awaited", 2, status, times, queueHeld);
  const progressOf = (
    overrides: Partial<ReviewLoopStepRecords> & Pick<ReviewLoopStepRecords, "runs">,
  ) => {
    const progress = reviewLoopStepProgress({
      awaitedMessage: { runId: awaitedRunId },
      subagents: [],
      providerThreads: [],
      backgroundTurnItems: [],
      activeProviderThreadId: null,
      continuationPending: new Set(),
      ...overrides,
    });
    return progress.kind === "settled" ? `settled on ${progress.run.id}` : progress.kind;
  };

  const rows: ReadonlyArray<
    readonly [string, Partial<ReviewLoopStepRecords> & Pick<ReviewLoopStepRecords, "runs">, string]
  > = [
    ["the awaited run is queued", { runs: [awaitedRun("queued", {}, false)] }, "pending"],
    ["the awaited run is queued and held", { runs: [awaitedRun("queued", {}, true)] }, "held"],
    ["the awaited run is waiting", { runs: [awaitedRun("waiting", { started: 1 })] }, "working"],
    [
      "a subagent still runs",
      {
        runs: [awaitedRun("completed")],
        backgroundTurnItems: [
          { id: "item:child", type: "subagent", status: "running", title: "Check" },
        ],
      },
      "working",
    ],
    [
      "a subagent's result is still owed",
      {
        runs: [awaitedRun("completed")],
        subagents: [{ completionDelivery: { state: "claimed", observedByRunId: null } }],
      },
      "working",
    ],
    [
      "a dev server the agent left running",
      {
        runs: [awaitedRun("completed")],
        backgroundTurnItems: [
          { id: "item:dev", type: "command_execution", status: "running", title: "npm run dev" },
        ],
      },
      "settled on run:awaited",
    ],
    [
      "a restart continuation is pending",
      { runs: [awaitedRun("cancelled")], continuationPending: new Set([awaitedRunId]) },
      "working",
    ],
    [
      "a pull request watch woke the agent",
      { runs: [awaitedRun("completed"), run("run:wake", 3, "running", { started: 3 })] },
      "working",
    ],
    [
      "a user's follow-up completed after it",
      {
        runs: [
          run("run:earlier", 1, "completed", { started: 0, completed: 1 }),
          awaitedRun("completed"),
          run("run:follow-up", 3, "completed", { started: 3, completed: 4 }),
        ],
      },
      "settled on run:follow-up",
    ],
    [
      "the user cancelled the awaited message before it ran",
      {
        runs: [
          awaitedRun("cancelled", { completed: 2 }),
          run("run:own", 3, "completed", { started: 3, completed: 4 }),
        ],
      },
      "settled on run:awaited",
    ],
    [
      "no run has the awaited message",
      { runs: [run("run:other", 1, "completed", { started: 0, completed: 1 })] },
      "missing",
    ],
    [
      "the awaited message is gone",
      { runs: [awaitedRun("completed")], awaitedMessage: undefined },
      "missing",
    ],
  ];

  it.each(rows)("%s", (_case, records, progress) => {
    assert.strictEqual(progressOf(records), progress);
  });

  it("follows a message promoted to a steer into the run it joined", () => {
    const steered = RunId.make("run:active");
    const promoted = { runId: steered };
    const cancelledQueued = run("run:awaited", 3, "cancelled", { completed: 2 });

    assert.strictEqual(
      progressOf({
        awaitedMessage: promoted,
        runs: [run("run:active", 2, "running", { started: 1 }), cancelledQueued],
      }),
      "working",
    );
    assert.strictEqual(
      progressOf({
        awaitedMessage: promoted,
        runs: [run("run:active", 2, "completed", { started: 1, completed: 4 }), cancelledQueued],
      }),
      "settled on run:active",
    );
  });
});

describe("link automation", () => {
  const link: ThreadPullRequestLink = {
    host: "github.com",
    repository: "acme/app",
    number: 42,
    url: pullRequest.url,
    source: "agent",
    linkedAt: NOW,
    snapshot: null,
    stack: null,
  };
  const watch = {
    startedAt: NOW,
    headSha: null,
    failedChecks: [],
    passed: false,
    passedChecks: [],
    remarksThrough: NOW,
    remarkIds: [],
    conflicting: false,
    wakes: 0,
  };
  const LATER = "2026-10-05T13:00:00.000Z";

  it("keeps the watch and the review loop when a link is rebuilt", () => {
    const rebuilt = { ...link, source: "manual" as const, linkedAt: LATER };

    assert.deepStrictEqual(
      carryLinkAutomation({ ...link, watch, reviewLoop: authorLoop(of3.reviewing(2)) }, rebuilt),
      { ...rebuilt, watch, reviewLoop: authorLoop(of3.reviewing(2)) },
    );
    assert.deepStrictEqual(carryLinkAutomation(undefined, rebuilt), rebuilt);
  });

  it("ends the watch and a live author loop as stopped, in its budget", () => {
    assert.deepStrictEqual(
      endLinkAutomation({ ...link, watch, reviewLoop: authorLoop(of3.fixing(2)) }, LATER),
      { ...link, reviewLoop: authorLoop({ ...ended("stopped", 2), endedAt: LATER }) },
    );
    assert.deepStrictEqual(
      endLinkAutomation({ ...link, reviewLoop: authorLoop(scoping(5), NOTE) }, LATER),
      { ...link, reviewLoop: authorLoop({ ...ended("stopped", 0, 5), endedAt: LATER }, NOTE) },
    );
  });

  it("keeps an ended loop and a reviewer marker when automation ends", () => {
    const endedLoop = authorLoop(ended("approved", 1));

    assert.deepStrictEqual(endLinkAutomation({ ...link, watch, reviewLoop: endedLoop }, LATER), {
      ...link,
      reviewLoop: endedLoop,
    });
    assert.deepStrictEqual(endLinkAutomation({ ...link, reviewLoop: marker }, LATER), {
      ...link,
      reviewLoop: marker,
    });
  });

  it("drops the review loop from a forked link and keeps the rest", () => {
    assert.deepStrictEqual(
      withoutReviewLoop({ ...link, watch, reviewLoop: authorLoop(of3.reviewing(1)) }),
      {
        ...link,
        watch,
      },
    );
  });
});

describe("makeReviewThread", () => {
  const reviewer = { instanceId: ProviderInstanceId.make("cursor"), model: "composer-1" };
  const source: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: sourceThreadId,
    projectId: ProjectId.make("project:app"),
    title: "Fix login",
    providerInstanceId: ProviderInstanceId.make("claude"),
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    branch: "feature/login",
    worktreePath: "/work/app-login",
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: sourceThreadId },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };

  it("creates a top-level thread in the source's checkout that reviews the linked pull request", () => {
    const thread = makeReviewThread({
      source,
      reviewThreadId,
      loopId,
      link: {
        host: "github.com",
        repository: "acme/app",
        number: 42,
        url: pullRequest.url,
        source: "agent",
        linkedAt: NOW,
        snapshot: null,
        stack: null,
        watch: {
          startedAt: NOW,
          headSha: null,
          failedChecks: [],
          passed: false,
          passedChecks: [],
          remarksThrough: NOW,
          remarkIds: [],
          conflicting: false,
          wakes: 0,
        },
        reviewLoop: authorLoop(of3.reviewing(1)),
      },
      reviewer,
      createdBy: "user",
      creationSource: "web",
      collaborationCreatedBy: null,
      now: at(5),
    });

    assert.isTrue(isAppThread(thread));
    assert.strictEqual(thread.kind, "review");
    assert.strictEqual(thread.reviewPullRequestNumber, 42);
    assert.deepStrictEqual(thread.lineage, {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: reviewThreadId,
    });
    assert.deepStrictEqual(
      [thread.branch, thread.worktreePath, thread.runtimeMode],
      [source.branch, source.worktreePath, source.runtimeMode],
    );
    assert.deepStrictEqual(thread.modelSelection, reviewer);
    assert.strictEqual(thread.providerInstanceId, reviewer.instanceId);
    assert.deepStrictEqual(
      thread.pullRequests?.map((link) => [link.number, link.watch, link.reviewLoop]),
      [[42, undefined, marker]],
    );
  });
});
