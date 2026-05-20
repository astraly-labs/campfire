import { describe, expect, it } from "@effect/vitest";

import { aggregateCpuTimes, computeCpuPercent } from "./HostResourceMonitor.ts";

const cpu = (times: {
  user?: number;
  nice?: number;
  sys?: number;
  idle?: number;
  irq?: number;
}) => ({
  model: "test",
  speed: 0,
  times: {
    user: times.user ?? 0,
    nice: times.nice ?? 0,
    sys: times.sys ?? 0,
    idle: times.idle ?? 0,
    irq: times.irq ?? 0,
  },
});

describe("HostResourceMonitor", () => {
  describe("aggregateCpuTimes", () => {
    it("sums idle and total across cores", () => {
      const result = aggregateCpuTimes([
        cpu({ user: 10, sys: 5, idle: 85 }),
        cpu({ user: 20, sys: 10, idle: 70 }),
      ]);
      expect(result).toEqual({ idle: 155, total: 200 });
    });

    it("returns zeros for empty input", () => {
      expect(aggregateCpuTimes([])).toEqual({ idle: 0, total: 0 });
    });
  });

  describe("computeCpuPercent", () => {
    it("returns 0 when there is no prior sample", () => {
      expect(computeCpuPercent(null, { idle: 100, total: 200 })).toBe(0);
    });

    it("computes percent from idle/total deltas", () => {
      const prev = { idle: 800, total: 1000 };
      const curr = { idle: 850, total: 1100 };
      // idleDelta = 50, totalDelta = 100, ratio = 1 - 50/100 = 0.5 -> 50.0%
      expect(computeCpuPercent(prev, curr)).toBe(50);
    });

    it("clamps to [0, 100]", () => {
      const prev = { idle: 0, total: 0 };
      const curr = { idle: 50, total: 100 };
      // totalDelta = 100, idleDelta = 50 -> 50%
      expect(computeCpuPercent(prev, curr)).toBe(50);
    });

    it("returns 0 when total does not advance", () => {
      const prev = { idle: 100, total: 500 };
      const curr = { idle: 100, total: 500 };
      expect(computeCpuPercent(prev, curr)).toBe(0);
    });

    it("returns 100 when all delta is non-idle", () => {
      const prev = { idle: 100, total: 500 };
      const curr = { idle: 100, total: 700 };
      expect(computeCpuPercent(prev, curr)).toBe(100);
    });

    it("rounds to one decimal", () => {
      const prev = { idle: 0, total: 0 };
      const curr = { idle: 33, total: 100 };
      // ratio = 0.67 -> 67.0
      expect(computeCpuPercent(prev, curr)).toBe(67);
    });
  });
});
