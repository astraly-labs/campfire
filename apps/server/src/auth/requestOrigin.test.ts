import { describe, expect, it } from "vite-plus/test";

import { isBrowserRequestOriginAllowed } from "./requestOrigin.ts";

const config = {
  devUrl: new URL("http://127.0.0.1:5173"),
  googleOidc: {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: new URL("https://campfire.tail.example:10000/auth/google/callback"),
    allowedEmails: ["alice@example.com"],
  },
};

describe("browser request origin validation", () => {
  it("allows non-browser requests without an Origin header", () => {
    expect(isBrowserRequestOriginAllowed({ origin: undefined, host: undefined, config })).toBe(
      true,
    );
  });

  it("allows exact same-authority and configured renderer origins", () => {
    expect(
      isBrowserRequestOriginAllowed({
        origin: "https://campfire.tail.example:10000",
        host: "campfire.tail.example:10000",
        config,
      }),
    ).toBe(true);
    expect(
      isBrowserRequestOriginAllowed({
        origin: "https://campfire.tail.example:10000",
        host: "127.0.0.1:3774",
        config,
      }),
    ).toBe(true);
    expect(
      isBrowserRequestOriginAllowed({
        origin: "http://127.0.0.1:5173",
        host: "127.0.0.1:3773",
        config,
      }),
    ).toBe(true);
    expect(isBrowserRequestOriginAllowed({ origin: "t3code://app", host: undefined, config })).toBe(
      true,
    );
  });

  it("rejects cross-site, malformed, credentialed, and path-bearing origins", () => {
    for (const origin of [
      "https://evil.example",
      "null",
      " https://campfire.tail.example:10000",
      "https://user@campfire.tail.example:10000",
      "https://campfire.tail.example:10000/path",
    ]) {
      expect(
        isBrowserRequestOriginAllowed({
          origin,
          host: "campfire.tail.example:10000",
          config,
        }),
        origin,
      ).toBe(false);
    }
  });
});
