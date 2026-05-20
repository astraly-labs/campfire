import type { ServerHostHealthResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useMemo } from "react";

import { useHostHealth, type HostHealthStatus } from "../../lib/hostHealthState";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const DOT_COLOR: Record<HostHealthStatus, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-400",
  red: "bg-red-500",
  unknown: "bg-muted-foreground/40",
};

const DOT_RING: Record<HostHealthStatus, string> = {
  green: "ring-emerald-500/30",
  yellow: "ring-amber-400/40",
  red: "ring-red-500/40",
  unknown: "ring-muted-foreground/20",
};

const STATUS_LABEL: Record<HostHealthStatus, string> = {
  green: "Healthy",
  yellow: "Degraded",
  red: "Critical",
  unknown: "—",
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function formatUptime(seconds: number): string {
  if (seconds <= 0) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

interface HealthDotProps {
  readonly status: HostHealthStatus;
  readonly className?: string;
}

export function HealthDot({ status, className }: HealthDotProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full ring-2",
        DOT_COLOR[status],
        DOT_RING[status],
        className,
      )}
    />
  );
}

export function HealthTooltipContent({
  snapshot,
  status,
  error,
}: {
  readonly snapshot: ServerHostHealthResult | null;
  readonly status: HostHealthStatus;
  readonly error: string | null;
}) {
  const memUsedPct = useMemo(() => {
    if (!snapshot) return 0;
    const total = snapshot.memory.totalBytes;
    return total > 0 ? (snapshot.memory.usedBytes / total) * 100 : 0;
  }, [snapshot]);

  const diskInfo = useMemo(() => {
    if (!snapshot) return null;
    return Option.match(snapshot.disk, {
      onNone: () => null,
      onSome: (disk) => {
        const totalGb = disk.totalBytes;
        const freeGb = disk.freeBytes;
        const usedPct =
          disk.totalBytes > 0 ? ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100 : 0;
        return { totalGb, freeGb, usedPct, path: disk.path };
      },
    });
  }, [snapshot]);

  return (
    <div className="flex min-w-56 flex-col gap-1.5 py-1">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">Backend host</span>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <HealthDot status={status} className="ring-0" />
          {STATUS_LABEL[status]}
        </span>
      </div>
      {snapshot ? (
        <>
          <div className="flex items-center justify-between gap-3 text-muted-foreground">
            <span>{snapshot.hostname}</span>
            <span>
              {snapshot.platform} · up {formatUptime(snapshot.uptimeSec)}
            </span>
          </div>
          <hr className="border-border/60" />
          <Row
            label="CPU"
            value={`${formatPercent(snapshot.cpu.percent)} · ${snapshot.cpu.count}×`}
          />
          <Row
            label="Load"
            value={`${snapshot.cpu.loadAverage1m.toFixed(2)} · ${snapshot.cpu.loadAverage5m.toFixed(
              2,
            )} · ${snapshot.cpu.loadAverage15m.toFixed(2)}`}
          />
          <Row
            label="Memory"
            value={`${formatPercent(memUsedPct)} · ${formatBytes(
              snapshot.memory.usedBytes,
            )} / ${formatBytes(snapshot.memory.totalBytes)}`}
          />
          {diskInfo ? (
            <Row
              label={`Disk (${diskInfo.path})`}
              value={`${formatPercent(diskInfo.usedPct)} used · ${formatBytes(
                diskInfo.freeGb,
              )} free / ${formatBytes(diskInfo.totalGb)}`}
            />
          ) : null}
        </>
      ) : (
        <div className="text-muted-foreground">Waiting for first sample…</div>
      )}
      {error ? <div className="text-red-400">{error}</div> : null}
    </div>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-muted-foreground">
      <span>{label}</span>
      <span className="font-mono text-foreground/80">{value}</span>
    </div>
  );
}

export function HealthStatusIndicator() {
  const { data, status, error } = useHostHealth();

  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <span
            {...props}
            className={cn("inline-flex size-4 items-center justify-center", props.className)}
          >
            <HealthDot status={status} />
          </span>
        )}
      />
      <TooltipPopup side="right" align="center" className="max-w-sm p-3 text-xs">
        <HealthTooltipContent snapshot={data} status={status} error={error} />
      </TooltipPopup>
    </Tooltip>
  );
}
