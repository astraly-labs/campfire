import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, UrlParams } from "effect/unstable/http";
import { createRemoteJWKSet, jwtVerify } from "jose";

import type { GoogleOidcConfig } from "../config.ts";

export const GOOGLE_OIDC_TRANSACTION_COOKIE = "campfire_google_oidc";
const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const TRANSACTION_TTL_MS = 10 * 60 * 1_000;
const MAX_PENDING_TRANSACTIONS = 128;

export interface GoogleOidcIdentity {
  readonly subject: string;
  readonly googleSubject: string;
  readonly email: string;
  readonly displayName: string;
  readonly profilePictureUrl?: string;
}

export interface GoogleOidcAuthorizationRequest {
  readonly authorizationUrl: URL;
  readonly binding: string;
  readonly expiresAtMs: number;
}

interface PendingTransaction {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly binding: string;
  readonly returnTo: string;
  readonly expiresAtMs: number;
}

export class GoogleOidcTransactionError extends Data.TaggedError("GoogleOidcTransactionError")<{
  readonly reason: "invalid_return_to" | "invalid_state" | "expired_or_replayed";
}> {
  override get message(): string {
    return `Google OIDC transaction failed: ${this.reason}.`;
  }
}

export class GoogleOidcTokenError extends Data.TaggedError("GoogleOidcTokenError")<{
  readonly reason:
    | "exchange_failed"
    | "invalid_token_response"
    | "invalid_id_token"
    | "nonce_mismatch"
    | "unverified_email"
    | "invalid_identity";
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `Google OIDC token validation failed: ${this.reason}.`;
  }
}

export class GoogleOidcIdentityNotAllowedError extends Data.TaggedError(
  "GoogleOidcIdentityNotAllowedError",
)<{
  readonly email: string;
}> {
  override get message(): string {
    return "This Google identity is not allowed to access Campfire.";
  }
}

export type GoogleOidcError =
  | GoogleOidcTransactionError
  | GoogleOidcTokenError
  | GoogleOidcIdentityNotAllowedError;

export interface GoogleOidcTokenClient<R = never> {
  readonly exchangeAndVerify: (input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly nonce: string;
  }) => Effect.Effect<GoogleOidcIdentity, GoogleOidcTokenError, R>;
}

export interface GoogleOidcFlow<R = never> {
  readonly begin: (
    returnTo?: string,
  ) => Effect.Effect<GoogleOidcAuthorizationRequest, GoogleOidcTransactionError>;
  readonly complete: (input: {
    readonly code: string;
    readonly state: string;
    readonly binding: string | undefined;
  }) => Effect.Effect<
    { readonly identity: GoogleOidcIdentity; readonly returnTo: string },
    GoogleOidcError,
    R
  >;
}

function randomBase64Url(bytes = 32): string {
  return NodeCrypto.randomBytes(bytes).toString("base64url");
}

function codeChallenge(verifier: string): string {
  return NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
}

function normalizeReturnTo(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return "/";
  }
  if (!value.startsWith("/") || value.startsWith("//") || value.length > 2_048) {
    return undefined;
  }
  const base = new URL("https://campfire.invalid/");
  const resolved = new URL(value, base);
  if (resolved.origin !== base.origin) {
    return undefined;
  }
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

export function makeGoogleOidcFlow<R>(
  config: GoogleOidcConfig,
  tokenClient: GoogleOidcTokenClient<R>,
): Effect.Effect<GoogleOidcFlow<R>> {
  return Effect.gen(function* () {
    const pending = yield* Ref.make(new Map<string, PendingTransaction>());

    const begin: GoogleOidcFlow<R>["begin"] = Effect.fn("GoogleOidcFlow.begin")(
      function* (returnTo) {
        const normalizedReturnTo = normalizeReturnTo(returnTo);
        if (normalizedReturnTo === undefined) {
          return yield* new GoogleOidcTransactionError({ reason: "invalid_return_to" });
        }
        const now = yield* Clock.currentTimeMillis;
        const transaction: PendingTransaction = {
          state: randomBase64Url(),
          nonce: randomBase64Url(),
          codeVerifier: randomBase64Url(48),
          binding: randomBase64Url(),
          returnTo: normalizedReturnTo,
          expiresAtMs: now + TRANSACTION_TTL_MS,
        };
        yield* Ref.update(pending, (current) => {
          const next = new Map(Array.from(current).filter(([, entry]) => entry.expiresAtMs > now));
          while (next.size >= MAX_PENDING_TRANSACTIONS) {
            const oldest = next.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            next.delete(oldest);
          }
          next.set(transaction.state, transaction);
          return next;
        });

        const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
        authorizationUrl.search = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: config.redirectUri.toString(),
          response_type: "code",
          scope: "openid email profile",
          state: transaction.state,
          nonce: transaction.nonce,
          code_challenge: codeChallenge(transaction.codeVerifier),
          code_challenge_method: "S256",
          prompt: "select_account",
        }).toString();
        return {
          authorizationUrl,
          binding: transaction.binding,
          expiresAtMs: transaction.expiresAtMs,
        };
      },
    );

    const complete: GoogleOidcFlow<R>["complete"] = Effect.fn("GoogleOidcFlow.complete")(
      function* (input) {
        if (!input.state || !input.code || !input.binding) {
          return yield* new GoogleOidcTransactionError({ reason: "invalid_state" });
        }
        const now = yield* Clock.currentTimeMillis;
        const transaction = yield* Ref.modify(pending, (current) => {
          const candidate = current.get(input.state);
          const next = new Map(current);
          next.delete(input.state);
          return [candidate, next] as const;
        });
        const expectedBinding = Buffer.from(transaction?.binding ?? "");
        const presentedBinding = Buffer.from(input.binding);
        if (
          transaction === undefined ||
          transaction.expiresAtMs <= now ||
          expectedBinding.length !== presentedBinding.length ||
          !NodeCrypto.timingSafeEqual(expectedBinding, presentedBinding)
        ) {
          return yield* new GoogleOidcTransactionError({ reason: "expired_or_replayed" });
        }

        const identity = yield* tokenClient.exchangeAndVerify({
          code: input.code,
          codeVerifier: transaction.codeVerifier,
          nonce: transaction.nonce,
        });
        if (!config.allowedEmails.includes(identity.email.toLowerCase())) {
          return yield* new GoogleOidcIdentityNotAllowedError({ email: identity.email });
        }
        return { identity, returnTo: transaction.returnTo };
      },
    );

    return { begin, complete };
  });
}

const GoogleTokenResponse = Schema.Struct({
  id_token: Schema.String,
});
const decodeGoogleTokenResponse = Schema.decodeUnknownEffect(GoogleTokenResponse);

export const makeGoogleOidcTokenClient = Effect.fn("makeGoogleOidcTokenClient")(function* (
  config: GoogleOidcConfig,
): Effect.fn.Return<GoogleOidcTokenClient, never, HttpClient.HttpClient> {
  const httpClient = yield* HttpClient.HttpClient;
  return {
    exchangeAndVerify: Effect.fn("GoogleOidcTokenClient.exchangeAndVerify")(function* (input) {
      const response = yield* httpClient
        .post(GOOGLE_TOKEN_ENDPOINT, {
          body: HttpBody.urlParams(
            UrlParams.fromInput({
              client_id: config.clientId,
              client_secret: config.clientSecret,
              code: input.code,
              code_verifier: input.codeVerifier,
              grant_type: "authorization_code",
              redirect_uri: config.redirectUri.toString(),
            }),
          ),
        })
        .pipe(
          Effect.mapError(
            (cause) => new GoogleOidcTokenError({ reason: "exchange_failed", cause }),
          ),
        );
      if (response.status < 200 || response.status >= 300) {
        return yield* new GoogleOidcTokenError({ reason: "exchange_failed" });
      }
      const tokenResponse = yield* response.json.pipe(
        Effect.mapError(
          (cause) => new GoogleOidcTokenError({ reason: "invalid_token_response", cause }),
        ),
        Effect.flatMap(decodeGoogleTokenResponse),
        Effect.mapError(
          (cause) => new GoogleOidcTokenError({ reason: "invalid_token_response", cause }),
        ),
      );
      const verified = yield* Effect.tryPromise({
        try: () =>
          jwtVerify(tokenResponse.id_token, GOOGLE_JWKS, {
            audience: config.clientId,
            issuer: ["https://accounts.google.com", "accounts.google.com"],
          }),
        catch: (cause) => new GoogleOidcTokenError({ reason: "invalid_id_token", cause }),
      });
      const claims = verified.payload;
      if (claims.nonce !== input.nonce) {
        return yield* new GoogleOidcTokenError({ reason: "nonce_mismatch" });
      }
      if (claims.email_verified !== true) {
        return yield* new GoogleOidcTokenError({ reason: "unverified_email" });
      }
      if (typeof claims.sub !== "string" || typeof claims.email !== "string") {
        return yield* new GoogleOidcTokenError({ reason: "invalid_identity" });
      }
      const email = claims.email.trim().toLowerCase();
      if (!email) {
        return yield* new GoogleOidcTokenError({ reason: "invalid_identity" });
      }
      const displayName =
        typeof claims.name === "string" && claims.name.trim().length > 0
          ? claims.name.trim()
          : email;
      return {
        subject: `google:${claims.sub}`,
        googleSubject: claims.sub,
        email,
        displayName,
        ...(typeof claims.picture === "string" && claims.picture.length > 0
          ? { profilePictureUrl: claims.picture }
          : {}),
      } satisfies GoogleOidcIdentity;
    }),
  };
});

const productionFlows = new WeakMap<GoogleOidcConfig, GoogleOidcFlow<HttpClient.HttpClient>>();

export function googleOidcFlowForConfig(
  config: GoogleOidcConfig,
): GoogleOidcFlow<HttpClient.HttpClient> {
  const cached = productionFlows.get(config);
  if (cached !== undefined) return cached;
  const tokenClient: GoogleOidcTokenClient<HttpClient.HttpClient> = {
    exchangeAndVerify: (input) =>
      makeGoogleOidcTokenClient(config).pipe(
        Effect.flatMap((client) => client.exchangeAndVerify(input)),
      ),
  };
  const flow = Effect.runSync(makeGoogleOidcFlow(config, tokenClient));
  productionFlows.set(config, flow);
  return flow;
}

export function setGoogleOidcFlowForTesting(
  config: GoogleOidcConfig,
  flow: GoogleOidcFlow<HttpClient.HttpClient>,
): void {
  productionFlows.set(config, flow);
}

export function googleOidcBindingCookie(input: {
  readonly binding: string;
  readonly secure: boolean;
}): string {
  return [
    `${GOOGLE_OIDC_TRANSACTION_COOKIE}=${encodeURIComponent(input.binding)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/auth/google",
    `Max-Age=${Math.floor(TRANSACTION_TTL_MS / 1_000)}`,
    ...(input.secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearGoogleOidcBindingCookie(secure: boolean): string {
  return [
    `${GOOGLE_OIDC_TRANSACTION_COOKIE}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/auth/google",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
