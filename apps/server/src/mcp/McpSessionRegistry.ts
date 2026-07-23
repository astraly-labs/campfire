import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/unstable/http";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  /**
   * Records a sign of life for every credential bound to `threadId`. Provider
   * turns call this so that a session which is plainly alive keeps its
   * credential even when it goes a long time without touching an MCP tool.
   */
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly lastAliveAt: number;
  readonly lastPersistedAt: number;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

const PersistedCredentialState = Schema.Struct({
  version: Schema.Literal(1),
  records: Schema.Array(
    Schema.Struct({
      tokenHash: Schema.String,
      scope: Schema.Struct({
        environmentId: EnvironmentId,
        threadId: ThreadId,
        providerSessionId: Schema.String,
        providerInstanceId: ProviderInstanceId,
        capabilities: Schema.Array(Schema.Literal("preview")),
        issuedAt: Schema.Number,
        expiresAt: Schema.optional(Schema.Number),
      }),
      lastUsedAt: Schema.Number,
    }),
  ),
});
type PersistedCredentialState = typeof PersistedCredentialState.Type;
const PersistedCredentialStateJson = Schema.fromJsonString(PersistedCredentialState);
const decodePersistedCredentialState = Schema.decodeUnknownEffect(PersistedCredentialStateJson);
const encodePersistedCredentialState = Schema.encodeEffect(PersistedCredentialStateJson);

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
  readonly persistencePath?: string;
}

/**
 * How long a credential outlives the last sign of life from its provider
 * session.
 *
 * Liveness is refreshed both by MCP traffic and by `touch` on every provider
 * turn, so a session that is still doing work never expires no matter how long
 * it goes between browser tool calls. This window therefore only bounds
 * credentials whose session died without a clean stop — the normal paths
 * (`stopSession`, `stopAll`) revoke eagerly and do not wait for it.
 *
 * The bound matters because `/mcp` is mounted outside the environment auth
 * stack and is reachable on whatever host the server binds to, so this token is
 * the only thing guarding the preview toolkit on a remote-reachable server.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;
const PERSISTED_LAST_USED_INTERVAL_MS = 60_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const getHttpMcpEndpointHost = (hostname: string): string => {
  const normalized = hostname.toLowerCase();
  const endpointHostname =
    normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]"
      ? "127.0.0.1"
      : hostname;
  return endpointHostname.includes(":") && !endpointHostname.startsWith("[")
    ? `[${endpointHostname}]`
    : endpointHostname;
};

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const endpoint =
    httpServer.address._tag === "TcpAddress"
      ? `http://${getHttpMcpEndpointHost(httpServer.address.hostname)}:${httpServer.address.port}/mcp`
      : "http://127.0.0.1/mcp";

  const loadPersistedRecords = Effect.gen(function* () {
    if (!options.persistencePath) return new Map<string, CredentialRecord>();
    const exists = yield* fs
      .exists(options.persistencePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return new Map<string, CredentialRecord>();
    return yield* fs.readFileString(options.persistencePath).pipe(
      Effect.flatMap(decodePersistedCredentialState),
      Effect.map(
        (persisted) =>
          new Map<string, CredentialRecord>(
            persisted.records.map((record) => [
              record.tokenHash,
              {
                tokenHash: record.tokenHash,
                scope: {
                  ...record.scope,
                  capabilities: new Set(record.scope.capabilities),
                },
                lastAliveAt: record.lastUsedAt,
                lastPersistedAt: record.lastUsedAt,
              },
            ]),
          ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("mcp.credentials.load-failed", {
          persistencePath: options.persistencePath,
          cause,
        }).pipe(Effect.as(new Map<string, CredentialRecord>())),
      ),
    );
  });
  const state = yield* SynchronizedRef.make<RegistryState>({
    records: yield* loadPersistedRecords,
  });

  const persist = (records: ReadonlyMap<string, CredentialRecord>) => {
    if (!options.persistencePath) return Effect.void;
    const persisted: PersistedCredentialState = {
      version: 1,
      records: Array.from(records.values(), (record) => ({
        tokenHash: record.tokenHash,
        scope: {
          ...record.scope,
          capabilities: Array.from(record.scope.capabilities).filter(
            (capability): capability is "preview" => capability === "preview",
          ),
        },
        lastUsedAt: record.lastAliveAt,
      })),
    };
    return encodePersistedCredentialState(persisted).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({
          filePath: options.persistencePath!,
          contents,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, pathService),
        ),
      ),
      Effect.andThen(fs.chmod(options.persistencePath, 0o600)),
      Effect.catchCause((cause) =>
        Effect.logWarning("mcp.credentials.persist-failed", {
          persistencePath: options.persistencePath,
          cause,
        }),
      ),
    );
  };

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const pruneDead = (records: ReadonlyMap<string, CredentialRecord>, timestamp: number) => {
    const next = new Map(
      Array.from(records).filter(
        ([, record]) => timestamp - record.lastAliveAt <= livenessWindowMs,
      ),
    );
    return next.size === records.size ? records : next;
  };

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        threadId: ThreadId.make(request.threadId),
        providerSessionId,
        providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
        capabilities: new Set(["preview"]),
        issuedAt,
      };
      yield* SynchronizedRef.modifyEffect(state, ({ records }) => {
        const next = new Map(pruneDead(records, issuedAt));
        next.set(tokenHash, {
          tokenHash,
          scope,
          lastAliveAt: issuedAt,
          lastPersistedAt: issuedAt,
        });
        const nextState = { records: next };
        return persist(next).pipe(Effect.as([undefined, nextState] as const));
      });
      return {
        config: {
          environmentId,
          threadId: scope.threadId,
          providerSessionId,
          providerInstanceId: scope.providerInstanceId,
          endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
        },
      };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const timestamp = yield* currentTimeMillis;
      return yield* SynchronizedRef.modifyEffect(state, ({ records }) => {
        const current = pruneDead(records, timestamp);
        const record = current.get(tokenHash);
        if (!record) {
          const nextState = { records: current };
          return (current.size === records.size ? Effect.void : persist(current)).pipe(
            Effect.as([undefined, nextState] as const),
          );
        }
        const next = new Map(current);
        const shouldPersist = timestamp - record.lastPersistedAt >= PERSISTED_LAST_USED_INTERVAL_MS;
        next.set(tokenHash, {
          ...record,
          lastAliveAt: timestamp,
          lastPersistedAt: shouldPersist ? timestamp : record.lastPersistedAt,
        });
        const nextState = { records: next };
        return (shouldPersist ? persist(next) : Effect.void).pipe(
          Effect.as([record.scope, nextState] as const),
        );
      });
    },
  );

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const timestamp = yield* currentTimeMillis;
      yield* SynchronizedRef.modifyEffect(state, ({ records }) => {
        const current = pruneDead(records, timestamp);
        const next = new Map(current);
        let shouldPersist = current.size !== records.size;
        for (const [tokenHash, record] of current) {
          if (record.scope.threadId === threadId) {
            const persistTouch =
              timestamp - record.lastPersistedAt >= PERSISTED_LAST_USED_INTERVAL_MS;
            next.set(tokenHash, {
              ...record,
              lastAliveAt: timestamp,
              lastPersistedAt: persistTouch ? timestamp : record.lastPersistedAt,
            });
            shouldPersist ||= persistTouch;
          }
        }
        const nextState = { records: next };
        return (shouldPersist ? persist(next) : Effect.void).pipe(
          Effect.as([undefined, nextState] as const),
        );
      });
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.modifyEffect(state, ({ records }) => {
      const next = new Map(Array.from(records).filter(([, record]) => !predicate(record)));
      const nextState = { records: next };
      return persist(next).pipe(Effect.as([undefined, nextState] as const));
    });

  return McpSessionRegistry.of({
    issue,
    resolve,
    touch,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.threadId === threadId);
    }),
    revokeAll: revokeWhere(() => true),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* makeWithOptions({
      persistencePath: path.join(config.secretsDir, "mcp-credentials.json"),
    });
  }).pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry
        .revokeThread(request.threadId)
        .pipe(Effect.andThen(activeMcpSessionRegistry.issue(request)))
    : Effect.sync((): McpIssuedCredential | undefined => undefined);

/**
 * Refreshes the liveness of a thread's MCP credential. Called on every provider
 * turn so an active session is never mistaken for an abandoned one.
 */
export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

export const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void;

export const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

/** Exposed for tests. */
export const __testing = {
  make: makeWithOptions,
};
