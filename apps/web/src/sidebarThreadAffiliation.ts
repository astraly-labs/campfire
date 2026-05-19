import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import type { EnvironmentId, ThreadId, UserId } from "@t3tools/contracts";
import type { SidebarProjectGroupMember, SidebarProjectSnapshot } from "./sidebarProjectGrouping";
import type { SidebarThreadSummary } from "./types";

export type ThreadAffiliationOverride = "mine" | "other";

export interface ThreadAffiliationInput {
  readonly currentUserId: UserId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly mentionedThreadIds: ReadonlySet<ThreadId>;
  readonly overrideByThreadKey: Readonly<Record<string, ThreadAffiliationOverride>>;
  /**
   * Looks up the project member (within the parent snapshot's grouped
   * members) that owns a given thread, used for the legacy fallback when
   * `thread.createdBy` is null and we have to lean on project authorship
   * or the primary-environment heuristic.
   */
  readonly resolveProjectMember: (thread: SidebarThreadSummary) => SidebarProjectGroupMember | null;
}

/**
 * Decides whether a single sidebar thread belongs to "My projects" for the
 * current user. The ordering encodes precedence: explicit overrides win,
 * then unread-mentions, then author identity, then legacy heuristics.
 */
export function isThreadAffiliatedWithMe(
  thread: SidebarThreadSummary,
  input: ThreadAffiliationInput,
): boolean {
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const override = input.overrideByThreadKey[threadKey];
  if (override === "mine") return true;
  if (override === "other") return false;

  if (input.mentionedThreadIds.has(thread.id)) {
    return true;
  }

  if (thread.createdBy && input.currentUserId !== null) {
    return thread.createdBy.id === input.currentUserId;
  }

  // Legacy fallback for threads created before per-user attribution shipped:
  // lean on the owning project's createdBy, then fall back to the
  // primary-environment heuristic for projects that also predate
  // attribution.
  const member = input.resolveProjectMember(thread);
  if (!member) return false;
  if (member.createdBy && input.currentUserId !== null) {
    return member.createdBy.id === input.currentUserId;
  }
  if (
    member.createdBy === null &&
    input.primaryEnvironmentId !== null &&
    member.environmentId === input.primaryEnvironmentId
  ) {
    return true;
  }
  return false;
}

export interface PartitionedSidebarThreads {
  readonly mine: ReadonlyArray<SidebarThreadSummary>;
  readonly others: ReadonlyArray<SidebarThreadSummary>;
}

export function partitionThreadsByAffiliation(
  threads: ReadonlyArray<SidebarThreadSummary>,
  input: ThreadAffiliationInput,
): PartitionedSidebarThreads {
  const mine: SidebarThreadSummary[] = [];
  const others: SidebarThreadSummary[] = [];
  for (const thread of threads) {
    if (isThreadAffiliatedWithMe(thread, input)) {
      mine.push(thread);
    } else {
      others.push(thread);
    }
  }
  return { mine, others };
}

export interface SidebarProjectSectionInstance {
  /** The underlying snapshot — identical across mine/other instances. */
  readonly snapshot: SidebarProjectSnapshot;
  /** Section this instance lives in. */
  readonly section: "mine" | "other";
  /** Subset of the project's threads visible in this section instance. */
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
}

export interface PartitionedSidebarProjectsBySection {
  readonly mine: ReadonlyArray<SidebarProjectSectionInstance>;
  readonly others: ReadonlyArray<SidebarProjectSectionInstance>;
}

export interface PartitionProjectSectionsInput extends ThreadAffiliationInput {
  readonly snapshots: ReadonlyArray<SidebarProjectSnapshot>;
  readonly threadsByProjectKey: ReadonlyMap<string, ReadonlyArray<SidebarThreadSummary>>;
}

/**
 * Splits each project snapshot into 0/1/2 section instances. A project
 * appears under "My projects" iff at least one of its threads is mine,
 * and under "Projects" iff at least one of its threads is not mine — so
 * the same folder can render twice when its threads straddle both
 * sections. Snapshot ordering is preserved within each section, so the
 * caller's chosen sort (manual, recency, alphabetical…) keeps working.
 */
export function partitionProjectsBySectionedThreads(
  input: PartitionProjectSectionsInput,
): PartitionedSidebarProjectsBySection {
  const mine: SidebarProjectSectionInstance[] = [];
  const others: SidebarProjectSectionInstance[] = [];
  for (const snapshot of input.snapshots) {
    const projectThreads = input.threadsByProjectKey.get(snapshot.projectKey) ?? [];
    const { mine: mineThreads, others: othersThreads } = partitionThreadsByAffiliation(
      projectThreads,
      input,
    );
    if (mineThreads.length > 0 || projectThreads.length === 0) {
      // Empty projects (no threads yet) follow the legacy project-level
      // signal so freshly created folders land in My projects.
      const shouldShowEmptyInMine =
        projectThreads.length === 0 &&
        projectAffiliationFallbackForEmpty(snapshot, input) === "mine";
      if (mineThreads.length > 0 || shouldShowEmptyInMine) {
        mine.push({ snapshot, section: "mine", threads: mineThreads });
      }
    }
    if (othersThreads.length > 0) {
      others.push({ snapshot, section: "other", threads: othersThreads });
    } else if (projectThreads.length === 0) {
      const shouldShowEmptyInOther =
        projectAffiliationFallbackForEmpty(snapshot, input) === "other";
      if (shouldShowEmptyInOther) {
        others.push({ snapshot, section: "other", threads: [] });
      }
    }
  }
  return { mine, others };
}

function projectAffiliationFallbackForEmpty(
  snapshot: SidebarProjectSnapshot,
  input: ThreadAffiliationInput,
): "mine" | "other" {
  for (const member of snapshot.memberProjects) {
    if (input.currentUserId !== null && member.createdBy?.id === input.currentUserId) {
      return "mine";
    }
    if (
      member.createdBy === null &&
      input.primaryEnvironmentId !== null &&
      member.environmentId === input.primaryEnvironmentId
    ) {
      return "mine";
    }
  }
  return "other";
}
