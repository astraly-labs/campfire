import {
  ProviderDriverKind,
  ProviderInstanceId,
  ReviewLoopId,
  ThreadId,
  type ModelSelection,
  type ReviewLoopPhase,
  type ServerProvider,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canStartReviewLoop,
  defaultReviewLoopReviewer,
  findReviewLoopLink,
  modelSelectionLabel,
} from "./reviewLoop.logic";

const STARTED_AT = "2026-10-05T00:00:00.000Z";

function link(
  number: number,
  overrides: Partial<ThreadPullRequestLink> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "pingdotgg/t3code",
    number,
    url: `https://github.com/pingdotgg/t3code/pull/${number}`,
    source: "created",
    linkedAt: STARTED_AT,
    snapshot: null,
    stack: null,
    ...overrides,
  };
}

const author = (phase: ReviewLoopPhase) =>
  ({
    role: "author",
    id: ReviewLoopId.make("loop-1"),
    reviewThreadId: ThreadId.make("thread-review"),
    startedAt: STARTED_AT,
    phase,
  }) as const;

describe("canStartReviewLoop", () => {
  const start = (
    overrides: {
      readonly supported?: boolean;
      readonly canOperate?: boolean;
      readonly thread?: {
        readonly branch: string | null;
        readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
      } | null;
      readonly state?: "open" | "closed" | "merged" | null;
      readonly headBranch?: string | null;
    } = {},
  ) =>
    canStartReviewLoop({
      supported: overrides.supported ?? true,
      canOperate: overrides.canOperate ?? true,
      thread:
        overrides.thread === undefined
          ? { branch: "fix-login", pullRequests: [link(42)] }
          : overrides.thread,
      pullRequest: {
        state: overrides.state === undefined ? "open" : overrides.state,
        headBranch: overrides.headBranch === undefined ? "fix-login" : overrides.headBranch,
      },
    });

  it("offers a loop on the thread's open pull request on its own branch", () => {
    expect(start()).toBe(true);
  });

  it("offers a loop while the host has not said the state or the head branch", () => {
    expect(start({ state: null })).toBe(true);
    expect(start({ headBranch: null })).toBe(true);
    expect(start({ thread: { branch: null, pullRequests: [link(42)] } })).toBe(true);
  });

  it.each([
    ["the server cannot run loops", { supported: false }],
    ["the user cannot operate the environment", { canOperate: false }],
    ["the panel has no thread", { thread: null }],
    ["the pull request is merged", { state: "merged" }],
    ["the pull request is closed", { state: "closed" }],
    ["the head branch is another branch", { headBranch: "someone-else" }],
  ] as const)("hides the loop when %s", (_reason, overrides) => {
    expect(start(overrides)).toBe(false);
  });

  it("hides the loop while one is live on any link of the thread", () => {
    const live = link(41, {
      reviewLoop: author({ status: "fixing", budget: 3, round: 1, open: [] }),
    });
    expect(start({ thread: { branch: "fix-login", pullRequests: [live, link(42)] } })).toBe(false);
  });

  it("hides the loop in a review thread, which holds a reviewer marker", () => {
    const reviewing = link(42, {
      reviewLoop: {
        role: "reviewer",
        id: ReviewLoopId.make("loop-1"),
        sourceThreadId: ThreadId.make("thread-source"),
      },
    });
    expect(start({ thread: { branch: "fix-login", pullRequests: [reviewing] } })).toBe(false);
  });

  it("offers a new loop once the last one ended", () => {
    const ended = link(42, {
      reviewLoop: author({
        status: "ended",
        reason: "approved",
        reviews: 2,
        budget: 3,
        endedAt: STARTED_AT,
      }),
    });
    expect(start({ thread: { branch: "fix-login", pullRequests: [ended] } })).toBe(true);
  });
});

describe("findReviewLoopLink", () => {
  it("finds the thread's visible link to the pull request", () => {
    const target = link(42);
    const links = [link(41), target, link(43, { source: "stack-dismissed" })];
    expect(
      findReviewLoopLink(links, { host: "github.com", repository: "PingDotGG/T3Code", number: 42 }),
    ).toBe(target);
    expect(
      findReviewLoopLink(links, { host: undefined, repository: "pingdotgg/t3code", number: 42 }),
    ).toBe(target);
    expect(
      findReviewLoopLink(links, { host: "github.com", repository: "pingdotgg/t3code", number: 43 }),
    ).toBeNull();
  });
});

describe("defaultReviewLoopReviewer", () => {
  const model = (slug: string, flags: { isCustom?: boolean; isLegacy?: boolean } = {}) => ({
    slug,
    isCustom: flags.isCustom ?? false,
    ...(flags.isLegacy === undefined ? {} : { isLegacy: flags.isLegacy }),
  });
  const codexModels = [
    model("gpt-6-astra"),
    model("gpt-6.1-sol"),
    model("gpt-6.1-terra"),
    model("gpt-6-sol"),
    model("gpt-5.6-sol"),
  ];
  const claude = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driverKind: ProviderDriverKind.make("claudeAgent"),
    models: [model("claude-opus-4-5")],
  };
  const claudeWork = {
    instanceId: ProviderInstanceId.make("claude_work"),
    driverKind: ProviderDriverKind.make("claudeAgent"),
    models: [model("claude-opus-4-5")],
  };
  const codex = {
    instanceId: ProviderInstanceId.make("codex"),
    driverKind: ProviderDriverKind.make("codex"),
    models: codexModels,
  };
  const cursor = {
    instanceId: ProviderInstanceId.make("cursor"),
    driverKind: ProviderDriverKind.make("cursor"),
    models: [model("composer-1")],
  };
  const source: ModelSelection = { instanceId: claude.instanceId, model: "claude-opus-4-5" };
  const reviewerFor = (readyInstances: ReadonlyArray<typeof codex>, author = source) =>
    defaultReviewLoopReviewer({
      source: author,
      sourceDriver:
        readyInstances.find((entry) => entry.instanceId === author.instanceId)?.driverKind ??
        claude.driverKind,
      readyInstances,
    });

  it("picks the newest GPT Sol over an earlier instance and over the author's own model", () => {
    const sol = {
      instanceId: codex.instanceId,
      selection: { instanceId: codex.instanceId, model: "gpt-6.1-sol" },
    };
    expect(reviewerFor([cursor, claude, codex])).toEqual(sol);
    expect(reviewerFor([codex], { instanceId: codex.instanceId, model: "gpt-6-astra" })).toEqual(
      sol,
    );
  });

  it("skips a Sol the user hid or that is legacy", () => {
    expect(
      reviewerFor([
        { ...codex, models: codexModels.filter((entry) => entry.slug !== "gpt-6.1-sol") },
      ]),
    ).toEqual({
      instanceId: codex.instanceId,
      selection: { instanceId: codex.instanceId, model: "gpt-6-sol" },
    });
    expect(
      reviewerFor([
        {
          ...codex,
          models: codexModels.map((entry) =>
            entry.slug === "gpt-6.1-sol" ? model("gpt-6.1-sol", { isLegacy: true }) : entry,
          ),
        },
      ])?.selection?.model,
    ).toBe("gpt-6-sol");
  });

  it("looks past a Codex instance that offers no Sol", () => {
    const noSol = {
      ...codex,
      instanceId: ProviderInstanceId.make("codex_work"),
      models: [model("gpt-6-astra"), model("gpt-7-sol", { isCustom: true })],
    };
    expect(reviewerFor([noSol, codex])?.instanceId).toBe(codex.instanceId);
  });

  it("without a Sol, picks the first ready instance on another driver than the author's", () => {
    const astra = { ...codex, models: [model("gpt-6-astra")] };
    expect(reviewerFor([claude, claudeWork, astra])).toEqual({
      instanceId: codex.instanceId,
      selection: null,
    });
    expect(reviewerFor([claudeWork, cursor, astra])).toEqual({
      instanceId: cursor.instanceId,
      selection: null,
    });
  });

  it("falls back to the author's own model when every ready instance shares its driver", () => {
    expect(reviewerFor([claudeWork, claude])).toEqual({
      instanceId: claude.instanceId,
      selection: source,
    });
    expect(reviewerFor([claudeWork])).toEqual({
      instanceId: claudeWork.instanceId,
      selection: null,
    });
  });

  it("offers no reviewer when no instance is ready", () => {
    expect(reviewerFor([])).toBeNull();
  });
});

describe("modelSelectionLabel", () => {
  const cursor: ServerProvider = {
    instanceId: ProviderInstanceId.make("cursor"),
    driver: ProviderDriverKind.make("cursor"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: STARTED_AT,
    models: [{ slug: "composer-1", name: "Composer 1", isCustom: false, capabilities: {} }],
    slashCommands: [],
    skills: [],
  };

  it("names the instance and the model", () => {
    expect(
      modelSelectionLabel([cursor], { instanceId: cursor.instanceId, model: "composer-1" }),
    ).toBe("Cursor · Composer 1");
    expect(
      modelSelectionLabel([cursor], { instanceId: cursor.instanceId, model: "composer-2" }),
    ).toBe("Cursor · composer-2");
  });
});
