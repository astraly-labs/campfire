import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
  prompt: "/review #42",
  startedAt: "2026-01-01T00:00:00.000Z",
  phase: { status: "fixing", round: 2 },
};
const reviewer = { role: "reviewer", id: "review-loop:1", sourceThreadId: "thread:source" };

it.effect("decodes a link's review loop as the author record or the reviewer marker", () =>
  Effect.gen(function* () {
    const [plain, source, review] = yield* decodeLinks([
      link,
      { ...link, reviewLoop: author },
      { ...link, reviewLoop: reviewer },
    ]);

    assert.strictEqual(plain?.reviewLoop, undefined);
    assert.deepStrictEqual<unknown>(source?.reviewLoop, author);
    assert.deepStrictEqual<unknown>(review?.reviewLoop, reviewer);
  }),
);

it.effect("decodes a review loop from a newer server as absent and keeps the link", () =>
  Effect.gen(function* () {
    const links = yield* decodeLinks([
      { ...link, reviewLoop: { ...author, phase: { status: "reviewing", round: 4 } } },
      { ...link, reviewLoop: { ...author, phase: { status: "paused" } } },
      {
        ...link,
        reviewLoop: {
          ...author,
          phase: { status: "ended", reason: "timed_out", reviews: 1, endedAt: author.startedAt },
        },
      },
      { ...link, reviewLoop: { role: "observer", id: "review-loop:1" } },
    ]);

    assert.deepStrictEqual(
      links.map((decoded) => [decoded.number, decoded.reviewLoop]),
      [
        [42, undefined],
        [42, undefined],
        [42, undefined],
        [42, undefined],
      ],
    );
  }),
);

it("caps a loop at three reviews and two fixes", () => {
  const decodePhase = Schema.decodeUnknownOption(ReviewLoopPhase);

  assert.isTrue(Option.isSome(decodePhase({ status: "reviewing", round: 3 })));
  assert.isTrue(Option.isNone(decodePhase({ status: "reviewing", round: 4 })));
  assert.isTrue(Option.isSome(decodePhase({ status: "fixing", round: 2 })));
  assert.isTrue(Option.isNone(decodePhase({ status: "fixing", round: 3 })));
});
