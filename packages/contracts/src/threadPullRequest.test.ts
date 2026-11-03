import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { OrchestrationV2Command } from "./orchestrationV2.ts";
import { ReviewLoopPhase, ThreadPullRequestLink } from "./threadPullRequest.ts";

const decodeLinks = Schema.decodeUnknownEffect(Schema.Array(ThreadPullRequestLink));

it.effect("decodes thread pull request links with snapshot and stack", () =>
  Effect.gen(function* () {
    const links = yield* decodeLinks([
      {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 42,
        url: "https://github.com/pingdotgg/t3code/pull/42",
        source: "agent",
        linkedAt: "2026-01-01T00:00:00.000Z",
        snapshot: null,
        stack: null,
      },
      {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 43,
        url: "https://github.com/pingdotgg/t3code/pull/43",
        source: "stack",
        linkedAt: "2026-01-01T00:01:00.000Z",
        snapshot: {
          state: "open",
          title: "Layer two",
          headBranch: "feature/stack-2",
          baseBranch: "feature/stack-1",
          isDraft: false,
          updatedAt: "2026-01-01T00:02:00.000Z",
          syncedAt: "2026-01-01T00:03:00.000Z",
        },
        stack: {
          kind: "native",
          id: "7",
          number: 3,
          url: "https://github.com/pingdotgg/t3code/stacks/3",
          base: "main",
          layers: [
            { number: 42, headBranch: "feature/stack-1", state: "open" },
            { number: 43, headBranch: "feature/stack-2", state: "open" },
          ],
        },
      },
    ]);

    assert.strictEqual(links.length, 2);
    assert.strictEqual(links[1]?.stack?.layers.length, 2);
    assert.strictEqual(links[1]?.snapshot?.state, "open");
  }),
);

it.effect("decodes a watch saved before passed checks were recorded", () =>
  Effect.gen(function* () {
    const [link] = yield* decodeLinks([
      {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 42,
        url: "https://github.com/pingdotgg/t3code/pull/42",
        source: "agent",
        linkedAt: "2026-01-01T00:00:00.000Z",
        snapshot: null,
        stack: null,
        watch: {
          startedAt: "2026-01-01T00:00:00.000Z",
          headSha: "abc123",
          failedChecks: [],
          passed: true,
          remarksThrough: "2026-01-01T00:00:00.000Z",
          remarkIds: [],
          conflicting: false,
          wakes: 0,
        },
      },
    ]);

    assert.deepStrictEqual(link?.watch?.passedChecks, []);
  }),
);

const link = {
  host: "github.com",
  repository: "pingdotgg/t3code",
  number: 42,
  url: "https://github.com/pingdotgg/t3code/pull/42",
  source: "agent",
  linkedAt: "2026-01-01T00:00:00.000Z",
  snapshot: null,
  stack: null,
};
const author = {
  role: "author",
  id: "review-loop:1",
  reviewThreadId: "thread:review",
  note: "Look hard at the retry path.",
  startedAt: "2026-01-01T00:00:00.000Z",
  phase: { status: "fixing", budget: 3, round: 2, open: [{ id: "S1", severity: "should" }] },
};
const reviewer = { role: "reviewer", id: "review-loop:1", sourceThreadId: "thread:source" };
const endedAt = "2026-01-01T01:00:00.000Z";

it.effect("decodes a link's review loop as the author record or the reviewer marker", () =>
  Effect.gen(function* () {
    const { note: _note, ...withoutNote } = author;
    const [plain, source, review, noNote] = yield* decodeLinks([
      link,
      { ...link, reviewLoop: author },
      { ...link, reviewLoop: reviewer },
      { ...link, reviewLoop: withoutNote },
    ]);

    assert.strictEqual(plain?.reviewLoop, undefined);
    assert.deepStrictEqual<unknown>(source?.reviewLoop, author);
    assert.deepStrictEqual<unknown>(review?.reviewLoop, reviewer);
    assert.deepStrictEqual<unknown>(noNote?.reviewLoop, withoutNote);
  }),
);

it.effect("drops a review loop it cannot read and keeps the link", () =>
  Effect.gen(function* () {
    const links = yield* decodeLinks([
      { ...link, reviewLoop: { ...author, phase: { status: "reviewing", budget: 4, round: 1 } } },
      { ...link, reviewLoop: { ...author, phase: { status: "paused", budget: 3 } } },
      {
        ...link,
        reviewLoop: {
          ...author,
          phase: { status: "ended", reason: "timed_out", reviews: 1, budget: 3, endedAt },
        },
      },
      { ...link, reviewLoop: { role: "observer", id: "review-loop:1" } },
      {
        ...link,
        reviewLoop: {
          role: "author",
          id: "review-loop:old",
          reviewThreadId: "thread:review",
          prompt: "/review #42",
          startedAt: endedAt,
          phase: { status: "ended", reason: "clean", reviews: 1, endedAt },
        },
      },
      {
        ...link,
        reviewLoop: {
          role: "author",
          id: "review-loop:old-live",
          reviewThreadId: "thread:review",
          prompt: "/review #42",
          startedAt: endedAt,
          phase: { status: "reviewing", round: 1 },
        },
      },
    ]);

    assert.deepStrictEqual(
      links.map((decoded) => [decoded.number, decoded.reviewLoop]),
      links.map(() => [42, undefined]),
    );
  }),
);

const decodePhase = Schema.decodeUnknownOption(ReviewLoopPhase);
const refs = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `S${index + 1}`, severity: "nit" }));

it.each([
  ["the brief of a 5-review loop", { status: "scoping", budget: 5 }],
  ["review 3 of 3", { status: "reviewing", budget: 3, round: 3 }],
  ["review 4 of 5", { status: "reviewing", budget: 5, round: 4 }],
  ["fix 2 of 3", { status: "fixing", budget: 3, round: 2, open: [] }],
  [
    "fix 3 of 5",
    { status: "fixing", budget: 5, round: 3, open: [{ id: "S7", severity: "blocker" }] },
  ],
  ["40 open findings", { status: "fixing", budget: 3, round: 1, open: refs(40) }],
  [
    "a stuck end",
    { status: "ended", reason: "stuck", reviews: 2, budget: 3, detail: "S2", endedAt },
  ],
  [
    "an approved end after 5 reviews",
    { status: "ended", reason: "approved", reviews: 5, budget: 5, endedAt },
  ],
] as const)("decodes %s", (_case, phase) => {
  assert.isTrue(Option.isSome(decodePhase(phase)));
});

it.each([
  ["review 4 of 3", { status: "reviewing", budget: 3, round: 4 }],
  ["fix 3 of 3", { status: "fixing", budget: 3, round: 3, open: [] }],
  ["review 6 of 5", { status: "reviewing", budget: 5, round: 6 }],
  ["fix 5 of 5", { status: "fixing", budget: 5, round: 5, open: [] }],
  ["a budget of 4", { status: "scoping", budget: 4 }],
  ["a phase without a budget", { status: "reviewing", round: 1 }],
  ["an end without a budget", { status: "ended", reason: "stopped", reviews: 0, endedAt }],
  ["a fix without its open findings", { status: "fixing", budget: 3, round: 1 }],
  ["41 open findings", { status: "fixing", budget: 3, round: 1, open: refs(41) }],
  [
    "a finding id S0",
    { status: "fixing", budget: 3, round: 1, open: [{ id: "S0", severity: "nit" }] },
  ],
  [
    "a finding id T1",
    { status: "fixing", budget: 3, round: 1, open: [{ id: "T1", severity: "nit" }] },
  ],
  [
    "a finding severity the loop does not know",
    { status: "fixing", budget: 3, round: 1, open: [{ id: "S1", severity: "critical" }] },
  ],
] as const)("rejects %s", (_case, phase) => {
  assert.isTrue(Option.isNone(decodePhase(phase)));
});

const decodeCommand = Schema.decodeUnknownOption(OrchestrationV2Command);
const startCommand = (request: Record<string, unknown>) => ({
  type: "thread.pull-request.review-loop",
  commandId: "command:start",
  threadId: "thread:source",
  host: "github.com",
  repository: "pingdotgg/t3code",
  number: 42,
  createdBy: "user",
  creationSource: "web",
  request: {
    type: "start",
    reviewer: { instanceId: "codex", model: "gpt-6.1-sol" },
    ...request,
  },
});

it("starts a loop with a budget and an optional note of at most 2000 characters", () => {
  assert.isTrue(Option.isSome(decodeCommand(startCommand({ budget: 3 }))));
  assert.isTrue(Option.isSome(decodeCommand(startCommand({ budget: 5, note: "x".repeat(2000) }))));
  assert.isTrue(Option.isNone(decodeCommand(startCommand({}))));
  assert.isTrue(Option.isNone(decodeCommand(startCommand({ budget: 4 }))));
  assert.isTrue(Option.isNone(decodeCommand(startCommand({ budget: 3, note: "x".repeat(2001) }))));
  assert.isTrue(Option.isNone(decodeCommand(startCommand({ budget: 3, note: "  " }))));
});
