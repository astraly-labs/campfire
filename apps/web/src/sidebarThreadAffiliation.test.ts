import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, UserId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "./sidebarProjectGrouping";
import {
  isThreadAffiliatedWithMe,
  partitionProjectsBySectionedThreads,
  partitionThreadsByAffiliation,
} from "./sidebarThreadAffiliation";
import type { Project, SidebarThreadSummary } from "./types";

const primaryEnvId = EnvironmentId.make("env-primary");
const remoteEnvId = EnvironmentId.make("env-remote");
const meId = UserId.make("user-me");
const otherId = UserId.make("user-other");

const meRef = { id: meId, displayName: "Me" };
const otherRef = { id: otherId, displayName: "Other" };

const GROUPING_SETTINGS = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function makeProject(overrides: Partial<Project> & Pick<Project, "id" | "environmentId">): Project {
  return {
    name: "Project",
    cwd: `/tmp/${overrides.id}`,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    createdBy: null,
    ...overrides,
  };
}

function makeSnapshots(projects: ReadonlyArray<Project>): ReadonlyArray<SidebarProjectSnapshot> {
  return buildSidebarProjectSnapshots({
    projects,
    settings: GROUPING_SETTINGS,
    primaryEnvironmentId: primaryEnvId,
    resolveEnvironmentLabel: () => null,
  });
}

function makeThread(
  overrides: Partial<SidebarThreadSummary> &
    Pick<SidebarThreadSummary, "id" | "environmentId" | "projectId">,
): SidebarThreadSummary {
  return {
    title: `Thread ${overrides.id}`,
    interactionMode: "default",
    session: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    createdBy: null,
    ...overrides,
  };
}

function memberResolverFromSnapshots(
  snapshots: ReadonlyArray<SidebarProjectSnapshot>,
): (thread: SidebarThreadSummary) => SidebarProjectGroupMember | null {
  return (thread) => {
    for (const snapshot of snapshots) {
      const found = snapshot.memberProjects.find(
        (member) => member.id === thread.projectId && member.environmentId === thread.environmentId,
      );
      if (found) return found;
    }
    return null;
  };
}

describe("isThreadAffiliatedWithMe", () => {
  it("respects per-thread override 'mine' over every auto signal", () => {
    const projectId = ProjectId.make("p-other");
    const threadId = ThreadId.make("t-1");
    const snapshots = makeSnapshots([
      makeProject({ id: projectId, environmentId: remoteEnvId, createdBy: otherRef }),
    ]);
    const thread = makeThread({
      id: threadId,
      environmentId: remoteEnvId,
      projectId,
      createdBy: otherRef,
    });
    const overrideKey = scopedThreadKey(scopeThreadRef(remoteEnvId, threadId));

    const result = isThreadAffiliatedWithMe(thread, {
      currentUserId: meId,
      primaryEnvironmentId: primaryEnvId,
      mentionedThreadIds: new Set(),
      overrideByThreadKey: { [overrideKey]: "mine" },
      resolveProjectMember: memberResolverFromSnapshots(snapshots),
    });

    expect(result).toBe(true);
  });

  it("respects per-thread override 'other' against author identity and mentions", () => {
    const projectId = ProjectId.make("p-mine");
    const threadId = ThreadId.make("t-1");
    const snapshots = makeSnapshots([
      makeProject({ id: projectId, environmentId: primaryEnvId, createdBy: meRef }),
    ]);
    const thread = makeThread({
      id: threadId,
      environmentId: primaryEnvId,
      projectId,
      createdBy: meRef,
    });
    const overrideKey = scopedThreadKey(scopeThreadRef(primaryEnvId, threadId));

    const result = isThreadAffiliatedWithMe(thread, {
      currentUserId: meId,
      primaryEnvironmentId: primaryEnvId,
      mentionedThreadIds: new Set([threadId]),
      overrideByThreadKey: { [overrideKey]: "other" },
      resolveProjectMember: memberResolverFromSnapshots(snapshots),
    });

    expect(result).toBe(false);
  });

  it("treats mentioned threads as mine", () => {
    const projectId = ProjectId.make("p-other");
    const threadId = ThreadId.make("t-1");
    const snapshots = makeSnapshots([
      makeProject({ id: projectId, environmentId: remoteEnvId, createdBy: otherRef }),
    ]);
    const thread = makeThread({
      id: threadId,
      environmentId: remoteEnvId,
      projectId,
      createdBy: otherRef,
    });

    const result = isThreadAffiliatedWithMe(thread, {
      currentUserId: meId,
      primaryEnvironmentId: primaryEnvId,
      mentionedThreadIds: new Set([threadId]),
      overrideByThreadKey: {},
      resolveProjectMember: memberResolverFromSnapshots(snapshots),
    });

    expect(result).toBe(true);
  });

  it("uses thread.createdBy when available", () => {
    const projectId = ProjectId.make("p-shared");
    const snapshots = makeSnapshots([
      makeProject({ id: projectId, environmentId: primaryEnvId, createdBy: otherRef }),
    ]);
    const mine = makeThread({
      id: ThreadId.make("t-mine"),
      environmentId: primaryEnvId,
      projectId,
      createdBy: meRef,
    });
    const theirs = makeThread({
      id: ThreadId.make("t-theirs"),
      environmentId: primaryEnvId,
      projectId,
      createdBy: otherRef,
    });

    const input = {
      currentUserId: meId,
      primaryEnvironmentId: primaryEnvId,
      mentionedThreadIds: new Set<ThreadId>(),
      overrideByThreadKey: {},
      resolveProjectMember: memberResolverFromSnapshots(snapshots),
    };

    expect(isThreadAffiliatedWithMe(mine, input)).toBe(true);
    expect(isThreadAffiliatedWithMe(theirs, input)).toBe(false);
  });

  it("falls back to project.createdBy when thread.createdBy is null", () => {
    const projectId = ProjectId.make("p-mine");
    const snapshots = makeSnapshots([
      makeProject({ id: projectId, environmentId: remoteEnvId, createdBy: meRef }),
    ]);
    const thread = makeThread({
      id: ThreadId.make("t-legacy"),
      environmentId: remoteEnvId,
      projectId,
      createdBy: null,
    });

    const result = isThreadAffiliatedWithMe(thread, {
      currentUserId: meId,
      primaryEnvironmentId: primaryEnvId,
      mentionedThreadIds: new Set(),
      overrideByThreadKey: {},
      resolveProjectMember: memberResolverFromSnapshots(snapshots),
    });

    expect(result).toBe(true);
  });

  it("falls back to primary-environment heuristic when both authorship fields are null", () => {
    const projectId = ProjectId.make("p-legacy");
    const snapshots = makeSnapshots([
      makeProject({ id: projectId, environmentId: primaryEnvId, createdBy: null }),
    ]);
    const thread = makeThread({
      id: ThreadId.make("t-legacy"),
      environmentId: primaryEnvId,
      projectId,
      createdBy: null,
    });

    const result = isThreadAffiliatedWithMe(thread, {
      currentUserId: meId,
      primaryEnvironmentId: primaryEnvId,
      mentionedThreadIds: new Set(),
      overrideByThreadKey: {},
      resolveProjectMember: memberResolverFromSnapshots(snapshots),
    });

    expect(result).toBe(true);
  });
});

describe("partitionThreadsByAffiliation", () => {
  it("splits a mixed list keeping original ordering inside each bucket", () => {
    const projectId = ProjectId.make("p-shared");
    const snapshots = makeSnapshots([
      makeProject({ id: projectId, environmentId: primaryEnvId, createdBy: otherRef }),
    ]);
    const threads = [
      makeThread({
        id: ThreadId.make("t-1-mine"),
        environmentId: primaryEnvId,
        projectId,
        createdBy: meRef,
      }),
      makeThread({
        id: ThreadId.make("t-2-theirs"),
        environmentId: primaryEnvId,
        projectId,
        createdBy: otherRef,
      }),
      makeThread({
        id: ThreadId.make("t-3-mine"),
        environmentId: primaryEnvId,
        projectId,
        createdBy: meRef,
      }),
    ];

    const partition = partitionThreadsByAffiliation(threads, {
      currentUserId: meId,
      primaryEnvironmentId: primaryEnvId,
      mentionedThreadIds: new Set(),
      overrideByThreadKey: {},
      resolveProjectMember: memberResolverFromSnapshots(snapshots),
    });

    expect(partition.mine.map((t) => t.id)).toEqual([
      ThreadId.make("t-1-mine"),
      ThreadId.make("t-3-mine"),
    ]);
    expect(partition.others.map((t) => t.id)).toEqual([ThreadId.make("t-2-theirs")]);
  });
});

describe("partitionProjectsBySectionedThreads", () => {
  it("renders a single project under both sections when threads straddle", () => {
    const projectId = ProjectId.make("p-shared");
    const snapshots = makeSnapshots([
      makeProject({ id: projectId, environmentId: primaryEnvId, createdBy: otherRef }),
    ]);
    const mine = makeThread({
      id: ThreadId.make("t-mine"),
      environmentId: primaryEnvId,
      projectId,
      createdBy: meRef,
    });
    const theirs = makeThread({
      id: ThreadId.make("t-theirs"),
      environmentId: primaryEnvId,
      projectId,
      createdBy: otherRef,
    });
    const threadsByProjectKey = new Map([[snapshots[0]!.projectKey, [mine, theirs]]]);

    const partition = partitionProjectsBySectionedThreads({
      snapshots,
      threadsByProjectKey,
      currentUserId: meId,
      primaryEnvironmentId: primaryEnvId,
      mentionedThreadIds: new Set(),
      overrideByThreadKey: {},
      resolveProjectMember: memberResolverFromSnapshots(snapshots),
    });

    expect(partition.mine).toHaveLength(1);
    expect(partition.mine[0]!.snapshot.id).toBe(projectId);
    expect(partition.mine[0]!.threads.map((t) => t.id)).toEqual([ThreadId.make("t-mine")]);

    expect(partition.others).toHaveLength(1);
    expect(partition.others[0]!.snapshot.id).toBe(projectId);
    expect(partition.others[0]!.threads.map((t) => t.id)).toEqual([ThreadId.make("t-theirs")]);
  });

  it("shows an empty project under My projects when its createdBy = me", () => {
    const projectId = ProjectId.make("p-empty-mine");
    const snapshots = makeSnapshots([
      makeProject({ id: projectId, environmentId: primaryEnvId, createdBy: meRef }),
    ]);

    const partition = partitionProjectsBySectionedThreads({
      snapshots,
      threadsByProjectKey: new Map(),
      currentUserId: meId,
      primaryEnvironmentId: primaryEnvId,
      mentionedThreadIds: new Set(),
      overrideByThreadKey: {},
      resolveProjectMember: memberResolverFromSnapshots(snapshots),
    });

    expect(partition.mine.map((i) => i.snapshot.id)).toEqual([projectId]);
    expect(partition.others).toEqual([]);
  });

  it("shows an empty foreign project only under Projects", () => {
    const projectId = ProjectId.make("p-empty-other");
    const snapshots = makeSnapshots([
      makeProject({ id: projectId, environmentId: remoteEnvId, createdBy: otherRef }),
    ]);

    const partition = partitionProjectsBySectionedThreads({
      snapshots,
      threadsByProjectKey: new Map(),
      currentUserId: meId,
      primaryEnvironmentId: primaryEnvId,
      mentionedThreadIds: new Set(),
      overrideByThreadKey: {},
      resolveProjectMember: memberResolverFromSnapshots(snapshots),
    });

    expect(partition.mine).toEqual([]);
    expect(partition.others.map((i) => i.snapshot.id)).toEqual([projectId]);
  });
});
