import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as Option from "effect/Option";

import { isLoopbackHost } from "../startupAccess.ts";

export interface TrustedTailscaleServeIdentity {
  readonly login: string;
  readonly displayName: string;
  readonly profilePictureUrl?: string;
}

function normalizeHeader(value: string | undefined, maximumLength: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > maximumLength) {
    return undefined;
  }
  return normalized;
}

function sourceRemoteAddress(source: unknown): string | undefined {
  if (typeof source !== "object" || source === null) {
    return undefined;
  }
  const candidate = source as {
    readonly remoteAddress?: string | null;
    readonly socket?: { readonly remoteAddress?: string | null };
  };
  return candidate.socket?.remoteAddress ?? candidate.remoteAddress ?? undefined;
}

export function normalizeRemoteAddress(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

export function isLoopbackRemoteAddress(value: string | undefined): boolean {
  const normalized = normalizeRemoteAddress(value);
  return (
    normalized === "::1" || normalized === "localhost" || normalized?.startsWith("127.") === true
  );
}

function requestRemoteAddress(request: HttpServerRequest.HttpServerRequest): string | undefined {
  const remoteAddress = request.remoteAddress;
  if (remoteAddress && Option.isSome(remoteAddress)) {
    return remoteAddress.value;
  }
  return sourceRemoteAddress(request.source);
}

/**
 * Tailscale Serve removes spoofed identity headers before adding its own, but
 * that guarantee exists only on the daemon-to-backend hop. Trust them only
 * when Serve is explicitly enabled, the backend is loopback-only, and the
 * immediate TCP peer is loopback.
 */
export function resolveTrustedTailscaleServeIdentity(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly tailscaleServeEnabled: boolean;
  readonly serverHost: string | undefined;
}): Option.Option<TrustedTailscaleServeIdentity> {
  if (
    !input.tailscaleServeEnabled ||
    !isLoopbackHost(input.serverHost) ||
    !isLoopbackRemoteAddress(requestRemoteAddress(input.request))
  ) {
    return Option.none();
  }

  const login = normalizeHeader(input.request.headers["tailscale-user-login"], 320);
  const displayName = normalizeHeader(input.request.headers["tailscale-user-name"], 200);
  if (!login || !displayName) {
    return Option.none();
  }
  const profilePictureUrl = normalizeHeader(
    input.request.headers["tailscale-user-profile-pic"],
    2_048,
  );
  return Option.some({
    login: login.toLowerCase(),
    displayName,
    ...(profilePictureUrl ? { profilePictureUrl } : {}),
  });
}
