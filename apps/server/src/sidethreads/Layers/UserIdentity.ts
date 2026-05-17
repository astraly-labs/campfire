/**
 * UserIdentity live — `tailscale whois <ip> --json` backed.
 *
 * Caches resolved peer → UserRef tuples for `CACHE_TTL_MS` to avoid invoking
 * the CLI on every WS frame. On a cache miss it spawns the CLI, parses the
 * JSON output, and upserts `users` + `user_devices` rows. The cache is
 * process-local — restarting the daemon repopulates it lazily.
 *
 * Identity model: the tailnet login name (e.g. `alice@pragma.build`) is the
 * stable `UserId`. The Node ID returned by `tailscale whois` identifies the
 * device on which the peer is currently connected.
 *
 * @module UserIdentityLive
 */
import type { UserId, UserRef } from "@t3tools/contracts";
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
import { UserIdentityService, type UserIdentityShape } from "../Services/UserIdentity.ts";

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
  readonly userRef: UserRef;
  readonly nodeId: number;
  readonly expiresAtMs: number;
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

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

  const upsertUserAndDevice = (params: {
    readonly userId: UserId;
    readonly displayName: string;
    readonly tailnetName: string;
    readonly nodeId: number;
  }) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      yield* sql`
        INSERT INTO users (user_id, display_name, created_at, updated_at)
        VALUES (${params.userId}, ${params.displayName}, ${now}, ${now})
        ON CONFLICT(user_id) DO UPDATE SET
          display_name = excluded.display_name,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError(toPersistenceSqlError("UserIdentity.upsertUser")));

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

  const resolveByTailnetIp: UserIdentityShape["resolveByTailnetIp"] = (tailnetIp) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const cached = cache.get(tailnetIp);
      if (cached && cached.expiresAtMs > nowMs) {
        return cached.userRef;
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
      const userRef: UserRef = {
        id: userId,
        displayName: parsed.UserProfile.DisplayName,
      };

      yield* upsertUserAndDevice({
        userId,
        displayName: parsed.UserProfile.DisplayName,
        tailnetName: parsed.UserProfile.LoginName,
        nodeId: parsed.Node.ID,
      });

      cache.set(tailnetIp, {
        userRef,
        nodeId: parsed.Node.ID,
        expiresAtMs: nowMs + CACHE_TTL_MS,
      });
      return userRef;
    }) satisfies Effect.Effect<UserRef, UserIdentityError>;

  return { resolveByTailnetIp } satisfies UserIdentityShape;
});

export const UserIdentityLive = Layer.effect(UserIdentityService, makeUserIdentity);
