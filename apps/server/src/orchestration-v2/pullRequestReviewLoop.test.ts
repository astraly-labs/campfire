import type {
  ReviewLoopEndedPhase,
  ReviewLoopLivePhase,
  ReviewLoopPhase,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
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
  endLinkAutomation,
  isReviewLoopStep,
  makeReviewThread,
  parseReviewVerdict,
  REVIEW_VERDICT_LINE,
  reviewDeliveryText,
  reviewLoopEndText,
  reviewLoopStepProgress,
  reviewRequestText,
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
  branch: "feature/login",
  state: "open",
} as const;

const reviewing = (round: 1 | 2 | 3) => ({ status: "reviewing", round }) as const;
const fixing = (round: 1 | 2) => ({ status: "fixing", round }) as const;
const ended = (
  reason: ReviewLoopEndedPhase["reason"],
  reviews: ReviewLoopEndedPhase["reviews"],
  detail?: string,
): ReviewLoopEndedPhase => ({
  status: "ended",
  reason,
  reviews,
  ...(detail === undefined ? {} : { detail }),
  endedAt: NOW,
});
const authorLoop = (phase: ReviewLoopPhase) => ({
  role: "author" as const,
  id: loopId,
  reviewThreadId,
  prompt: "/review #42",
  startedAt: NOW,
  phase,
});
const marker = { role: "reviewer" as const, id: loopId, sourceThreadId };

const CHANGES_REVIEW = `src/auth.ts:12 drops the token on refresh.\n${REVIEW_VERDICT_LINE.changes}`;
const CLEAN_REVIEW = `Nothing to change.\n${REVIEW_VERDICT_LINE.clean}`;
const UNMARKED_REVIEW = "src/auth.ts:12 drops the token on refresh.";

describe("parseReviewVerdict", () => {
  it.each([
    ["the clean line last", "clean", `Looks good.\n${REVIEW_VERDICT_LINE.clean}`],
    ["a bold clean line", "clean", "**REVIEW-LOOP: CLEAN**"],
    ["a code-span clean line", "clean", "`REVIEW-LOOP: CLEAN`"],
    ["a quoted lowercase clean line", "clean", "> review-loop: clean."],
    ["a clean line without a space", "clean", "REVIEW-LOOP:CLEAN"],
    ["a clean line before a closing fence", "clean", "```\nREVIEW-LOOP: CLEAN\r\n```"],
    ["text after the clean line", "changes", "REVIEW-LOOP: CLEAN\nThanks!"],
    ["both lines echoed", "changes", "REVIEW-LOOP: CHANGES\nREVIEW-LOOP: CLEAN"],
    ["the changes line last", "changes", `Rename it.\n${REVIEW_VERDICT_LINE.changes}`],
    ["the clean line mid-sentence", "unmarked", "I end with REVIEW-LOOP: CLEAN when done."],
    ["a longer word", "unmarked", "REVIEW-LOOP: CLEANISH"],
    ["empty text", "unmarked", ""],
    ["no verdict line", "unmarked", UNMARKED_REVIEW],
  ] as const)("reads %s as %s", (_case, verdict, text) => {
    assert.strictEqual(parseReviewVerdict(text), verdict);
  });
});

describe("isReviewLoopStep", () => {
  const live: ReadonlyArray<ReviewLoopLivePhase> = [
    reviewing(1),
    fixing(1),
    reviewing(2),
    fixing(2),
    reviewing(3),
  ];
  const key = (phase: ReviewLoopPhase) =>
    phase.status === "ended" ? "ended" : `${phase.status} ${phase.round}`;
  const forward = new Set([
    "reviewing 1 -> fixing 1",
    "fixing 1 -> reviewing 2",
    "reviewing 2 -> fixing 2",
    "fixing 2 -> reviewing 3",
  ]);

  it("allows only the next phase, or an end from any live phase", () => {
    for (const from of live) {
      for (const to of [...live, ended("stopped", 0)]) {
        const step = `${key(from)} -> ${key(to)}`;
        assert.strictEqual(
          isReviewLoopStep(from, to),
          to.status === "ended" || forward.has(step),
          step,
        );
      }
    }
  });

  it("cannot write down a third fix or a fourth review", () => {
    // @ts-expect-error The contract has no third fix.
    const thirdFix: ReviewLoopPhase = { status: "fixing", round: 3 };
    // @ts-expect-error The contract has no fourth review.
    const fourthReview: ReviewLoopPhase = { status: "reviewing", round: 4 };

    assert.isFalse(isReviewLoopStep(reviewing(3), thirdFix));
    assert.isFalse(isReviewLoopStep(fixing(2), fourthReview));
  });
});

describe("awaitedThread", () => {
  it("waits on the review thread while reviewing and on the source thread while fixing", () => {
    assert.strictEqual(
      awaitedThread({ reviewThreadId, phase: reviewing(2) }, sourceThreadId),
      reviewThreadId,
    );
    assert.strictEqual(
      awaitedThread({ reviewThreadId, phase: fixing(2) }, sourceThreadId),
      sourceThreadId,
    );
  });
});

const settled = (status: "completed" | "failed" | "interrupted" | "cancelled" | "rolled_back") =>
  ({
    kind: "settled",
    run: { id: RunId.make("run:1"), ordinal: 1, status, startedAt: at(0), completedAt: at(1) },
  }) satisfies ReviewLoopStepProgress;

const facts = (
  phase: ReviewLoopLivePhase,
  overrides: Partial<ReviewLoopFacts> = {},
): ReviewLoopFacts => ({
  loop: { ...authorLoop(phase), phase },
  pullRequest,
  reviewThread: "live",
  progress: settled("completed"),
  resultText: null,
  reviewerLabel: "Cursor · composer-1",
  now: NOW,
  ...overrides,
});

const outcomeOf = (decision: ReviewLoopDecision) =>
  decision.kind === "wait" ? "wait" : { to: decision.to, post: decision.post?.target ?? "none" };

const postText = (decision: ReviewLoopDecision): string => {
  assert(decision.kind === "advance" && decision.post !== undefined, "the step posts a message");
  return decision.post.text;
};

const DECISION_ROWS: ReadonlyArray<
  readonly [
    string,
    ReviewLoopLivePhase,
    Partial<ReviewLoopFacts>,
    ReviewLoopPhase,
    "source" | "review" | "none",
  ]
> = [
  [
    "1: the pull request merged mid-fix",
    fixing(1),
    { pullRequest: { ...pullRequest, state: "merged" }, progress: { kind: "working" } },
    ended("pr_merged", 1),
    "none",
  ],
  [
    "1: the pull request closed",
    reviewing(2),
    { pullRequest: { ...pullRequest, state: "closed" } },
    ended("pr_closed", 1),
    "none",
  ],
  [
    "2: the review thread was archived mid-fix",
    fixing(1),
    { reviewThread: "archived", progress: { kind: "working" } },
    ended("review_stopped", 1, "the review thread was archived"),
    "source",
  ],
  [
    "2: the review thread was deleted",
    reviewing(1),
    { reviewThread: "deleted" },
    ended("review_stopped", 0, "the review thread was deleted"),
    "source",
  ],
  [
    "3: the awaited message is gone",
    reviewing(2),
    { progress: { kind: "missing" } },
    ended("aborted", 1, "the awaited message is gone"),
    "none",
  ],
  [
    "5: the fix is paused in the queue",
    fixing(2),
    { progress: { kind: "held" } },
    ended("fix_stopped", 2, "this thread's queue is paused"),
    "none",
  ],
  [
    "6: the fix failed",
    fixing(1),
    { progress: settled("failed"), resultText: "rate limited\nretry in 5 minutes" },
    ended("fix_failed", 1, "rate limited"),
    "none",
  ],
  [
    "7: the fix was interrupted",
    fixing(1),
    { progress: settled("interrupted") },
    ended("fix_stopped", 1),
    "none",
  ],
  [
    "7: the fix was cancelled",
    fixing(2),
    { progress: settled("cancelled") },
    ended("fix_stopped", 2),
    "none",
  ],
  [
    "7: the fix was rolled back",
    fixing(1),
    { progress: settled("rolled_back") },
    ended("fix_stopped", 1),
    "none",
  ],
  ["8: fix 1 completed", fixing(1), { resultText: "Fixed the refresh." }, reviewing(2), "review"],
  ["8: fix 2 completed", fixing(2), { resultText: "Fixed the refresh." }, reviewing(3), "review"],
  [
    "9: the review is paused in the queue",
    reviewing(1),
    { progress: { kind: "held" } },
    ended("review_stopped", 0, "it is paused in the review thread's queue"),
    "source",
  ],
  [
    "10: the review failed, and its error's closing period is dropped",
    reviewing(2),
    { progress: settled("failed"), resultText: "rate limited." },
    ended("review_failed", 1, "rate limited"),
    "source",
  ],
  [
    "11: the review was interrupted",
    reviewing(1),
    { progress: settled("interrupted") },
    ended("review_stopped", 0, "it was stopped in the review thread"),
    "source",
  ],
  [
    "11: the review was cancelled",
    reviewing(3),
    { progress: settled("cancelled") },
    ended("review_stopped", 2, "it was stopped in the review thread"),
    "source",
  ],
  [
    "11: the review was rolled back",
    reviewing(2),
    { progress: settled("rolled_back") },
    ended("review_stopped", 1, "it was stopped in the review thread"),
    "source",
  ],
  [
    "12: the review ended without a message",
    reviewing(1),
    { resultText: null },
    ended("review_failed", 0, "it ended without a review message"),
    "source",
  ],
  [
    "13: review 1 is clean",
    reviewing(1),
    { resultText: CLEAN_REVIEW },
    ended("clean", 1),
    "source",
  ],
  [
    "13: review 3 is clean",
    reviewing(3),
    { resultText: CLEAN_REVIEW },
    ended("clean", 3),
    "source",
  ],
  [
    "14: review 3 has changes",
    reviewing(3),
    { resultText: CHANGES_REVIEW },
    ended("needs_human", 3),
    "source",
  ],
  [
    "14: review 3 has no verdict",
    reviewing(3),
    { resultText: UNMARKED_REVIEW },
    ended("needs_human", 3),
    "source",
  ],
  ["15: review 1 has changes", reviewing(1), { resultText: CHANGES_REVIEW }, fixing(1), "source"],
  [
    "15: review 2 has no verdict",
    reviewing(2),
    { resultText: UNMARKED_REVIEW },
    fixing(2),
    "source",
  ],
];

describe("decideReviewLoop", () => {
  it.each(DECISION_ROWS)("row %s", (_row, phase, overrides, to, post) => {
    assert.deepStrictEqual(outcomeOf(decideReviewLoop(facts(phase, overrides))), { to, post });
  });

  it.each([
    ["pending", reviewing(1)],
    ["working", reviewing(2)],
    ["pending", fixing(1)],
    ["working", fixing(2)],
  ] as const)("row 4: waits while the step is %s", (kind, phase) => {
    assert.deepStrictEqual(decideReviewLoop(facts(phase, { progress: { kind } })), {
      kind: "wait",
    });
  });

  it("walks the cap: three reviews and two fixes, then the human", () => {
    const reviews = [CHANGES_REVIEW, UNMARKED_REVIEW, CHANGES_REVIEW];
    const visited: Array<ReviewLoopPhase> = [];
    let phase: ReviewLoopPhase = reviewing(1);
    for (let steps = 0; phase.status !== "ended" && steps < 10; steps++) {
      const from: ReviewLoopLivePhase = phase;
      const decision = decideReviewLoop(
        facts(from, {
          resultText: from.status === "reviewing" ? reviews[from.round - 1]! : "Fixed.",
        }),
      );
      assert(decision.kind === "advance");
      assert.isTrue(isReviewLoopStep(from, decision.to));
      visited.push(decision.to);
      phase = decision.to;
    }

    assert.deepStrictEqual(visited, [
      fixing(1),
      reviewing(2),
      fixing(2),
      reviewing(3),
      ended("needs_human", 3),
    ]);
  });

  it("asks the reviewer again with the author's reply", () => {
    const text = postText(
      decideReviewLoop(
        facts(fixing(1), { resultText: "Fixed the refresh. Skipped the rename: public API." }),
      ),
    );

    assert.isTrue(text.startsWith("/review #42\n"));
    assert.include(text, "review 2 of 3");
    assert.include(text, "> Fixed the refresh. Skipped the rename: public API.");
  });

  it("relays a review that has changes into the source thread", () => {
    const text = postText(decideReviewLoop(facts(reviewing(2), { resultText: CHANGES_REVIEW })));

    assert.include(text, "**Review 2 of 3** from Cursor · composer-1 on #42");
    assert.include(text, CHANGES_REVIEW);
  });

  it("tells the source thread why a review did not finish", () => {
    const text = postText(
      decideReviewLoop(
        facts(fixing(1), { reviewThread: "archived", progress: { kind: "working" } }),
      ),
    );

    assert.include(text, "Review 2 of 3 on #42 stopped: the review thread was archived.");
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

describe("loop texts", () => {
  it("starts each review request with the user's prompt and asks for one verdict line", () => {
    const text = reviewRequestText({
      prompt: "/review #42 and check the auth flow",
      round: 1,
      pullRequest,
      authorReply: null,
    });
    const lines = text.split("\n");

    assert.strictEqual(lines[0], "/review #42 and check the auth flow");
    assert.include(
      text,
      "review 1 of 3 for pull request #42 (https://github.com/acme/app/pull/42)",
    );
    assert.include(lines, REVIEW_VERDICT_LINE.clean);
    assert.include(lines, REVIEW_VERDICT_LINE.changes);
    assert.include(text, "Do not edit files, commit, push, or switch branches.");
    assert.include(
      text,
      "Put the whole review in your final message in this thread, not only in GitHub comments.",
    );
  });

  it("quotes the author's reply from review 2 on", () => {
    const text = reviewRequestText({
      prompt: "/review #42",
      round: 3,
      pullRequest,
      authorReply: "Fixed the refresh.\nSkipped the rename: public API.",
    });

    assert.include(text, "review 3 of 3");
    assert.include(text, "your review 2");
    assert.include(text, "feature/login");
    assert.include(text, "> Fixed the refresh.\n> Skipped the rename: public API.");
  });

  it("relays a review with the next round and the branch to push", () => {
    const text = reviewDeliveryText({
      round: 1,
      reviewerLabel: "Cursor · composer-1",
      pullRequest,
      review: UNMARKED_REVIEW,
      verdict: "unmarked",
    });

    assert.include(text, "**Review 1 of 3** from Cursor · composer-1 on #42");
    assert.include(text, "gave no verdict line");
    assert.include(text, UNMARKED_REVIEW);
    assert.include(text, "Commit and push to feature/login");
    assert.include(text, "review 2 of 3");
  });

  it("cuts a long review and points to the review thread", () => {
    const text = reviewDeliveryText({
      round: 2,
      reviewerLabel: "Cursor · composer-1",
      pullRequest,
      review: "x".repeat(25_000),
      verdict: "changes",
    });

    assert.include(text, "(Cut at 20000 characters. The review thread has the full text.)");
    assert.isBelow(text.length, 21_000);
  });

  it("ends the loop with the reason, and with the last review when there is one", () => {
    const end = (to: Parameters<typeof reviewLoopEndText>[0]["to"], reviewText: string | null) =>
      reviewLoopEndText({ reviewerLabel: "Cursor · composer-1", pullRequest, to, reviewText });

    const clean = end({ ...ended("clean", 2), reason: "clean" }, CLEAN_REVIEW);
    assert.include(clean, "Review 2 of 3 from Cursor · composer-1 on #42 found nothing to change.");
    assert.include(clean, CLEAN_REVIEW);

    const needsHuman = end({ ...ended("needs_human", 3), reason: "needs_human" }, CHANGES_REVIEW);
    assert.include(needsHuman, "Review 3 of 3 from Cursor · composer-1 on #42 still has findings.");
    assert.include(needsHuman, CHANGES_REVIEW);

    assert.include(
      end({ ...ended("review_failed", 1, "rate limited"), reason: "review_failed" }, null),
      "Review 2 of 3 on #42 failed: rate limited.",
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
      carryLinkAutomation({ ...link, watch, reviewLoop: authorLoop(reviewing(2)) }, rebuilt),
      { ...rebuilt, watch, reviewLoop: authorLoop(reviewing(2)) },
    );
    assert.deepStrictEqual(carryLinkAutomation(undefined, rebuilt), rebuilt);
  });

  it("ends the watch and a live author loop as stopped", () => {
    assert.deepStrictEqual(
      endLinkAutomation({ ...link, watch, reviewLoop: authorLoop(fixing(2)) }, LATER),
      { ...link, reviewLoop: authorLoop({ ...ended("stopped", 2), endedAt: LATER }) },
    );
  });

  it("keeps an ended loop and a reviewer marker when automation ends", () => {
    const endedLoop = authorLoop(ended("clean", 1));

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
      withoutReviewLoop({ ...link, watch, reviewLoop: authorLoop(reviewing(1)) }),
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
        reviewLoop: authorLoop(reviewing(1)),
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
