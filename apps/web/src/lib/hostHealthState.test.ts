import type { ServerHostHealthResult } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import { computeHostHealthStatus } from "./hostHealthState";

const epoch = DateTime.makeUnsafe("2026-05-20T00:00:00.000Z");

function snapshot(overrides: {
  readonly cpu?: number;
  readonly memUsedPct?: number;
  readonly diskFreePct?: number | null;
  readonly notSampled?: boolean;
}): ServerHostHealthResult {
  const memTotalBytes = 100;
  const memUsedBytes = Math.round(((overrides.memUsedPct ?? 0) / 100) * memTotalBytes);
  const diskTotal = 1000;
  const diskFreePct = overrides.diskFreePct;
  const disk =
    diskFreePct === null
      ? Option.none<{ path: string; freeBytes: number; totalBytes: number }>()
      : Option.some({
          path: "/",
          freeBytes: Math.round(((diskFreePct ?? 50) / 100) * diskTotal),
          totalBytes: diskTotal,
        });

  return {
    readAt: epoch,
    sampledAt: overrides.notSampled ? Option.none() : Option.some(epoch),
    hostname: "test",
    platform: "darwin",
    uptimeSec: 0,
    cpu: {
      percent: overrides.cpu ?? 0,
      count: 8,
      loadAverage1m: 0,
      loadAverage5m: 0,
      loadAverage15m: 0,
    },
    memory: { usedBytes: memUsedBytes, totalBytes: memTotalBytes },
    disk,
    error: Option.none(),
  };
}

describe("computeHostHealthStatus", () => {
  it("returns unknown when no snapshot", () => {
    expect(computeHostHealthStatus(null)).toBe("unknown");
  });

  it("returns unknown when not yet sampled", () => {
    expect(computeHostHealthStatus(snapshot({ notSampled: true }))).toBe("unknown");
  });

  it("returns green for healthy values", () => {
    expect(computeHostHealthStatus(snapshot({ cpu: 30, memUsedPct: 50, diskFreePct: 50 }))).toBe(
      "green",
    );
  });

  it("returns yellow when CPU crosses warn threshold", () => {
    expect(computeHostHealthStatus(snapshot({ cpu: 75, memUsedPct: 50, diskFreePct: 50 }))).toBe(
      "yellow",
    );
  });

  it("returns yellow when memory crosses warn threshold", () => {
    expect(computeHostHealthStatus(snapshot({ cpu: 10, memUsedPct: 85, diskFreePct: 50 }))).toBe(
      "yellow",
    );
  });

  it("returns yellow when disk free drops below warn threshold", () => {
    expect(computeHostHealthStatus(snapshot({ cpu: 10, memUsedPct: 10, diskFreePct: 10 }))).toBe(
      "yellow",
    );
  });

  it("returns red when CPU crosses critical threshold", () => {
    expect(computeHostHealthStatus(snapshot({ cpu: 95, memUsedPct: 10, diskFreePct: 50 }))).toBe(
      "red",
    );
  });

  it("returns red when memory crosses critical threshold", () => {
    expect(computeHostHealthStatus(snapshot({ cpu: 10, memUsedPct: 96, diskFreePct: 50 }))).toBe(
      "red",
    );
  });

  it("returns red when disk free drops below critical threshold", () => {
    expect(computeHostHealthStatus(snapshot({ cpu: 10, memUsedPct: 10, diskFreePct: 3 }))).toBe(
      "red",
    );
  });

  it("ignores disk when unavailable", () => {
    expect(computeHostHealthStatus(snapshot({ cpu: 10, memUsedPct: 10, diskFreePct: null }))).toBe(
      "green",
    );
  });
});
