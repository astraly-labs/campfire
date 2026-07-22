import type { ServerConfig } from "../config.ts";

export const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"] as const;

const MAX_ORIGIN_LENGTH = 2_048;
const MAX_HOST_LENGTH = 512;

type BrowserOriginConfig = Pick<ServerConfig["Service"], "devUrl" | "googleOidc">;

function normalizeRequestHost(host: string | undefined): string | null {
  if (
    host === undefined ||
    host.length === 0 ||
    host.length > MAX_HOST_LENGTH ||
    /[\s\\/,]/.test(host)
  ) {
    return null;
  }

  try {
    const parsed = new URL(`http://${host}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.host;
  } catch {
    return null;
  }
}

function configuredOrigins(config: BrowserOriginConfig): ReadonlySet<string> {
  return new Set(
    [
      config.devUrl?.origin,
      config.googleOidc?.redirectUri.origin,
      ...DESKTOP_RENDERER_ORIGINS,
    ].filter((origin): origin is string => origin !== undefined),
  );
}

/**
 * Browser requests always carry Origin for WebSocket handshakes and unsafe cross-origin HTTP
 * requests. Non-browser/GET clients may omit it, so absence remains valid; a presented Origin must
 * either be an explicitly configured renderer origin or match the request authority exactly.
 */
export function isBrowserRequestOriginAllowed(input: {
  readonly origin: string | undefined;
  readonly host: string | undefined;
  readonly config: BrowserOriginConfig;
}): boolean {
  const { origin } = input;
  if (origin === undefined) {
    return true;
  }
  if (origin.length === 0 || origin.length > MAX_ORIGIN_LENGTH || origin.trim() !== origin) {
    return false;
  }
  if (configuredOrigins(input.config).has(origin)) {
    return true;
  }

  const requestHost = normalizeRequestHost(input.host);
  if (requestHost === null) {
    return false;
  }

  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === origin &&
      parsed.host === requestHost
    );
  } catch {
    return false;
  }
}
