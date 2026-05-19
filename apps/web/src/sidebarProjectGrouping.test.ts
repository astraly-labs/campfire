import { EnvironmentId, ProjectId, ProviderInstanceId, UserId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildSidebarProjectSnapshots,
  partitionProjectsByAffiliation,
  type SidebarProjectSnapshot,
} from "./sidebarProjectGrouping";
import type { Project } from "./types";

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

describe("partitionProjectsByAffiliation", () => {
  it("puts createdBy = currentUser into My projects", () => {
    const snapshots = makeSnapshots([
      makeProject({ id: ProjectId.make("p-mine"), environmentId: primaryEnvId, createdBy: meRef }),
      makeProject({
        id: ProjectId.make("p-theirs"),
        environmentId: primaryEnvId,
        createdBy: otherRef,
      }),
    ]);

    const partition = partitionProjectsByAffiliation({
      snapshots,
      currentUserId: meId,
      primaryEnvironmentId: primaryEnvId,
      mentionedProjectKeys: new Set(),
      overrideByLogicalKey: {},
    });

    expect(partition.mine.map((p) => p.id)).toEqual([ProjectId.make("p-mine")]);
    expect(partition.others.map((p) => p.id)).toEqual([ProjectId.make("p-theirs")]);
  });

  it("falls back to primary-environment heuristic when createdBy is null", () => {
    const snapshots = makeSnapshots([
      makeProject({
        id: ProjectId.make("p-legacy-local"),
        environmentId: primaryEnvId,
        createdBy: null,
      }),
      makeProject({
        id: ProjectId.make("p-legacy-remote"),
        environmentId: remoteEnvId,
        createdBy: null,
      }),
    ]);

    const partition = partitionProjectsByAffiliation({
      snapshots,
      currentUserId: meId,
      primaryEnvironmentId: primaryEnvId,
      mentionedProjectKeys: new Set(),
      overrideByLogicalKey: {},
    });

    expect(partition.mine.map((p) => p.id)).toEqual([ProjectId.make("p-legacy-local")]);
    expect(partition.others.map((p) => p.id)).toEqual([ProjectId.make("p-legacy-remote")]);
  });

  it("auto-promotes a mentioned project to My projects", () => {
    const mentioned = makeProject({
      id: ProjectId.make("p-mentioned"),
      environmentId: remoteEnvId,
      createdBy: otherRef,
    });
    const snapshots = makeSnapshots([mentioned]);

    const partition = partitionProjectsByAffiliation({
      snapshots,
      currentUserId: meId,
      primaryEnvironmentId: primaryEnvId,
      mentionedProjectKeys: new Set([snapshots[0]!.projectKey]),
      overrideByLogicalKey: {},
    });

    expect(partition.mine.map((p) => p.id)).toEqual([ProjectId.make("p-mentioned")]);
    expect(partition.others).toEqual([]);
  });

  it("respects manual override 'mine' even without ownership or mention", () => {
    const snapshots = makeSnapshots([
      makeProject({
        id: ProjectId.make("p-other"),
        environmentId: remoteEnvId,
        createdBy: otherRef,
      }),
    ]);

    const partition = partitionProjectsByAffiliation({
      snapshots,
      currentUserId: meId,
      primaryEnvironmentId: primaryEnvId,
      mentionedProjectKeys: new Set(),
      overrideByLogicalKey: { [snapshots[0]!.projectKey]: "mine" },
    });

    expect(partition.mine.map((p) => p.id)).toEqual([ProjectId.make("p-other")]);
  });

  it("respects manual override 'other' even when ownership or mention would auto-include", () => {
    const snapshots = makeSnapshots([
      makeProject({ id: ProjectId.make("p-mine"), environmentId: primaryEnvId, createdBy: meRef }),
    ]);

    const partition = partitionProjectsByAffiliation({
      snapshots,
      currentUserId: meId,
      primaryEnvironmentId: primaryEnvId,
      mentionedProjectKeys: new Set([snapshots[0]!.projectKey]),
      overrideByLogicalKey: { [snapshots[0]!.projectKey]: "other" },
    });

    expect(partition.mine).toEqual([]);
    expect(partition.others.map((p) => p.id)).toEqual([ProjectId.make("p-mine")]);
  });

  it("treats null currentUserId as identity-not-yet-loaded — fallback only on env heuristic", () => {
    const snapshots = makeSnapshots([
      makeProject({ id: ProjectId.make("p-with-creator"), environmentId: primaryEnvId, createdBy: meRef }),
      makeProject({ id: ProjectId.make("p-legacy"), environmentId: primaryEnvId, createdBy: null }),
    ]);

    const partition = partitionProjectsByAffiliation({
      snapshots,
      currentUserId: null,
      primaryEnvironmentId: primaryEnvId,
      mentionedProjectKeys: new Set(),
      overrideByLogicalKey: {},
    });

    // Creator-based check requires currentUserId, so falls to the env heuristic
    // (which still matches both since they're on the primary env).
    expect(partition.mine.map((p) => p.id)).toEqual([ProjectId.make("p-legacy")]);
    // p-with-creator has a non-null createdBy so it doesn't trigger the
    // legacy fallback either — it goes to Others.
    expect(partition.others.map((p) => p.id)).toEqual([ProjectId.make("p-with-creator")]);
  });
});
