import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import {
  GOOGLE_OIDC_TRANSACTION_COOKIE,
  GoogleOidcIdentityNotAllowedError,
  googleOidcFlowForConfig,
} from "./GoogleOidc.ts";
import * as SessionStore from "./SessionStore.ts";
import { deriveAuthClientMetadata } from "./utils.ts";
import * as ServerConfig from "../config.ts";

const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
} as const;

const transactionCookieOptions = (secure: boolean) =>
  ({
    httpOnly: true,
    path: "/auth/google",
    sameSite: "lax",
    secure,
  }) as const;

const sessionCookieOptions = (secure: boolean, expires: Date) =>
  ({
    expires,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure,
  }) as const;

function noStore(response: HttpServerResponse.HttpServerResponse) {
  return HttpServerResponse.setHeaders(response, NO_STORE_HEADERS);
}

function clearTransactionCookie(response: HttpServerResponse.HttpServerResponse, secure: boolean) {
  return HttpServerResponse.setCookieUnsafe(response, GOOGLE_OIDC_TRANSACTION_COOKIE, "", {
    ...transactionCookieOptions(secure),
    maxAge: 0,
  });
}

const googleOidcLoginRouteLayer = HttpRouter.add(
  "GET",
  "/auth/google/login",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const config = serverConfig.googleOidc;
    if (config === undefined) {
      return noStore(HttpServerResponse.text("Google sign-in is not configured.", { status: 404 }));
    }
    const flow = googleOidcFlowForConfig(config);
    const secureCookies = config.redirectUri.protocol === "https:";
    const requestUrl = HttpServerRequest.toURL(request);
    if (Option.isNone(requestUrl)) {
      return noStore(HttpServerResponse.text("Invalid request URL.", { status: 400 }));
    }
    return yield* flow.begin(requestUrl.value.searchParams.get("returnTo") ?? undefined).pipe(
      Effect.map((authorization) =>
        HttpServerResponse.redirect(authorization.authorizationUrl, { status: 302 }).pipe(
          HttpServerResponse.setCookieUnsafe(
            GOOGLE_OIDC_TRANSACTION_COOKIE,
            authorization.binding,
            {
              ...transactionCookieOptions(secureCookies),
              maxAge: "10 minutes",
            },
          ),
          noStore,
        ),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Rejected Google OIDC login request.", {
          errorTag: error._tag,
        }).pipe(
          Effect.as(noStore(HttpServerResponse.text("Invalid sign-in request.", { status: 400 }))),
        ),
      ),
    );
  }),
);

const googleOidcCallbackRouteLayer = HttpRouter.add(
  "GET",
  "/auth/google/callback",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const config = serverConfig.googleOidc;
    if (config === undefined) {
      return noStore(HttpServerResponse.text("Google sign-in is not configured.", { status: 404 }));
    }
    const flow = googleOidcFlowForConfig(config);
    const secureCookies = config.redirectUri.protocol === "https:";
    const requestUrl = HttpServerRequest.toURL(request);
    if (Option.isNone(requestUrl)) {
      return noStore(HttpServerResponse.text("Invalid request URL.", { status: 400 }));
    }
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const code = requestUrl.value.searchParams.get("code") ?? "";
    const state = requestUrl.value.searchParams.get("state") ?? "";

    return yield* flow
      .complete({
        code,
        state,
        binding: request.cookies[GOOGLE_OIDC_TRANSACTION_COOKIE],
      })
      .pipe(
        Effect.flatMap(({ identity, returnTo }) =>
          serverAuth
            .issueTrustedBrowserSession(
              {
                subject: identity.subject,
                displayName: identity.displayName,
              },
              deriveAuthClientMetadata({ request }),
            )
            .pipe(
              Effect.map((session) =>
                HttpServerResponse.redirect(returnTo, { status: 302 }).pipe(
                  HttpServerResponse.setCookiesUnsafe([
                    [
                      sessions.cookieName,
                      session.sessionToken,
                      sessionCookieOptions(
                        secureCookies,
                        DateTime.toDate(session.response.expiresAt),
                      ),
                    ],
                    [
                      GOOGLE_OIDC_TRANSACTION_COOKIE,
                      "",
                      { ...transactionCookieOptions(secureCookies), maxAge: 0 },
                    ],
                  ]),
                  noStore,
                ),
              ),
            ),
        ),
        Effect.catch((error) =>
          Effect.logWarning("Rejected Google OIDC callback.", {
            errorTag: error._tag,
          }).pipe(
            Effect.as(
              noStore(
                clearTransactionCookie(
                  HttpServerResponse.text(
                    error instanceof GoogleOidcIdentityNotAllowedError
                      ? "This Google account is not allowed to access Campfire."
                      : "Google sign-in could not be completed.",
                    {
                      status: error instanceof GoogleOidcIdentityNotAllowedError ? 403 : 400,
                    },
                  ),
                  secureCookies,
                ),
              ),
            ),
          ),
        ),
      );
  }),
);

export const googleOidcRoutesLayer = Layer.merge(
  googleOidcLoginRouteLayer,
  googleOidcCallbackRouteLayer,
);
