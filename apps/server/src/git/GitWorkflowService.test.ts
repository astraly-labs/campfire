import { assert, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GitCommandError } from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

function makeLayer(input: { readonly detect: VcsDriverRegistry.VcsDriverRegistryShape["detect"] }) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
  );
}

describe("GitWorkflowService", () => {
  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  describe("createWorktree with fetchFromRemote", () => {
    // Only `kind === "git"` is read by `ensureGitCommand`; the rest of the
    // handle is irrelevant for these orchestration tests.
    const gitRepoHandle = {
      kind: "git" as const,
    } as unknown as VcsDriverRegistry.VcsDriverHandle;

    function makeCreateWorktreeLayer(driverOverrides: Partial<GitVcsDriver.GitVcsDriverShape>) {
      const createWorktree = vi.fn(
        (input: Parameters<GitVcsDriver.GitVcsDriverShape["createWorktree"]>[0]) =>
          Effect.succeed({
            worktree: { path: "/wt/path", refName: input.newRefName ?? input.refName },
          }),
      );
      const layer = GitWorkflowService.layer.pipe(
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            resolve: () => Effect.succeed(gitRepoHandle),
          }),
        ),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            createWorktree,
            ...driverOverrides,
          }),
        ),
        Layer.provide(Layer.mock(GitManager.GitManager)({})),
      );
      return { layer, createWorktree };
    }

    it.effect("skips fetch when fetchFromRemote is absent", () => {
      const { layer, createWorktree } = makeCreateWorktreeLayer({});
      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const result = yield* workflow.createWorktree({
          cwd: "/repo",
          refName: "main",
          path: null,
        });
        assert.equal(createWorktree.mock.calls.length, 1);
        assert.equal(createWorktree.mock.calls[0]?.[0]?.refName, "main");
        assert.equal(result.fetchWarning, undefined);
      }).pipe(Effect.provide(layer));
    });

    it.effect("rewrites refName to origin/<branch> after a successful fetch", () => {
      const fetchRemoteTrackingBranch = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriverShape["fetchRemoteTrackingBranch"]>[0]) =>
          Effect.void,
      );
      const { layer, createWorktree } = makeCreateWorktreeLayer({
        resolvePrimaryRemoteName: () => Effect.succeed("origin"),
        remoteBranchExists: () => Effect.succeed(true),
        fetchRemoteTrackingBranch,
      });
      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const result = yield* workflow.createWorktree({
          cwd: "/repo",
          refName: "main",
          path: null,
          fetchFromRemote: true,
        });
        assert.equal(fetchRemoteTrackingBranch.mock.calls.length, 1);
        assert.deepEqual(fetchRemoteTrackingBranch.mock.calls[0]?.[0], {
          cwd: "/repo",
          remoteName: "origin",
          remoteBranch: "main",
        });
        assert.equal(createWorktree.mock.calls[0]?.[0]?.refName, "origin/main");
        assert.equal(result.fetchWarning, undefined);
      }).pipe(Effect.provide(layer));
    });

    it.effect("falls back to the local refName and sets fetchWarning when fetch fails", () => {
      const fetchRemoteTrackingBranch = vi.fn(() =>
        Effect.fail(
          new GitCommandError({
            operation: "test.fetch",
            command: "git fetch",
            cwd: "/repo",
            detail: "boom",
          }),
        ),
      );
      const { layer, createWorktree } = makeCreateWorktreeLayer({
        resolvePrimaryRemoteName: () => Effect.succeed("origin"),
        remoteBranchExists: () => Effect.succeed(true),
        fetchRemoteTrackingBranch,
      });
      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const result = yield* workflow.createWorktree({
          cwd: "/repo",
          refName: "main",
          path: null,
          fetchFromRemote: true,
        });
        assert.equal(fetchRemoteTrackingBranch.mock.calls.length, 1);
        assert.equal(createWorktree.mock.calls[0]?.[0]?.refName, "main");
        assert.equal(result.fetchWarning, "Could not fetch from origin, using local state");
      }).pipe(Effect.provide(layer));
    });

    it.effect("does not double-prefix when refName is already origin/<branch>", () => {
      const fetchRemoteTrackingBranch = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriverShape["fetchRemoteTrackingBranch"]>[0]) =>
          Effect.void,
      );
      const { layer, createWorktree } = makeCreateWorktreeLayer({
        resolvePrimaryRemoteName: () => Effect.succeed("origin"),
        remoteBranchExists: () => Effect.succeed(true),
        fetchRemoteTrackingBranch,
      });
      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* workflow.createWorktree({
          cwd: "/repo",
          refName: "origin/main",
          path: null,
          fetchFromRemote: true,
        });
        assert.deepEqual(fetchRemoteTrackingBranch.mock.calls[0]?.[0], {
          cwd: "/repo",
          remoteName: "origin",
          remoteBranch: "main",
        });
        assert.equal(createWorktree.mock.calls[0]?.[0]?.refName, "origin/main");
      }).pipe(Effect.provide(layer));
    });

    it.effect("skips fetch silently when no remote tracking branch exists", () => {
      const fetchRemoteTrackingBranch = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriverShape["fetchRemoteTrackingBranch"]>[0]) =>
          Effect.void,
      );
      const { layer, createWorktree } = makeCreateWorktreeLayer({
        resolvePrimaryRemoteName: () => Effect.succeed("origin"),
        remoteBranchExists: () => Effect.succeed(false),
        fetchRemoteTrackingBranch,
      });
      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const result = yield* workflow.createWorktree({
          cwd: "/repo",
          refName: "my-local-only-branch",
          path: null,
          fetchFromRemote: true,
        });
        assert.equal(fetchRemoteTrackingBranch.mock.calls.length, 0);
        assert.equal(createWorktree.mock.calls[0]?.[0]?.refName, "my-local-only-branch");
        assert.equal(result.fetchWarning, undefined);
      }).pipe(Effect.provide(layer));
    });

    it.effect("skips fetch silently when no remote is configured", () => {
      const fetchRemoteTrackingBranch = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriverShape["fetchRemoteTrackingBranch"]>[0]) =>
          Effect.void,
      );
      const { layer, createWorktree } = makeCreateWorktreeLayer({
        resolvePrimaryRemoteName: () =>
          Effect.fail(
            new GitCommandError({
              operation: "test.no-remote",
              command: "git remote",
              cwd: "/repo",
              detail: "no remote",
            }),
          ),
        fetchRemoteTrackingBranch,
      });
      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const result = yield* workflow.createWorktree({
          cwd: "/repo",
          refName: "main",
          path: null,
          fetchFromRemote: true,
        });
        assert.equal(fetchRemoteTrackingBranch.mock.calls.length, 0);
        assert.equal(createWorktree.mock.calls[0]?.[0]?.refName, "main");
        assert.equal(result.fetchWarning, undefined);
      }).pipe(Effect.provide(layer));
    });
  });
});
