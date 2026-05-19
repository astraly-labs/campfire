const ENABLED =
  import.meta.env.VITE_REALTIME_DEBUG === "1" || import.meta.env.VITE_REALTIME_DEBUG === "true";

export function isRealtimeDebugEnabled(): boolean {
  return ENABLED;
}

export function realtimeLog(
  channel: string,
  event: string,
  details?: Record<string, unknown>,
): void {
  if (!ENABLED) return;
  const tag = `[🚨 Realtime ${channel}]`;
  if (details === undefined) {
    console.warn(`${tag} ${event}`);
  } else {
    console.warn(`${tag} ${event}`, details);
  }
}
