import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { resolveTrustedTailscaleServeIdentity } from "./tailscaleServeIdentity.ts";

const request = (remoteAddress: string, headers: Record<string, string>) =>
  ({
    headers,
    source: { socket: { remoteAddress } },
  }) as never;

const identityHeaders = {
  "tailscale-user-login": "Alice@Example.com",
  "tailscale-user-name": "Alice Example",
  "tailscale-user-profile-pic": "https://example.com/alice.png",
};

describe("resolveTrustedTailscaleServeIdentity", () => {
  it("accepts daemon-injected identity only on the enabled loopback hop", () => {
    const identity = resolveTrustedTailscaleServeIdentity({
      request: request("::ffff:127.0.0.1", identityHeaders),
      tailscaleServeEnabled: true,
      serverHost: "127.0.0.1",
    });

    expect(Option.getOrThrow(identity)).toEqual({
      login: "alice@example.com",
      displayName: "Alice Example",
      profilePictureUrl: "https://example.com/alice.png",
    });
  });

  it("ignores forged identity headers from a direct tailnet peer", () => {
    const identity = resolveTrustedTailscaleServeIdentity({
      request: request("100.82.10.20", identityHeaders),
      tailscaleServeEnabled: true,
      serverHost: "127.0.0.1",
    });

    expect(Option.isNone(identity)).toBe(true);
  });

  it("ignores identity headers when the backend also listens beyond loopback", () => {
    const identity = resolveTrustedTailscaleServeIdentity({
      request: request("127.0.0.1", identityHeaders),
      tailscaleServeEnabled: true,
      serverHost: "0.0.0.0",
    });

    expect(Option.isNone(identity)).toBe(true);
  });

  it("ignores loopback identity headers when Tailscale Serve is disabled", () => {
    const identity = resolveTrustedTailscaleServeIdentity({
      request: request("127.0.0.1", identityHeaders),
      tailscaleServeEnabled: false,
      serverHost: "127.0.0.1",
    });

    expect(Option.isNone(identity)).toBe(true);
  });
});
