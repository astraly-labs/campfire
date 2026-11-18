import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

const WINDOWS: Readonly<
  Record<string, Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins">>
> = {
  five_hour: { kind: "session", label: "Session", windowDurationMins: SESSION_MINS },
  seven_day: { kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS },
};

/** Reuse probed display names for streamed bucket types so mid-turn updates target the same row. */
const OVERAGE_INCLUDED_EVENT_TYPE = "seven_day_overage_included";

// The SDK does not yet type the spend budget returned by `get_usage`.
const SpendMoney = Schema.Struct({
  amount_minor: Schema.Natural,
  currency: Schema.NonEmptyString,
  exponent: Schema.Natural,
});
const decodeSpendBudget = Schema.decodeUnknownOption(
  Schema.Struct({ enabled: Schema.Boolean, used: SpendMoney, limit: SpendMoney }),
);

export interface ClaudeScopedLimitNames {
  readonly overageIncluded: string | undefined;
}

export const makeClaudeScopedLimitNames = Ref.make<ClaudeScopedLimitNames>({
  overageIncluded: undefined,
});

const SCOPED_WINDOW_PREFIX = "seven_day_";
const scopeToken = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

function scopedWindowId(displayName: string): string {
  return `${SCOPED_WINDOW_PREFIX}${scopeToken(displayName)}`;
}

/** A model-scoped weekly allowance blocks only its own model; an unknown model is not blocked. */
export function windowLimitsModel(
  window: Pick<ServerProviderUsageWindow, "id">,
  model: string | null,
): boolean {
  if (!window.id.startsWith(SCOPED_WINDOW_PREFIX)) return true;
  return model !== null && scopeToken(model).includes(window.id.slice(SCOPED_WINDOW_PREFIX.length));
}

function scopedWindow(
  displayName: string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  return {
    id: scopedWindowId(displayName),
    kind: "weekly",
    label: `Weekly · ${displayName}`,
    windowDurationMins: WEEK_MINS,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function percentFromAmounts(used: number | null | undefined, limit: number | null | undefined) {
  if (
    typeof used !== "number" ||
    typeof limit !== "number" ||
    !Number.isFinite(used) ||
    !Number.isFinite(limit) ||
    used < 0 ||
    limit <= 0
  ) {
    return undefined;
  }
  const percent = (used / limit) * 100;
  return Number.isFinite(percent) ? clampPercent(percent) : undefined;
}

function readSpendPercent(rateLimits: NonNullable<SDKControlGetUsageResponse["rate_limits"]>) {
  const spend = Option.getOrUndefined(
    decodeSpendBudget((rateLimits as { readonly spend?: unknown }).spend),
  );
  // Minor-unit ratios require matching currency and scale; spend.percent is rounded.
  if (
    spend?.enabled &&
    spend.used.currency.trim().length > 0 &&
    spend.used.currency.trim() === spend.limit.currency.trim() &&
    spend.used.exponent === spend.limit.exponent
  ) {
    const percent = percentFromAmounts(spend.used.amount_minor, spend.limit.amount_minor);
    if (percent !== undefined) return percent;
  }

  const extra = rateLimits.extra_usage;
  if (extra?.is_enabled !== true) return undefined;
  const percent = percentFromAmounts(extra.used_credits, extra.monthly_limit) ?? extra.utilization;
  return typeof percent === "number" && Number.isFinite(percent) && percent >= 0
    ? clampPercent(percent)
    : undefined;
}

/**
 * `model_scoped` shipped in the CLI after the SDK typings we pin, so it is
 * read structurally until the `.d.ts` catches up.
 */
interface ModelScopedWindow {
  readonly display_name: string;
  readonly utilization: number | null;
  readonly resets_at: string | null;
}

function readModelScoped(rateLimits: object): ReadonlyArray<ModelScopedWindow> {
  const raw = (rateLimits as { readonly model_scoped?: unknown }).model_scoped;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ModelScopedWindow =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ModelScopedWindow).display_name === "string",
  );
}

function isoFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function isoFromString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function makeWindow(
  id: keyof typeof WINDOWS & string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  const window = WINDOWS[id]!;
  return {
    id,
    ...window,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

interface StreamedWindow {
  readonly utilization?: number;
  readonly resetsAt?: number;
}

/**
 * Current CLIs attach every window to each event under `unifiedWindows`, and
 * often leave the top-level `utilization` out. It shipped after the SDK
 * typings we pin, so it is read structurally until the `.d.ts` catches up.
 */
function readUnifiedWindows(info: SDKRateLimitInfo): ReadonlyArray<[string, StreamedWindow]> {
  const raw = (info as { readonly unifiedWindows?: unknown }).unifiedWindows;
  if (typeof raw !== "object" || raw === null) return [];
  return Object.entries(raw).filter(
    (entry): entry is [string, StreamedWindow] => typeof entry[1] === "object" && entry[1] !== null,
  );
}

function streamedWindow(
  type: string,
  window: StreamedWindow,
  names: ClaudeScopedLimitNames,
): ServerProviderUsageWindow | undefined {
  if (typeof window.utilization !== "number") return undefined;
  const usedPercent = window.utilization * 100;
  const resetsAt = isoFromEpochSeconds(window.resetsAt);
  if (type in WINDOWS) return makeWindow(type, usedPercent, resetsAt);
  if (type === OVERAGE_INCLUDED_EVENT_TYPE && names.overageIncluded) {
    return scopedWindow(names.overageIncluded, usedPercent, resetsAt);
  }
  return undefined;
}

/** Stream utilization is 0-1. Drop unnamed overage buckets until probed to avoid unreconcilable rows. */
export function claudeRateLimitEventToUpdate(
  info: SDKRateLimitInfo,
  names: ClaudeScopedLimitNames,
): ProviderUsageLimitsUpdate | undefined {
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const [type, entry] of readUnifiedWindows(info)) {
    const window = streamedWindow(type, entry, names);
    if (window) windows.set(window.id, window);
  }
  const named = info.rateLimitType ? streamedWindow(info.rateLimitType, info, names) : undefined;
  if (named) windows.set(named.id, named);
  return windows.size === 0 ? undefined : { windows: [...windows.values()] };
}

/**
 * Percentages on the `get_usage` response are already 0–100. Also yields the
 * scoped-bucket names the response carried, for the event mapper to reuse.
 *
 * `subscriptionLogin` marks a first-party login without an API key. Its plan
 * limits apply even when `get_usage` cannot read them (a `claude setup-token`
 * lacks the profile scope), so that case stays open to the windows its turns
 * stream instead of being written off as an account without limits.
 */
export function claudeUsageResponseToLimits(input: {
  readonly response: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
  readonly checkedAt: string;
  readonly subscriptionLogin?: boolean;
}): { readonly limits: ServerProviderUsageLimits; readonly names: ClaudeScopedLimitNames } {
  const { response, checkedAt } = input;
  if (!response.rate_limits_available || !response.rate_limits) {
    return {
      limits: input.subscriptionLogin
        ? makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: "Limits show after this account's next turn.",
          })
        : makeUnavailableUsageLimits({
            checkedAt,
            reason: response.rate_limits_available ? "probeFailed" : "unsupported",
          }),
      names: { overageIncluded: undefined },
    };
  }
  const windows: ServerProviderUsageWindow[] = [];
  for (const id of Object.keys(WINDOWS)) {
    const window = response.rate_limits[id as "five_hour" | "seven_day"];
    if (!window || typeof window.utilization !== "number") continue;
    windows.push(makeWindow(id, window.utilization, isoFromString(window.resets_at)));
  }
  // The CLI's overage allowlist currently has one model; events refer to its first entry.
  let overageIncluded: string | undefined;
  for (const entry of readModelScoped(response.rate_limits)) {
    if (typeof entry.utilization !== "number") continue;
    windows.push(
      scopedWindow(entry.display_name, entry.utilization, isoFromString(entry.resets_at)),
    );
    overageIncluded ??= entry.display_name;
  }
  const spendPercent = readSpendPercent(response.rate_limits);
  const extra = response.rate_limits.extra_usage;
  if (spendPercent !== undefined) {
    windows.push({
      id: "monthly_spend",
      kind: "monthly",
      label: "Monthly spend",
      usedPercent: spendPercent,
    });
  }
  return {
    limits: {
      ...makeUsageLimits({ checkedAt, windows }),
      ...(extra?.is_enabled && extra.monthly_limit === 0 ? { zeroSpendCap: true } : {}),
    },
    names: { overageIncluded },
  };
}

export const recordClaudeUsageResponse = (
  namesRef: Ref.Ref<ClaudeScopedLimitNames>,
  input: Parameters<typeof claudeUsageResponseToLimits>[0],
): Effect.Effect<ServerProviderUsageLimits> => {
  const { limits, names } = claudeUsageResponseToLimits(input);
  return Ref.set(namesRef, names).pipe(Effect.as(limits));
};
