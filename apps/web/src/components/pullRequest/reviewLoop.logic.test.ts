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
    prompt: "/review #42",
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
    const live = link(41, { reviewLoop: author({ status: "fixing", round: 1 }) });
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
      reviewLoop: author({ status: "ended", reason: "clean", reviews: 2, endedAt: STARTED_AT }),
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
  const claude = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driverKind: ProviderDriverKind.make("claudeAgent"),
  };
  const claudeWork = {
    instanceId: ProviderInstanceId.make("claude_work"),
    driverKind: ProviderDriverKind.make("claudeAgent"),
  };
  const codex = {
    instanceId: ProviderInstanceId.make("codex"),
    driverKind: ProviderDriverKind.make("codex"),
  };
  const cursor = {
    instanceId: ProviderInstanceId.make("cursor"),
    driverKind: ProviderDriverKind.make("cursor"),
  };
  const source: ModelSelection = { instanceId: claude.instanceId, model: "claude-opus-4-5" };
  const projectReviewer: ModelSelection = {
    instanceId: cursor.instanceId,
    model: "composer-1",
    options: [{ id: "reasoningEffort", value: "high" }],
  };

  it("keeps the project's review model, options included, when its instance is ready", () => {
    expect(
      defaultReviewLoopReviewer({
        projectReviewer,
        source,
        sourceDriver: claude.driverKind,
        readyInstances: [claude, codex, cursor],
      }),
    ).toEqual({ instanceId: cursor.instanceId, selection: projectReviewer });
  });

  it("picks the first ready instance on another driver than the code's author", () => {
    expect(
      defaultReviewLoopReviewer({
        projectReviewer,
        source,
        sourceDriver: claude.driverKind,
        readyInstances: [claude, claudeWork, codex],
      }),
    ).toEqual({ instanceId: codex.instanceId, selection: null });
    expect(
      defaultReviewLoopReviewer({
        projectReviewer: null,
        source,
        sourceDriver: claude.driverKind,
        readyInstances: [claudeWork, cursor, codex],
      }),
    ).toEqual({ instanceId: cursor.instanceId, selection: null });
  });

  it("falls back to the author's own model when every ready instance shares its driver", () => {
    expect(
      defaultReviewLoopReviewer({
        projectReviewer: null,
        source,
        sourceDriver: claude.driverKind,
        readyInstances: [claudeWork, claude],
      }),
    ).toEqual({ instanceId: claude.instanceId, selection: source });
    expect(
      defaultReviewLoopReviewer({
        projectReviewer: null,
        source,
        sourceDriver: claude.driverKind,
        readyInstances: [claudeWork],
      }),
    ).toEqual({ instanceId: claudeWork.instanceId, selection: null });
  });

  it("offers no reviewer when no instance is ready", () => {
    expect(
      defaultReviewLoopReviewer({
        projectReviewer,
        source,
        sourceDriver: claude.driverKind,
        readyInstances: [],
      }),
    ).toBeNull();
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
