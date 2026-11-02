import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  PullRequestState,
  ServerProvider,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { liveAuthorLoop, reviewerMarker } from "@t3tools/shared/pullRequestReviewLoop";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";

import { getTriggerDisplayModelName } from "../chat/providerIconUtils";

/** The pull request a review loop control acts on. Null fields are ones the host has not sent. */
export interface ReviewLoopPullRequest {
  readonly host: string | undefined;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly state: PullRequestState | null;
  readonly headBranch: string | null;
}

/** The thread's own link to the pull request, which holds its review loop. */
export function findReviewLoopLink(
  links: ReadonlyArray<ThreadPullRequestLink>,
  pullRequest: Pick<ReviewLoopPullRequest, "host" | "repository" | "number">,
): ThreadPullRequestLink | null {
  const { host, repository, number } = pullRequest;
  return (
    visibleThreadPullRequests(links).find((link) =>
      host === undefined
        ? link.number === number && link.repository.toLowerCase() === repository.toLowerCase()
        : threadPullRequestKeysEqual(link, { host, repository, number }),
    ) ?? null
  );
}

/**
 * Whether the user can start a review loop on this pull request from this thread. The server
 * checks again when the loop starts.
 */
export function canStartReviewLoop(input: {
  /** The server has the pullRequestReviewLoop capability. */
  readonly supported: boolean;
  readonly canOperate: boolean;
  readonly thread: {
    readonly branch: string | null;
    readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  } | null;
  readonly pullRequest: Pick<ReviewLoopPullRequest, "state" | "headBranch">;
}): boolean {
  const { thread, pullRequest } = input;
  if (!input.supported || !input.canOperate || thread === null) return false;
  if (pullRequest.state !== null && pullRequest.state !== "open") return false;
  if (
    pullRequest.headBranch !== null &&
    thread.branch !== null &&
    pullRequest.headBranch !== thread.branch
  ) {
    return false;
  }
  return !visibleThreadPullRequests(thread.pullRequests).some(
    (link) => liveAuthorLoop(link) !== undefined || reviewerMarker(link) !== undefined,
  );
}

/**
 * The reviewer the start dialog offers first: the project's review model when its instance is
 * ready, else the first ready instance whose driver differs from the source thread's, so the code
 * gets a second opinion from another provider. `selection` is the model and options to keep, or
 * null for the instance's default model.
 */
export function defaultReviewLoopReviewer(input: {
  readonly projectReviewer: ModelSelection | null;
  readonly source: ModelSelection;
  readonly sourceDriver: ProviderDriverKind | null;
  /** In picker order. */
  readonly readyInstances: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: ProviderDriverKind;
  }>;
}): { readonly instanceId: ProviderInstanceId; readonly selection: ModelSelection | null } | null {
  const isReady = (instanceId: ProviderInstanceId) =>
    input.readyInstances.some((entry) => entry.instanceId === instanceId);
  if (input.projectReviewer !== null && isReady(input.projectReviewer.instanceId)) {
    return { instanceId: input.projectReviewer.instanceId, selection: input.projectReviewer };
  }
  const otherDriver = input.readyInstances.find((entry) => entry.driverKind !== input.sourceDriver);
  if (otherDriver !== undefined) return { instanceId: otherDriver.instanceId, selection: null };
  if (isReady(input.source.instanceId)) {
    return { instanceId: input.source.instanceId, selection: input.source };
  }
  const first = input.readyInstances[0];
  return first === undefined ? null : { instanceId: first.instanceId, selection: null };
}

/** "Cursor · composer-1": the instance and model a thread runs, as the loop chip names them. */
export function modelSelectionLabel(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): string {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (provider === undefined) return selection.model;
  const model = provider.models.find((candidate) => candidate.slug === selection.model);
  return `${resolveProviderInstanceDisplayName(provider)} · ${
    model === undefined ? selection.model : getTriggerDisplayModelName(model)
  }`;
}
