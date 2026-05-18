/**
 * UserIdentity live — `tailscale whois <ip> --json` backed.
 *
 * Caches resolved peer → ResolvedIdentity tuples for `CACHE_TTL_MS` to avoid
 * invoking the CLI on every WS frame. On a cache miss it spawns the CLI,
 * parses the JSON output, and upserts `users` + `user_devices` rows. The
 * cache is process-local — restarting the daemon repopulates it lazily.
 *
 * Identity model: the tailnet login name (e.g. `alice@pragma.build`) is the
 * stable `UserId`. The Node ID returned by `tailscale whois` identifies the
 * device on which the peer is currently connected.
 *
 * Local fallback: when the request IP is missing or non-tailnet (dev on
 * localhost, IPv6 link-local, etc.) we synthesise a stable
 * `local:<os-user>` identity from `os.userInfo()`. This keeps the
 * side-thread / settings flow working in non-Tailscale environments without
 * prompting the operator.
 *
 * Override model: `users.display_name_override` (nullable) wins over
 * `users.display_name` (the canonical name pulled from Tailscale or the OS
 * user). The effective `UserRef.displayName` is computed as
 * `override ?? canonical`, and the Settings UI is the only caller that
 * mutates the override column.
 *
 * @module UserIdentityLive
 */
import os from "node:os";

import type { IdentitySource, UserId, UserRef } from "@t3tools/contracts";
import { isTailscaleIpv4Address } from "@t3tools/tailscale";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  UserIdentityDecodeError,
  UserIdentityWhoisError,
  type UserIdentityError,
} from "../Errors.ts";
import {
  UserIdentityService,
  type ResolvedIdentity,
  type UserIdentityShape,
} from "../Services/UserIdentity.ts";

const CACHE_TTL_MS = 5 * 60 * 1000;
const WHOIS_TIMEOUT_MS = 1_500;

const TailscaleWhoisOutput = Schema.Struct({
  Node: Schema.Struct({
    ID: Schema.Number,
  }),
  UserProfile: Schema.Struct({
    LoginName: Schema.String,
    DisplayName: Schema.String,
  }),
});
const decodeWhois = Schema.decodeUnknownEffect(Schema.fromJsonString(TailscaleWhoisOutput));

interface CacheEntry {
  readonly identity: ResolvedIdentity;
  readonly nodeId: number | null;
  readonly expiresAtMs: number;
}

const UsersRow = Schema.Struct({
  user_id: Schema.String,
  display_name: Schema.String,
  display_name_override: Schema.NullOr(Schema.String),
});
const decodeUsersRows = Schema.decodeUnknownEffect(Schema.Array(UsersRow));

const collect = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const stripIpv4MappedPrefix = (ip: string): string =>
  ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;

const buildResolvedIdentity = (input: {
  readonly userId: UserId;
  readonly canonicalDisplayName: string;
  readonly override: string | null;
  readonly source: IdentitySource;
}): ResolvedIdentity => {
  const effective = input.override ?? input.canonicalDisplayName;
  return {
    user: { id: input.userId, displayName: effective },
    canonicalDisplayName: input.canonicalDisplayName,
    source: input.source,
    hasOverride: input.override !== null,
  };
};

const runWhois = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], tailnetIp: string) =>
  Effect.gen(function* () {
    const args = ["whois", "--json", tailnetIp];
    const child = yield* spawner
      .spawn(
        ChildProcess.make("tailscale", args, {
          shell: process.platform === "win32",
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new UserIdentityWhoisError({
              tailnetIp,
              detail: cause instanceof Error ? cause.message : "Failed to spawn tailscale whois",
              cause,
            }),
        ),
      );

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new UserIdentityWhoisError({
            tailnetIp,
            detail:
              cause instanceof Error ? cause.message : "Failed to read tailscale whois output",
            cause,
          }),
      ),
    );

    if (exitCode !== 0) {
      return yield* new UserIdentityWhoisError({
        tailnetIp,
        detail: `tailscale whois exited with code ${exitCode}: ${stderr.trim()}`,
      });
    }
    return stdout;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(WHOIS_TIMEOUT_MS),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(
            new UserIdentityWhoisError({
              tailnetIp,
              detail: `tailscale whois timed out after ${WHOIS_TIMEOUT_MS}ms`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

const makeUserIdentity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const cache = new Map<string, CacheEntry>();

  const invalidateCacheForUser = (userId: UserId): void => {
    for (const [key, entry] of cache) {
      if (entry.identity.user.id === userId) cache.delete(key);
    }
  };

  const upsertUserRow = (params: {
    readonly userId: UserId;
    readonly canonicalDisplayName: string;
  }) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      // Note: we deliberately do NOT touch display_name_override on conflict;
      // it is owned by the Settings UI mutation path.
      yield* sql`
        INSERT INTO users (user_id, display_name, created_at, updated_at)
        VALUES (${params.userId}, ${params.canonicalDisplayName}, ${now}, ${now})
        ON CONFLICT(user_id) DO UPDATE SET
          display_name = excluded.display_name,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError(toPersistenceSqlError("UserIdentity.upsertUser")));
    });

  const upsertDeviceRow = (params: {
    readonly userId: UserId;
    readonly tailnetName: string;
    readonly nodeId: number;
  }) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const deviceId = String(params.nodeId);
      yield* sql`
        INSERT INTO user_devices (device_id, user_id, tailnet_name, paired_at, last_seen_at)
        VALUES (${deviceId}, ${params.userId}, ${params.tailnetName}, ${now}, ${now})
        ON CONFLICT(device_id) DO UPDATE SET
          user_id = excluded.user_id,
          tailnet_name = excluded.tailnet_name,
          last_seen_at = excluded.last_seen_at
      `.pipe(Effect.mapError(toPersistenceSqlError("UserIdentity.upsertDevice")));
    });

  const readUserRow = (userId: UserId) =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT user_id, display_name, display_name_override
        FROM users
        WHERE user_id = ${userId}
        LIMIT 1
      `.pipe(Effect.mapError(toPersistenceSqlError("UserIdentity.readUserRow")));
      const decoded = yield* decodeUsersRows(rows).pipe(
        Effect.mapError(
          (cause) =>
            new UserIdentityDecodeError({
              tailnetIp: userId,
              issue: cause instanceof Error ? cause.message : "Failed to decode users row",
              cause,
            }),
        ),
      );
      return decoded.length > 0 ? decoded[0] : null;
    });

  const resolveByTailnetIpFull = (
    tailnetIp: string,
  ): Effect.Effect<ResolvedIdentity, UserIdentityError> =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const cached = cache.get(tailnetIp);
      if (cached && cached.expiresAtMs > nowMs) {
        return cached.identity;
      }

      const stdout = yield* runWhois(spawner, tailnetIp);
      const parsed = yield* decodeWhois(stdout).pipe(
        Effect.mapError(
          (cause) =>
            new UserIdentityDecodeError({
              tailnetIp,
              issue: cause instanceof Error ? cause.message : "Failed to decode whois output",
              cause,
            }),
        ),
      );

      const userId = parsed.UserProfile.LoginName as unknown as UserId;
      const canonical = parsed.UserProfile.DisplayName;

      yield* upsertUserRow({ userId, canonicalDisplayName: canonical });
      yield* upsertDeviceRow({
        userId,
        tailnetName: parsed.UserProfile.LoginName,
        nodeId: parsed.Node.ID,
      });

      const row = yield* readUserRow(userId);
      const override = row?.display_name_override ?? null;
      const identity = buildResolvedIdentity({
        userId,
        canonicalDisplayName: canonical,
        override,
        source: "tailscale-whois",
      });

      cache.set(tailnetIp, {
        identity,
        nodeId: parsed.Node.ID,
        expiresAtMs: nowMs + CACHE_TTL_MS,
      });
      return identity;
    });

  const resolveLocalFallback = (): Effect.Effect<ResolvedIdentity, UserIdentityError> =>
    Effect.gen(function* () {
      const info = os.userInfo();
      const username = (info.username || "anonymous").trim() || "anonymous";
      const userId = `local:${username}` as unknown as UserId;
      const cacheKey = `local:${username}`;

      const nowMs = yield* Clock.currentTimeMillis;
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAtMs > nowMs) {
        return cached.identity;
      }

      yield* upsertUserRow({ userId, canonicalDisplayName: username });
      const row = yield* readUserRow(userId);
      const override = row?.display_name_override ?? null;
      const identity = buildResolvedIdentity({
        userId,
        canonicalDisplayName: username,
        override,
        source: "local-fallback",
      });

      cache.set(cacheKey, {
        identity,
        nodeId: null,
        expiresAtMs: nowMs + CACHE_TTL_MS,
      });
      return identity;
    });

  const resolveByTailnetIp: UserIdentityShape["resolveByTailnetIp"] = (tailnetIp) =>
    resolveByTailnetIpFull(tailnetIp).pipe(Effect.map((identity) => identity.user));

  const resolveByRequestIp: UserIdentityShape["resolveByRequestIp"] = (ipAddress) =>
    Effect.gen(function* () {
      if (!ipAddress) {
        return yield* resolveLocalFallback();
      }
      const normalized = stripIpv4MappedPrefix(ipAddress);
      if (isTailscaleIpv4Address(normalized)) {
        return yield* resolveByTailnetIpFull(normalized);
      }
      return yield* resolveLocalFallback();
    });

  const setDisplayNameOverride: UserIdentityShape["setDisplayNameOverride"] = (userId, override) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const trimmed = override === null ? null : override.trim();
      const normalized = trimmed && trimmed.length > 0 ? trimmed : null;

      yield* sql`
        UPDATE users
        SET display_name_override = ${normalized},
            updated_at = ${now}
        WHERE user_id = ${userId}
      `.pipe(Effect.mapError(toPersistenceSqlError("UserIdentity.setDisplayNameOverride")));

      invalidateCacheForUser(userId);

      const row = yield* readUserRow(userId);
      if (!row) {
        return yield* new UserIdentityDecodeError({
          tailnetIp: userId,
          issue: "User row missing after override update",
        });
      }
      // Source is unknown from the row alone; infer from the userId prefix
      // (`local:<name>` for the fallback path, anything else is a tailnet
      // login). This is purely cosmetic for the Settings UI badge.
      const source: IdentitySource = userId.startsWith("local:")
        ? "local-fallback"
        : "tailscale-whois";
      return buildResolvedIdentity({
        userId,
        canonicalDisplayName: row.display_name,
        override: row.display_name_override,
        source,
      });
    });

  return {
    resolveByTailnetIp,
    resolveByRequestIp,
    setDisplayNameOverride,
  } satisfies UserIdentityShape;
});

export const UserIdentityLive = Layer.effect(UserIdentityService, makeUserIdentity);
