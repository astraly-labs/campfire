import { scopeProjectRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ScopedProjectRef, UserId } from "@t3tools/contracts";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  deriveProjectGroupLabel,
  type ProjectGroupingSettings,
} from "./logicalProject";
import type { Project } from "./types";
import type { ProjectAffiliationOverride } from "./uiStateStore";

export type EnvironmentPresence = "local-only" | "remote-only" | "mixed";

export interface SidebarProjectGroupMember extends Project {
  physicalProjectKey: string;
  environmentLabel: string | null;
}

export interface SidebarProjectSnapshot extends Project {
  projectKey: string;
  displayName: string;
  groupedProjectCount: number;
  environmentPresence: EnvironmentPresence;
  memberProjects: readonly SidebarProjectGroupMember[];
  memberProjectRefs: readonly ScopedProjectRef[];
  remoteEnvironmentLabels: readonly string[];
}

export function buildPhysicalToLogicalProjectKeyMap(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
}): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const project of input.projects) {
    mapping.set(
      derivePhysicalProjectKey(project),
      deriveLogicalProjectKeyFromSettings(project, input.settings),
    );
  }
  return mapping;
}

export function buildSidebarProjectSnapshots(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
  resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
}): SidebarProjectSnapshot[] {
  const groupedMembers = new Map<string, SidebarProjectGroupMember[]>();
  for (const project of input.projects) {
    const logicalKey = deriveLogicalProjectKeyFromSettings(project, input.settings);
    const member: SidebarProjectGroupMember = {
      ...project,
      physicalProjectKey: derivePhysicalProjectKey(project),
      environmentLabel: input.resolveEnvironmentLabel(project.environmentId),
    };
    const existing = groupedMembers.get(logicalKey);
    if (existing) {
      existing.push(member);
    } else {
      groupedMembers.set(logicalKey, [member]);
    }
  }

  const result: SidebarProjectSnapshot[] = [];
  const seen = new Set<string>();
  for (const project of input.projects) {
    const logicalKey = deriveLogicalProjectKeyFromSettings(project, input.settings);
    if (seen.has(logicalKey)) {
      continue;
    }
    seen.add(logicalKey);

    const members = groupedMembers.get(logicalKey) ?? [];
    const representative =
      (input.primaryEnvironmentId
        ? members.find((member) => member.environmentId === input.primaryEnvironmentId)
        : null) ?? members[0];
    if (!representative) {
      continue;
    }

    const hasLocal =
      input.primaryEnvironmentId !== null &&
      members.some((member) => member.environmentId === input.primaryEnvironmentId);
    const hasRemote =
      input.primaryEnvironmentId !== null
        ? members.some((member) => member.environmentId !== input.primaryEnvironmentId)
        : false;
    const remoteEnvironmentLabels = members
      .filter(
        (member) =>
          input.primaryEnvironmentId !== null &&
          member.environmentId !== input.primaryEnvironmentId,
      )
      .flatMap((member) => (member.environmentLabel ? [member.environmentLabel] : []))
      .filter((label, index, labels) => labels.indexOf(label) === index);

    result.push({
      ...representative,
      projectKey: logicalKey,
      displayName:
        members.length > 1
          ? deriveProjectGroupLabel({
              representative,
              members,
            })
          : representative.name,
      groupedProjectCount: members.length,
      environmentPresence:
        hasLocal && hasRemote ? "mixed" : hasRemote ? "remote-only" : "local-only",
      memberProjects: members,
      memberProjectRefs: members.map((member) => scopeProjectRef(member.environmentId, member.id)),
      remoteEnvironmentLabels,
    });
  }

  return result;
}

export interface ProjectAffiliationInput {
  readonly snapshots: ReadonlyArray<SidebarProjectSnapshot>;
  readonly currentUserId: UserId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly mentionedProjectKeys: ReadonlySet<string>;
  readonly overrideByLogicalKey: Readonly<Record<string, ProjectAffiliationOverride>>;
}

export interface PartitionedSidebarProjects {
  readonly mine: ReadonlyArray<SidebarProjectSnapshot>;
  readonly others: ReadonlyArray<SidebarProjectSnapshot>;
}

/**
 * Splits the sidebar project list into "My projects" (created-by-me OR
 * mentioned OR manually pinned) and "Projects" (the rest). The auto rules
 * can be overridden manually via the menu — overrides are sticky so the
 * user keeps control even when mentions come and go.
 *
 * When `currentUserId` is null (identity still loading) we don't fail open
 * by including everything in "My projects": we treat ownership signals as
 * absent and rely on the persisted override map. The primary-environment
 * fallback applies to legacy projects whose `createdBy` is null.
 */
export function isProjectAffiliatedWithMe(
  snapshot: SidebarProjectSnapshot,
  input: Omit<ProjectAffiliationInput, "snapshots">,
): boolean {
  const override = input.overrideByLogicalKey[snapshot.projectKey];
  if (override === "mine") return true;
  if (override === "other") return false;

  if (input.mentionedProjectKeys.has(snapshot.projectKey)) {
    return true;
  }

  for (const member of snapshot.memberProjects) {
    if (input.currentUserId !== null && member.createdBy?.id === input.currentUserId) {
      return true;
    }
    // Back-compat fallback for projects authored before per-user attribution
    // shipped: anything living on the current primary environment is
    // assumed to belong to this user.
    if (
      member.createdBy === null &&
      input.primaryEnvironmentId !== null &&
      member.environmentId === input.primaryEnvironmentId
    ) {
      return true;
    }
  }

  return false;
}

export function partitionProjectsByAffiliation(
  input: ProjectAffiliationInput,
): PartitionedSidebarProjects {
  const mine: SidebarProjectSnapshot[] = [];
  const others: SidebarProjectSnapshot[] = [];
  for (const snapshot of input.snapshots) {
    if (isProjectAffiliatedWithMe(snapshot, input)) {
      mine.push(snapshot);
    } else {
      others.push(snapshot);
    }
  }
  return { mine, others };
}
