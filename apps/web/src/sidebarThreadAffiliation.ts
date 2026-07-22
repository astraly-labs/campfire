import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { CollaborationUser, EnvironmentId } from "@t3tools/contracts";

import type { SidebarProjectSnapshot } from "./sidebarProjectGrouping";
import type { SidebarThreadSummary } from "./types";

export interface SidebarProjectSectionInstance {
  readonly snapshot: SidebarProjectSnapshot;
  readonly section: "mine" | "other";
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
}

export function isGoogleOwnedByCurrentAccount(input: {
  readonly createdBy: CollaborationUser | null | undefined;
  readonly fallbackCreatedBy: CollaborationUser | null | undefined;
  readonly environmentId: EnvironmentId;
  readonly currentGoogleSubject: string | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  if (input.createdBy?.subject.startsWith("google:")) {
    return input.createdBy.subject === input.currentGoogleSubject;
  }
  if (input.fallbackCreatedBy?.subject.startsWith("google:")) {
    return input.fallbackCreatedBy.subject === input.currentGoogleSubject;
  }
  return (
    input.fallbackCreatedBy == null &&
    input.primaryEnvironmentId !== null &&
    input.environmentId === input.primaryEnvironmentId
  );
}

function owningProject(snapshot: SidebarProjectSnapshot, thread: SidebarThreadSummary) {
  const key = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
  return (
    snapshot.memberProjects.find(
      (member) => scopedProjectKey(scopeProjectRef(member.environmentId, member.id)) === key,
    ) ?? null
  );
}

export function isThreadOwnedByGoogleAccount(input: {
  readonly snapshot: SidebarProjectSnapshot;
  readonly thread: SidebarThreadSummary;
  readonly currentGoogleSubject: string | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  const project = owningProject(input.snapshot, input.thread);
  return isGoogleOwnedByCurrentAccount({
    createdBy: input.thread.createdBy,
    fallbackCreatedBy: project?.createdBy,
    environmentId: input.thread.environmentId,
    currentGoogleSubject: input.currentGoogleSubject,
    primaryEnvironmentId: input.primaryEnvironmentId,
  });
}

export function partitionSidebarProjectsByGoogleOwner(input: {
  readonly snapshots: ReadonlyArray<SidebarProjectSnapshot>;
  readonly threadsByProjectKey: ReadonlyMap<string, ReadonlyArray<SidebarThreadSummary>>;
  readonly currentGoogleSubject: string | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): {
  readonly mine: ReadonlyArray<SidebarProjectSectionInstance>;
  readonly others: ReadonlyArray<SidebarProjectSectionInstance>;
} {
  const mine: SidebarProjectSectionInstance[] = [];
  const others: SidebarProjectSectionInstance[] = [];

  for (const snapshot of input.snapshots) {
    const threads = input.threadsByProjectKey.get(snapshot.projectKey) ?? [];
    const mineThreads: SidebarThreadSummary[] = [];
    const otherThreads: SidebarThreadSummary[] = [];
    for (const thread of threads) {
      (isThreadOwnedByGoogleAccount({
        snapshot,
        thread,
        currentGoogleSubject: input.currentGoogleSubject,
        primaryEnvironmentId: input.primaryEnvironmentId,
      })
        ? mineThreads
        : otherThreads
      ).push(thread);
    }

    if (mineThreads.length > 0) {
      mine.push({ snapshot, section: "mine", threads: mineThreads });
    }
    if (otherThreads.length > 0) {
      others.push({ snapshot, section: "other", threads: otherThreads });
    }
    if (threads.length > 0) continue;

    const emptyBelongsToCurrentUser = snapshot.memberProjects.some((project) => {
      if (project.createdBy?.subject.startsWith("google:")) {
        return project.createdBy.subject === input.currentGoogleSubject;
      }
      return (
        project.createdBy == null &&
        input.primaryEnvironmentId !== null &&
        project.environmentId === input.primaryEnvironmentId
      );
    });
    (emptyBelongsToCurrentUser ? mine : others).push({
      snapshot,
      section: emptyBelongsToCurrentUser ? "mine" : "other",
      threads: [],
    });
  }

  return { mine, others };
}
