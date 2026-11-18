import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

/**
 * A window that already reset by this update and that the update does not renew is one the
 * provider stopped reporting, as Claude did with the 5-hour session on some plans, so it is
 * dropped instead of showing a stale bar.
 */
export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (update.windows.length === 0 || previous?.unavailable?.reason === "unsupported") {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  // Codex repeats unchanged limits on token ticks; avoid allocating snapshots for no-ops.
  let changed = false;
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
    };
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  const readAt = Date.parse(input.checkedAt);
  const renewed = new Set(update.windows.map((window) => window.id));
  for (const [id, window] of merged) {
    if (!renewed.has(id) && lapsedBy(window, readAt)) {
      merged.delete(id);
      changed = true;
    }
  }
  if (!changed && previous !== undefined && previous.unavailable === undefined) {
    return previous;
  }
  // Streamed windows replace a probe that could not read them; before any probe they stay marked.
  const unavailable = previous === undefined ? { reason: "probeFailed" as const } : undefined;
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: merged.values() }),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
    ...(previous?.zeroSpendCap ? { zeroSpendCap: true } : {}),
    ...(unavailable !== undefined ? { unavailable } : {}),
  };
}

function lapsedBy(window: ServerProviderUsageWindow, at: number): boolean {
  if (window.resetsAt === undefined) return false;
  const resetsAt = Date.parse(window.resetsAt);
  return Number.isFinite(resetsAt) && Number.isFinite(at) && resetsAt <= at;
}

/** The windows that were still open when `limits` were read; see `applyUsageLimitsUpdate`. */
function withoutLapsedWindows(limits: ServerProviderUsageLimits): ServerProviderUsageLimits {
  const readAt = Date.parse(limits.checkedAt);
  const open = limits.windows.filter((window) => !lapsedBy(window, readAt));
  return open.length === limits.windows.length ? limits : { ...limits, windows: open };
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    (a.modelIds === b.modelIds ||
      (a.modelIds !== undefined &&
        b.modelIds !== undefined &&
        a.modelIds.length === b.modelIds.length &&
        a.modelIds.every((id, index) => id === b.modelIds?.[index]))) &&
    (a.providerIds === b.providerIds ||
      (a.providerIds !== undefined &&
        b.providerIds !== undefined &&
        a.providerIds.length === b.providerIds.length &&
        a.providerIds.every((id, index) => id === b.providerIds?.[index]))) &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins
  );
}

/** A failed probe keeps the last good snapshot, minus any window that had already lapsed. */
export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    return withoutLapsedWindows(published);
  }
  if (
    published &&
    probed &&
    !published.unavailable &&
    !probed.unavailable &&
    Date.parse(published.checkedAt) > Date.parse(probed.checkedAt)
  ) {
    return { ...probed, checkedAt: published.checkedAt, windows: published.windows };
  }
  return probed;
}
