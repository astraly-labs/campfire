import type { ServerConfig, ServerConfigStreamEvent } from "@t3tools/contracts";
import * as Option from "effect/Option";

export interface ServerConfigProjection {
  readonly config: ServerConfig;
  readonly latestEvent: ServerConfigStreamEvent;
  readonly source: "cache" | "live";
}

/**
 * Cached config keeps the provider and model catalog available across reconnects.
 * Published themes, usage-limit sources, and low-disk volumes are current
 * machine state, so a cache could restore a set the machine no longer reports.
 * Replay sends each as a separate event.
 */
export function withoutEnvironmentThemes(config: ServerConfig): ServerConfig {
  if (
    config.environmentThemes === undefined &&
    config.usageLimitSources === undefined &&
    config.lowDiskVolumes === undefined
  ) {
    return config;
  }
  const {
    environmentThemes: _themes,
    usageLimitSources: _sources,
    lowDiskVolumes: _lowDisk,
    ...rest
  } = config;
  return rest;
}

export function applyServerConfigProjection(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamEvent,
): Option.Option<ServerConfigProjection> {
  switch (event.type) {
    case "snapshot": {
      // Wire snapshots never contain published themes. Keep the previous set
      // until a capable server sends its authoritative theme event. A legacy
      // server cannot send a later removal, so a downgrade must clear the set.
      const capabilities = event.config.environment.capabilities;
      const carriedThemes =
        capabilities.environmentThemes === true && Option.isSome(current)
          ? current.value.config.environmentThemes
          : undefined;
      const carriedSources =
        capabilities.usageLimitSources === true && Option.isSome(current)
          ? current.value.config.usageLimitSources
          : undefined;
      const carriedLowDisk =
        capabilities.lowDiskVolumes === true && Option.isSome(current)
          ? current.value.config.lowDiskVolumes
          : undefined;
      return Option.some({
        config: {
          ...event.config,
          ...(carriedThemes === undefined ? {} : { environmentThemes: carriedThemes }),
          ...(carriedSources === undefined ? {} : { usageLimitSources: carriedSources }),
          ...(carriedLowDisk === undefined ? {} : { lowDiskVolumes: carriedLowDisk }),
        },
        latestEvent: event,
        source: "live" as const,
      });
    }
    case "keybindingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          keybindings: event.payload.keybindings,
          issues: event.payload.issues,
        },
        latestEvent: event,
        source: "live",
      }));
    case "providerStatuses":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          providers: event.payload.providers,
        },
        latestEvent: event,
        source: "live",
      }));
    case "settingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          settings: event.payload.settings,
        },
        latestEvent: event,
        source: "live",
      }));
    case "environmentThemesUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          environmentThemes: event.payload.themes.length > 0 ? event.payload.themes : undefined,
        },
        latestEvent: event,
        source: "live",
      }));
    case "usageLimitSourcesUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          usageLimitSources: event.payload.sources.length > 0 ? event.payload.sources : undefined,
        },
        latestEvent: event,
        source: "live",
      }));
    case "lowDiskVolumesUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          lowDiskVolumes: event.payload.volumes.length > 0 ? event.payload.volumes : undefined,
        },
        latestEvent: event,
        source: "live",
      }));
  }
}
