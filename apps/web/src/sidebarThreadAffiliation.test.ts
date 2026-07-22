import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { SidebarProjectSnapshot } from "./sidebarProjectGrouping";
import { partitionSidebarProjectsByGoogleOwner } from "./sidebarThreadAffiliation";
import type { SidebarThreadSummary } from "./types";

const environmentId = EnvironmentId.make("campfire");
const projectId = ProjectId.make("project");
const baseProject = {
  environmentId,
  id: projectId,
  title: "Campfire",
  workspaceRoot: "/campfire",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
  createdBy: { subject: "google:alice", displayName: "Alice" },
};
const snapshot: SidebarProjectSnapshot = {
  ...baseProject,
  projectKey: "campfire-project",
  displayName: "Campfire",
  groupedProjectCount: 1,
  environmentPresence: "local-only",
  allRemoteMembersAreDesktopLocal: false,
  memberProjects: [
    { ...baseProject, physicalProjectKey: "campfire-project", environmentLabel: "Campfire" },
  ],
  memberProjectRefs: [{ environmentId, projectId }],
  remoteEnvironmentLabels: [],
};

function thread(id: string, subject: string): SidebarThreadSummary {
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    createdBy: { subject, displayName: subject },
  };
}

describe("partitionSidebarProjectsByGoogleOwner", () => {
  it("splits one project across My Projects and Projects by stable Google subject", () => {
    const result = partitionSidebarProjectsByGoogleOwner({
      snapshots: [snapshot],
      threadsByProjectKey: new Map([
        [snapshot.projectKey, [thread("mine", "google:alice"), thread("theirs", "google:bob")]],
      ]),
      currentGoogleSubject: "google:alice",
      primaryEnvironmentId: environmentId,
    });

    expect(result.mine[0]?.threads.map((entry) => entry.id)).toEqual(["mine"]);
    expect(result.others[0]?.threads.map((entry) => entry.id)).toEqual(["theirs"]);
  });
});
