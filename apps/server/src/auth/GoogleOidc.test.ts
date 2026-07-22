import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { describe, expect } from "vite-plus/test";

import type { GoogleOidcConfig } from "../config.ts";
import {
  GoogleOidcIdentityNotAllowedError,
  GoogleOidcTransactionError,
  googleOidcBindingCookie,
  makeGoogleOidcFlow,
  type GoogleOidcIdentity,
  type GoogleOidcTokenClient,
} from "./GoogleOidc.ts";

const config: GoogleOidcConfig = {
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
  redirectUri: new URL("https://campfire.example.ts.net/auth/google/callback"),
  allowedEmails: ["alice@example.com"],
};

const alice: GoogleOidcIdentity = {
  subject: "google:alice-sub",
  googleSubject: "alice-sub",
  email: "alice@example.com",
  displayName: "Alice Example",
};

describe("GoogleOidcFlow", () => {
  it.effect("binds state, nonce, PKCE, browser cookie, and one-time completion", () =>
    Effect.gen(function* () {
      const exchangeInputs = yield* Ref.make<
        ReadonlyArray<{
          readonly code: string;
          readonly codeVerifier: string;
          readonly nonce: string;
        }>
      >([]);
      const tokenClient: GoogleOidcTokenClient = {
        exchangeAndVerify: (input) =>
          Ref.update(exchangeInputs, (inputs) => [...inputs, input]).pipe(Effect.as(alice)),
      };
      const flow = yield* makeGoogleOidcFlow(config, tokenClient);
      const started = yield* flow.begin("/threads/active");

      expect(started.authorizationUrl.origin).toBe("https://accounts.google.com");
      expect(started.authorizationUrl.searchParams.get("scope")).toBe("openid email profile");
      expect(started.authorizationUrl.searchParams.get("state")).toBeTruthy();
      expect(started.authorizationUrl.searchParams.get("nonce")).toBeTruthy();
      expect(started.authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(googleOidcBindingCookie({ binding: started.binding, secure: true })).toContain(
        "HttpOnly; SameSite=Lax",
      );

      const completed = yield* flow.complete({
        code: "authorization-code",
        state: started.authorizationUrl.searchParams.get("state")!,
        binding: started.binding,
      });
      expect(completed).toEqual({ identity: alice, returnTo: "/threads/active" });
      expect(yield* Ref.get(exchangeInputs)).toHaveLength(1);

      const replay = yield* flow
        .complete({
          code: "authorization-code-replay",
          state: started.authorizationUrl.searchParams.get("state")!,
          binding: started.binding,
        })
        .pipe(Effect.flip);
      expect(replay).toBeInstanceOf(GoogleOidcTransactionError);
    }),
  );

  it.effect("consumes a transaction on browser-binding mismatch", () =>
    Effect.gen(function* () {
      const exchanges = yield* Ref.make(0);
      const flow = yield* makeGoogleOidcFlow(config, {
        exchangeAndVerify: () => Ref.update(exchanges, (count) => count + 1).pipe(Effect.as(alice)),
      });
      const started = yield* flow.begin();
      const state = started.authorizationUrl.searchParams.get("state")!;

      const mismatch = yield* flow
        .complete({ code: "code", state, binding: "attacker-binding" })
        .pipe(Effect.flip);
      const replay = yield* flow
        .complete({ code: "code", state, binding: started.binding })
        .pipe(Effect.flip);

      expect(mismatch).toBeInstanceOf(GoogleOidcTransactionError);
      expect(replay).toBeInstanceOf(GoogleOidcTransactionError);
      expect(yield* Ref.get(exchanges)).toBe(0);
    }),
  );

  it.effect("rejects a verified Google identity outside the explicit allowlist", () =>
    Effect.gen(function* () {
      const flow = yield* makeGoogleOidcFlow(config, {
        exchangeAndVerify: () =>
          Effect.succeed({
            ...alice,
            subject: "google:bob-sub",
            googleSubject: "bob-sub",
            email: "bob@example.com",
            displayName: "Bob Example",
          }),
      });
      const started = yield* flow.begin();
      const error = yield* flow
        .complete({
          code: "code",
          state: started.authorizationUrl.searchParams.get("state")!,
          binding: started.binding,
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(GoogleOidcIdentityNotAllowedError);
    }),
  );

  it.effect("rejects open redirects before creating a transaction", () =>
    Effect.gen(function* () {
      const flow = yield* makeGoogleOidcFlow(config, {
        exchangeAndVerify: () => Effect.succeed(alice),
      });
      const error = yield* flow.begin("//attacker.example").pipe(Effect.flip);
      expect(error).toBeInstanceOf(GoogleOidcTransactionError);

      const backslashError = yield* flow.begin("/\\attacker.example").pipe(Effect.flip);
      expect(backslashError).toBeInstanceOf(GoogleOidcTransactionError);
    }),
  );
});
