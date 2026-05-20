import { ActivityIcon, RefreshCwIcon } from "lucide-react";
import * as Option from "effect/Option";
import { useMemo } from "react";

import { useHostHealth, type HostHealthStatus } from "../../lib/hostHealthState";
import { Button } from "../ui/button";
import { HealthDot } from "./HealthStatusIndicator";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const STATUS_LABEL: Record<HostHealthStatus, string> = {
  green: "Healthy",
  yellow: "Degraded",
  red: "Critical",
  unknown: "Unknown",
};

const STATUS_DESCRIPTION: Record<HostHealthStatus, string> = {
  green: "All vitals within healthy ranges.",
  yellow: "At least one resource is above its warning threshold.",
  red: "At least one resource is above its critical threshold.",
  unknown: "No sample yet. The backend may still be starting up.",
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
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function HealthSettings() {
  const { data, status, error, refresh, isPending } = useHostHealth();

  const memUsedPct = useMemo(() => {
    if (!data) return 0;
    const total = data.memory.totalBytes;
    return total > 0 ? (data.memory.usedBytes / total) * 100 : 0;
  }, [data]);

  const disk = useMemo(() => {
    if (!data) return null;
    return Option.match(data.disk, {
      onNone: () => null,
      onSome: (d) => ({
        ...d,
        usedPct: d.totalBytes > 0 ? ((d.totalBytes - d.freeBytes) / d.totalBytes) * 100 : 0,
      }),
    });
  }, [data]);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Backend host"
        icon={<ActivityIcon className="size-3.5" />}
        headerAction={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh"
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={refresh}
            disabled={isPending}
          >
            <RefreshCwIcon className="size-3" />
          </Button>
        }
      >
        <SettingsRow
          title={
            <span className="flex items-center gap-2">
              <HealthDot status={status} />
              <span>{STATUS_LABEL[status]}</span>
            </span>
          }
          description={STATUS_DESCRIPTION[status]}
          status={
            data ? (
              <>
                {data.hostname} · {data.platform} · up {formatUptime(data.uptimeSec)}
              </>
            ) : (
              "Waiting for first sample…"
            )
          }
        />
        {error ? (
          <SettingsRow title="Error" description={<span className="text-red-400">{error}</span>} />
        ) : null}
      </SettingsSection>

      {data ? (
        <SettingsSection title="Resources">
          <SettingsRow
            title="CPU"
            description={`${data.cpu.count} logical cores`}
            status={
              <>
                Load (1m · 5m · 15m): {data.cpu.loadAverage1m.toFixed(2)} ·{" "}
                {data.cpu.loadAverage5m.toFixed(2)} · {data.cpu.loadAverage15m.toFixed(2)}
              </>
            }
            control={<MetricBadge value={formatPercent(data.cpu.percent)} />}
          />
          <SettingsRow
            title="Memory"
            description={`${formatBytes(data.memory.usedBytes)} used of ${formatBytes(
              data.memory.totalBytes,
            )}`}
            control={<MetricBadge value={formatPercent(memUsedPct)} />}
          />
          {disk ? (
            <SettingsRow
              title="Disk"
              description={`${disk.path} — ${formatBytes(disk.freeBytes)} free of ${formatBytes(
                disk.totalBytes,
              )}`}
              control={<MetricBadge value={`${formatPercent(disk.usedPct)} used`} />}
            />
          ) : (
            <SettingsRow title="Disk" description="Disk stats unavailable on this platform." />
          )}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

function MetricBadge({ value }: { readonly value: string }) {
  return (
    <span className="rounded-md border border-border/60 bg-muted/30 px-2 py-1 font-mono text-xs text-foreground/80">
      {value}
    </span>
  );
}
