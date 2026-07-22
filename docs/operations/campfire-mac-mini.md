# Campfire Mac mini Runbook

This is the production path for a trusted team of at most five people. The Mac mini owns every
Codex process, worktree, terminal, event log, and secret. Browsers are replaceable views.

## Production invariants

- Bind Campfire only to `127.0.0.1`; expose it through Tailscale Serve, never a LAN address or
  Funnel.
- Require both Tailnet reachability and a Google OIDC session whose verified email is allowlisted.
- Treat every authenticated teammate as root-equivalent inside Campfire. There is attribution and
  revocation, but deliberately no granular RBAC.
- Use one worktree per task by default. Shared-workspace tasks are an explicit exception and can
  collide at the filesystem/process level.
- The server, not any browser, owns provider processes. Closing all browsers must not stop a turn.
- Back up before every binary change or migration. Promote a new release only after the staging
  port passes the five-client gate.

Tailscale documents that Serve strips incoming identity headers before adding its own, and advises
localhost-only backends when those headers influence identity. Campfire enforces that same trust
boundary. Google requires a web OAuth client and an exact authorized HTTPS redirect URI.

Official references:

- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [Google web-server OAuth client](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
- [Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)

## Host preparation

1. Create a dedicated non-admin macOS account named `campfire`. Enable FileVault and automatic
   security updates. Do not run this service from a personal admin account.
2. Install Tailscale, join the intended tailnet, enable MagicDNS/HTTPS, and restrict access to this
   Mac in the tailnet policy to the five team identities/devices.
3. Install the exact Node version required by the repository (`24.13.x`) and pnpm through Corepack.
4. Keep releases immutable:

   ```text
   /Users/campfire/services/campfire/releases/<git-commit>/
   /Users/campfire/services/campfire/current -> releases/<git-commit>
   /Users/campfire/Library/Application Support/Campfire/
   /Users/campfire/.config/campfire/server.env
   ```

5. Build each release before switching `current`:

   ```bash
   corepack pnpm install --frozen-lockfile
   corepack pnpm build
   corepack pnpm test
   corepack pnpm lint
   corepack pnpm typecheck
   ```

## Google OIDC setup

In Google Cloud Console, create an OAuth client of type **Web application**. Configure the consent
screen and add the exact callback URI:

```text
https://<mac-mini-magicdns>.<tailnet>.ts.net/auth/google/callback
```

For a non-disruptive staging gate, also add a free secondary Serve port URI. The examples use
port `10000`; check `tailscale serve status` first and never replace an existing handler:

```text
https://<mac-mini-magicdns>.<tailnet>.ts.net:10000/auth/google/callback
```

The scheme, host, port, path, case, and trailing slash must match exactly. Campfire requests only
`openid profile email`, verifies issuer/signature/audience/nonce, requires `email_verified`, and
then applies the explicit email allowlist. It never persists Google's access or refresh token.

Create `/Users/campfire/.config/campfire/server.env`, owned by `campfire` and mode `0600`:

```bash
CAMPFIRE_RELEASE='/Users/campfire/services/campfire/current'
CAMPFIRE_NODE='/absolute/path/to/node-24.13.x'
T3CODE_HOME='/Users/campfire/Library/Application Support/Campfire'
T3CODE_PORT='3773'
T3CODE_TAILSCALE_SERVE_PORT='443'
T3CODE_GOOGLE_OIDC_CLIENT_ID='...apps.googleusercontent.com'
T3CODE_GOOGLE_OIDC_CLIENT_SECRET='...'
T3CODE_GOOGLE_OIDC_REDIRECT_URI='https://<magicdns>/auth/google/callback'
T3CODE_GOOGLE_OIDC_ALLOWED_EMAILS='alice@example.com,bob@example.com,...'
T3CODE_OTLP_SERVICE_NAME='campfire-mac-mini'
# Recommended when an OTLP collector is reachable on the tailnet:
# T3CODE_OTLP_TRACES_URL='http://127.0.0.1:4318/v1/traces'
# T3CODE_OTLP_METRICS_URL='http://127.0.0.1:4318/v1/metrics'
```

Never put this file, its backup, or the client secret in Git, Telegram, traces, or shell history.

## Staging without replacing production

Before the first promotion and before every risky upgrade:

1. Back up production.
2. Run the candidate from its immutable release directory with a separate base directory, backend
   port `3774`, and a free Serve HTTPS port (`10000` in these examples).
3. Set the staging Google redirect URI to the exact `:10000` callback.
4. Verify locally:

   ```bash
   curl --fail --silent http://127.0.0.1:3774/healthz
   curl --fail --silent http://127.0.0.1:3774/readyz
   tailscale serve status
   ```

5. Sign in as every allowlisted Google user and complete the acceptance gate below. Do not point
   port 443 or the `current` symlink at the candidate until it passes.

## Five-client acceptance gate

The deterministic suite must pass first. It opens five distinct Google sessions and WebSockets,
creates five worktrees concurrently, verifies server-derived attribution and unique paths, and
requires local p95 command acknowledgement below 500 ms. A second zero-browser fixture starts five
independent Codex provider sessions from five worktree paths without any WebSocket subscriber.

On staging, repeat with real Codex for at least 60 minutes:

1. Five teammates each open a different worktree task and start a harmless long-running Codex turn.
2. Confirm `thread.create → thread.meta.update → thread.turn.start` acknowledgement p95 is below
   500 ms locally and below 1,000 ms from the slowest client. No command may disappear or execute
   twice.
3. Disconnect one client during streaming, reconnect from its last cursor, and verify every event
   sequence is strictly increasing with no duplicate message IDs.
4. Throttle one client or suspend its tab. The other four tasks must stay responsive; the slow
   subscription may fail and resync, but it must not block a producer.
5. Close every browser for five minutes. Verify the five Codex processes and turns continue, then
   reopen and recover their current snapshots.
6. Watch RSS, heap, process-tree RSS/CPU/count, event-loop lag, active WebSockets, command queue
   depth/rejections, resume outcomes, subscription overflows, provider turn latency, and retry/drop
   counters. Memory must reach a steady bound; queue depth must return to zero.
7. Revoke one Google session from the session inventory. Its next HTTP/WebSocket operation must be
   rejected without interrupting already server-owned work for other users.

Record the release commit, client/network locations, p50/p95/p99, maximum queue depth, maximum RSS,
maximum event-loop lag, reconnect result, and any trace IDs in the reliability ledger.

## launchd installation and promotion

Copy `ops/macos/com.campfire.server.plist.example` to
`~/Library/LaunchAgents/com.campfire.server.plist`, replace the example paths, create the log
directory, validate the plist, then load it as the `campfire` user:

```bash
plutil -lint ~/Library/LaunchAgents/com.campfire.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.campfire.server.plist
launchctl kickstart -k gui/$(id -u)/com.campfire.server
```

Promotion is an atomic symlink change followed by a service restart. Keep the previous release and
backup until the new release has completed a full soak.

## Health and diagnosis

- `GET /healthz` proves the HTTP process is alive.
- `GET /readyz` returns 200 only after command startup and a projection database query succeed.
- `server.trace.ndjson` is the local trace source of truth.
- Process/resource history is available through the authenticated diagnostics RPC.
- OTLP metrics include `t3_websocket_connections_active`,
  `t3_orchestration_command_queue_depth`, `t3_orchestration_resume_attempts_total`,
  `t3_orchestration_subscription_overflows_total`, `t3_server_event_loop_lag_millis`,
  `t3_server_rss_bytes`, `t3_server_heap_used_bytes`, and the `t3_process_tree_*` gauges.

Alert initially on readiness failure, event-loop lag over 250 ms for three samples, command queue
depth over 128 for 30 seconds, any queue rejection, repeated subscription overflows, or sustained
RSS growth across a 60-minute window. Tune only from recorded soaks.

## Backup, rollback, and recovery

Run the bundled backup as the service user:

```bash
./ops/macos/campfire-backup.sh \
  '/Users/campfire/Library/Application Support/Campfire' \
  '/Volumes/EncryptedBackups/Campfire'
```

It uses SQLite's online backup API, copies non-log runtime state and worktrees, verifies the copied
database, and creates a mode-0600 archive. Project roots outside `T3CODE_HOME` must also be covered
by encrypted Time Machine/APFS snapshots. Test restoring backups quarterly on a different base
directory.

For an application rollback:

1. Stop launchd and preserve the failed release's base directory; never restore over live data.
2. Point `current` to the previous immutable release.
3. If that binary was verified against the migrated database, restart it directly. Otherwise,
   extract the pre-upgrade archive into a new base directory and change `T3CODE_HOME` to that path.
4. Run `PRAGMA integrity_check`, start on the isolated staging Serve port, check `/readyz`, then
   promote.
5. Reconcile any worktree commits made after the backup with Git. Do not blindly replace project
   roots or active worktrees.

## Security reality for a trusted-superadmin team

Google plus Tailscale significantly reduces opportunistic exposure; it does not sandbox teammates
or agents. Any authenticated teammate can intentionally or accidentally run arbitrary commands,
read every project and secret available to the service account, alter Git history, or exfiltrate
data. Repository instructions and tool output can also prompt-inject an agent into doing the same.

Primary residual risks and controls:

- **Google/tailnet account or device compromise:** require MFA/passkeys, short device approval,
  explicit five-email allowlists, Tailnet ACLs, and immediate session/device revocation.
- **Header spoofing/direct bypass:** backend stays on loopback; never use `0.0.0.0`, raw Tailnet IP
  exposure, LAN forwarding, or Funnel. Treat another local process on the Mac as trusted.
- **Session theft/CSRF/origin abuse:** retain HttpOnly/Secure/SameSite cookies, exact origin checks,
  OIDC state/nonce/PKCE, and session inventory/revocation.
- **Agent or dependency compromise:** use a dedicated macOS account, review MCPs/hooks/skills,
  minimize ambient credentials, pin releases, and inspect provider/tool traces.
- **Secret leakage:** mode-0600 env/backups, FileVault, encrypted off-host backups, log redaction,
  and no secrets in prompts, repository files, screenshots, or chat.
- **Shared-workspace collisions:** worktrees remain default. A shared workspace is opt-in and has no
  concurrency safety guarantee.
- **Resource exhaustion:** bounded queues/replay/live buffers, five-client admission expectation,
  resource metrics, and launchd restart. A malicious superadmin can still deliberately exhaust the
  host.
