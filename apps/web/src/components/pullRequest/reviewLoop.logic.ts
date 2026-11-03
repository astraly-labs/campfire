import {
  type ModelSelection,
  ProviderDriverKind,
  type ProviderInstanceId,
  type PullRequestState,
  type ServerProvider,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { latestSolModel } from "@t3tools/shared/model";
import { liveAuthorLoop, reviewerMarker } from "@t3tools/shared/pullRequestReviewLoop";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";

import { getTriggerDisplayModelName } from "../chat/providerIconUtils";

export interface ReviewLoopPullRequest {
  readonly host: string | undefined;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly state: PullRequestState | null;
  readonly headBranch: string | null;
}

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

export function canStartReviewLoop(input: {
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

const CODEX = ProviderDriverKind.make("codex");

export function defaultReviewLoopReviewer(input: {
  readonly source: ModelSelection;
  readonly sourceDriver: ProviderDriverKind | null;
  /** In picker order, each with the models the user can pick. */
  readonly readyInstances: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: ProviderDriverKind;
    readonly models: ReadonlyArray<{
      readonly slug: string;
      readonly isCustom: boolean;
      readonly isLegacy?: boolean | undefined;
    }>;
  }>;
}): { readonly instanceId: ProviderInstanceId; readonly selection: ModelSelection | null } | null {
  for (const entry of input.readyInstances) {
    const sol = entry.driverKind === CODEX ? latestSolModel(entry.models) : null;
    if (sol !== null) {
      return {
        instanceId: entry.instanceId,
        selection: { instanceId: entry.instanceId, model: sol.slug },
      };
    }
  }
  const isReady = (instanceId: ProviderInstanceId) =>
    input.readyInstances.some((entry) => entry.instanceId === instanceId);
  const otherDriver = input.readyInstances.find((entry) => entry.driverKind !== input.sourceDriver);
  if (otherDriver !== undefined) return { instanceId: otherDriver.instanceId, selection: null };
  if (isReady(input.source.instanceId)) {
    return { instanceId: input.source.instanceId, selection: input.source };
  }
  const first = input.readyInstances[0];
  return first === undefined ? null : { instanceId: first.instanceId, selection: null };
}

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
