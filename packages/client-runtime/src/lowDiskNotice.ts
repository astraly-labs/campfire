import type { ServerLowDiskVolume } from "@t3tools/contracts";

const GIB = 1024 ** 3;

const ROLE_PLACE: Record<ServerLowDiskVolume["role"], string> = {
  state: "where Campfire keeps its data",
  worktrees: "where worktrees are created",
};

export interface LowDiskNotice {
  readonly title: string;
  readonly description: string;
  /** Folders behind the warning, for a tooltip or a selectable detail. */
  readonly paths: ReadonlyArray<string>;
}

function freeSpace(freeBytes: number): string {
  const gib = Math.floor(freeBytes / GIB);
  return gib < 1 ? "less than 1 GB" : `${gib} GB`;
}

/** The warning web and mobile show while the server reports low disk space. */
export function lowDiskNotice(
  volumes: ReadonlyArray<ServerLowDiskVolume> | undefined,
): LowDiskNotice | null {
  if (volumes === undefined || volumes.length === 0) return null;
  const places = volumes.map(
    (volume) => `${freeSpace(volume.freeBytes)} left ${ROLE_PLACE[volume.role]}`,
  );
  const consequence = volumes.some((volume) => volume.role === "state")
    ? "messages may fail to save"
    : "new worktrees may fail to be created";
  const summary = places.join("; ");
  return {
    title: "Low disk space on this server",
    description: `${summary.charAt(0).toUpperCase()}${summary.slice(1)}. Free some space or ${consequence}.`,
    paths: volumes.map((volume) => volume.path),
  };
}
