// @effect-diagnostics nodeBuiltinImport:off
import { statfs } from "node:fs/promises";
import * as os from "node:os";

import type { ServerHostHealthResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

const SAMPLE_INTERVAL_MS = 5_000;
const DISK_SAMPLE_PATH = "/";

export interface CpuTimesSnapshot {
  readonly idle: number;
  readonly total: number;
}

export interface HostHealthSample {
  readonly sampledAt: DateTime.Utc;
  readonly cpuPercent: number;
  readonly cpuCount: number;
  readonly loadAverage: readonly [number, number, number];
  readonly memUsedBytes: number;
  readonly memTotalBytes: number;
  readonly disk: { readonly path: string; readonly freeBytes: number; readonly totalBytes: number } | null;
  readonly uptimeSec: number;
}

interface MonitorState {
  readonly latest: HostHealthSample | null;
  readonly lastCpuTimes: CpuTimesSnapshot | null;
  readonly lastError: string | null;
}

export interface HostResourceMonitorShape {
  readonly readCurrent: Effect.Effect<ServerHostHealthResult>;
}

export class HostResourceMonitor extends Context.Service<
  HostResourceMonitor,
  HostResourceMonitorShape
>()("t3/diagnostics/HostResourceMonitor") {}

export function aggregateCpuTimes(cpus: ReadonlyArray<os.CpuInfo>): CpuTimesSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

export function computeCpuPercent(
  prev: CpuTimesSnapshot | null,
  curr: CpuTimesSnapshot,
): number {
  if (prev === null) {
    return 0;
  }
  const idleDelta = curr.idle - prev.idle;
  const totalDelta = curr.total - prev.total;
  if (totalDelta <= 0) {
    return 0;
  }
  const ratio = 1 - idleDelta / totalDelta;
  const clamped = Math.max(0, Math.min(1, ratio));
  return Math.round(clamped * 1_000) / 10;
}

interface DiskSample {
  readonly path: string;
  readonly freeBytes: number;
  readonly totalBytes: number;
}

const readDiskSample = (path: string): Effect.Effect<DiskSample | null> =>
  Effect.promise(async () => {
    try {
      const stats = await statfs(path);
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bavail * stats.bsize;
      return {
        path,
        freeBytes: Math.max(0, Math.trunc(freeBytes)),
        totalBytes: Math.max(0, Math.trunc(totalBytes)),
      } satisfies DiskSample;
    } catch {
      return null;
    }
  });

const sampleHost = Effect.gen(function* () {
  const sampledAt = yield* DateTime.now;
  const cpus = os.cpus();
  const cpuTimes = aggregateCpuTimes(cpus);
  const loadRaw = os.loadavg();
  const loadAverage: readonly [number, number, number] = [
    loadRaw[0] ?? 0,
    loadRaw[1] ?? 0,
    loadRaw[2] ?? 0,
  ];
  const memTotalBytes = os.totalmem();
  const memFreeBytes = os.freemem();
  const disk = yield* readDiskSample(DISK_SAMPLE_PATH);
  return {
    sampledAt,
    cpuTimes,
    sample: {
      sampledAt,
      cpuPercent: 0,
      cpuCount: cpus.length,
      loadAverage,
      memUsedBytes: Math.max(0, memTotalBytes - memFreeBytes),
      memTotalBytes,
      disk,
      uptimeSec: Math.max(0, Math.trunc(os.uptime())),
    } satisfies Omit<HostHealthSample, "cpuPercent"> & { cpuPercent: number },
  };
});

const toResult = (input: {
  readonly readAt: DateTime.Utc;
  readonly state: MonitorState;
}): ServerHostHealthResult => {
  const sample = input.state.latest;
  const hostname = os.hostname() || "unknown";
  const platform = process.platform || "unknown";

  if (sample === null) {
    return {
      readAt: input.readAt,
      sampledAt: Option.none(),
      hostname,
      platform,
      uptimeSec: 0,
      cpu: {
        percent: 0,
        count: os.cpus().length,
        loadAverage1m: 0,
        loadAverage5m: 0,
        loadAverage15m: 0,
      },
      memory: { usedBytes: 0, totalBytes: 0 },
      disk: Option.none(),
      error: input.state.lastError
        ? Option.some({ message: input.state.lastError })
        : Option.none(),
    };
  }

  return {
    readAt: input.readAt,
    sampledAt: Option.some(sample.sampledAt),
    hostname,
    platform,
    uptimeSec: sample.uptimeSec,
    cpu: {
      percent: sample.cpuPercent,
      count: sample.cpuCount,
      loadAverage1m: sample.loadAverage[0],
      loadAverage5m: sample.loadAverage[1],
      loadAverage15m: sample.loadAverage[2],
    },
    memory: { usedBytes: sample.memUsedBytes, totalBytes: sample.memTotalBytes },
    disk: sample.disk ? Option.some(sample.disk) : Option.none(),
    error: input.state.lastError ? Option.some({ message: input.state.lastError }) : Option.none(),
  };
};

export const make = Effect.fn("makeHostResourceMonitor")(function* () {
  const state = yield* Ref.make<MonitorState>({
    latest: null,
    lastCpuTimes: null,
    lastError: null,
  });

  const sampleOnce = Effect.gen(function* () {
    const reading = yield* sampleHost;
    yield* Ref.update(state, (current) => {
      const cpuPercent = computeCpuPercent(current.lastCpuTimes, reading.cpuTimes);
      const sample: HostHealthSample = {
        sampledAt: reading.sample.sampledAt,
        cpuPercent,
        cpuCount: reading.sample.cpuCount,
        loadAverage: reading.sample.loadAverage,
        memUsedBytes: reading.sample.memUsedBytes,
        memTotalBytes: reading.sample.memTotalBytes,
        disk: reading.sample.disk,
        uptimeSec: reading.sample.uptimeSec,
      };
      return { latest: sample, lastCpuTimes: reading.cpuTimes, lastError: null };
    });
  });

  yield* Effect.forever(sampleOnce.pipe(Effect.andThen(Effect.sleep(SAMPLE_INTERVAL_MS)))).pipe(
    Effect.forkScoped,
  );

  const readCurrent: HostResourceMonitorShape["readCurrent"] = Effect.gen(function* () {
    const readAt = yield* DateTime.now;
    const current = yield* Ref.get(state);
    return toResult({ readAt, state: current });
  });

  return HostResourceMonitor.of({ readCurrent });
});

export const layer = Layer.effect(HostResourceMonitor, make());
