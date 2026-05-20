import { useAtomValue } from "@effect/atom-react";
import type { ServerHostHealthResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect } from "react";

import { ensureLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";

const HOST_HEALTH_STALE_TIME_MS = 5_000;
const HOST_HEALTH_IDLE_TTL_MS = 5 * 60_000;
const HOST_HEALTH_REFRESH_INTERVAL_MS = 5_000;

const hostHealthAtom = Atom.make(
  Effect.promise(() => ensureLocalApi().server.getHostHealth()),
).pipe(
  Atom.swr({
    staleTime: HOST_HEALTH_STALE_TIME_MS,
    revalidateOnMount: true,
  }),
  Atom.setIdleTTL(HOST_HEALTH_IDLE_TTL_MS),
  Atom.withLabel("host-health"),
);

export type HostHealthStatus = "green" | "yellow" | "red" | "unknown";

export interface HostHealthState {
  readonly data: ServerHostHealthResult | null;
  readonly status: HostHealthStatus;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

const CPU_WARN = 70;
const CPU_CRIT = 90;
const MEM_WARN = 80;
const MEM_CRIT = 95;
const DISK_FREE_WARN = 15;
const DISK_FREE_CRIT = 5;

export function computeHostHealthStatus(
  snapshot: ServerHostHealthResult | null,
): HostHealthStatus {
  if (!snapshot || Option.isNone(snapshot.sampledAt)) {
    return "unknown";
  }

  const cpu = snapshot.cpu.percent;
  const memTotal = snapshot.memory.totalBytes;
  const memUsedPct = memTotal > 0 ? (snapshot.memory.usedBytes / memTotal) * 100 : 0;

  const diskFreePct = Option.match(snapshot.disk, {
    onNone: () => Infinity,
    onSome: (disk) => (disk.totalBytes > 0 ? (disk.freeBytes / disk.totalBytes) * 100 : Infinity),
  });

  if (cpu >= CPU_CRIT || memUsedPct >= MEM_CRIT || diskFreePct <= DISK_FREE_CRIT) {
    return "red";
  }
  if (cpu >= CPU_WARN || memUsedPct >= MEM_WARN || diskFreePct <= DISK_FREE_WARN) {
    return "yellow";
  }
  return "green";
}

function formatHostHealthError(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to load host health.";
}

function readHostHealthError(
  result: AsyncResult.AsyncResult<ServerHostHealthResult, unknown>,
): string | null {
  if (result._tag !== "Failure") {
    return null;
  }
  return formatHostHealthError(Cause.squash(result.cause));
}

export function refreshHostHealth(): void {
  appAtomRegistry.refresh(hostHealthAtom);
}

export function useHostHealth(options?: { readonly autoRefresh?: boolean }): HostHealthState {
  const autoRefresh = options?.autoRefresh ?? true;
  const result = useAtomValue(hostHealthAtom);
  const data = Option.getOrNull(AsyncResult.value(result));
  const refresh = useCallback(() => {
    refreshHostHealth();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(refreshHostHealth, HOST_HEALTH_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [autoRefresh]);

  return {
    data,
    status: computeHostHealthStatus(data),
    error: readHostHealthError(result),
    isPending: result.waiting,
    refresh,
  };
}
