# Deploying Campfire to the Team Mac Mini

This document describes how to ship code to the shared backend that the team pairs into.

For the general remote-access / pairing concepts, see [REMOTE.md](./REMOTE.md). For the fork-specific topology, see the **Fork Context: Campfire** section in [AGENTS.md](./AGENTS.md).

## TL;DR

```bash
# 1. Land your changes on origin/campfire/v0
git push origin campfire/v0

# 2. Deploy: pulls on the mac, restarts the dev server, prints a pairing URL
bun run deploy:mac-mini

# 3. Sanity check after deploy
bun run mac-mini:status
```

The deploy script copies the pairing URL to your clipboard. Open it (or paste it to a teammate) to land a new paired session.

## What `deploy:mac-mini` actually does

[`scripts/deploy-mac-mini.sh`](./scripts/deploy-mac-mini.sh):

1. SSH into the mac mini at `agent-host/repos/campfire`.
2. `git fetch origin --tags && git checkout campfire/v0 && git pull --ff-only`.
3. If the pull touched `package.json` / `bun.lock` → `bun install`. Otherwise skip.
4. Kill anything listening on ports `5733` (web) and `13773` (backend).
5. Restart `bun run dev` with HTTPS env wired to the Tailscale Serve endpoints:
   - `VITE_HTTP_URL=https://jeffs-mac-mini.tail289246.ts.net:8444`
   - `VITE_WS_URL=wss://jeffs-mac-mini.tail289246.ts.net:8444`
   - `T3CODE_CORS_ORIGIN=https://jeffs-mac-mini.tail289246.ts.net:8443`
6. Poll the backend `/api/auth/session` for up to 30s.
7. Scrape the new pairing token from `/tmp/campfire-mac.log` and print the pairing URL (also copied to your clipboard via `pbcopy`).

Total downtime for paired teammates: roughly 5–30 seconds while the restart settles. WS clients reconnect automatically once the backend is back.

## What `mac-mini:status` does

[`scripts/mac-mini-status.sh`](./scripts/mac-mini-status.sh) reports:

- Last 3 commits + `git status --short` on the remote checkout
- PIDs listening on the dev ports
- Tailscale Serve config
- Last pairing URL seen in `/tmp/campfire-mac.log`

Use it before deploying to confirm the remote checkout is clean, and after deploying as a sanity check.

## Environment overrides

All overridable via env vars when running the script:

| Variable                      | Default                            | Purpose                           |
| ----------------------------- | ---------------------------------- | --------------------------------- |
| `MACMINI_HOST`                | `macmini`                          | SSH alias in your `~/.ssh/config` |
| `MACMINI_REPO_PATH`           | `agent-host/repos/campfire`        | Remote checkout path              |
| `MACMINI_BUN`                 | `/opt/homebrew/bin/bun`            | Remote `bun` binary               |
| `CAMPFIRE_TAILNET_HOSTNAME`   | `jeffs-mac-mini.tail289246.ts.net` | MagicDNS hostname                 |
| `CAMPFIRE_WEB_HTTPS_PORT`     | `8443`                             | Tailscale Serve port for web      |
| `CAMPFIRE_BACKEND_HTTPS_PORT` | `8444`                             | Tailscale Serve port for backend  |
| `CAMPFIRE_BRANCH`             | `campfire/v0`                      | Branch to deploy                  |

Example deploying a feature branch for a smoke test:

```bash
CAMPFIRE_BRANCH=campfire/my-feature bun run deploy:mac-mini
```

## Runtime secrets — `~/.campfire.env`

Secrets that the dev server needs at runtime (e.g. `VITE_GIPHY_API_KEY` for the GIF picker) live in `~/.campfire.env` **on the mac mini** — never in the repo. The deploy script sources this file (if present) before starting the dev server, so anything `KEY=value` declared there is exported into the env that vite/bun inherits.

Set or update a key:

```bash
ssh macmini 'umask 077 && cat >> ~/.campfire.env <<EOF
VITE_GIPHY_API_KEY=<your-key>
EOF'
```

The file is chmod 600 by convention. The deploy script does not fail if it's missing — features whose keys aren't set will degrade gracefully (e.g. the GIF picker shows an empty state).

To inspect what's currently set:

```bash
ssh macmini 'cat ~/.campfire.env'
```

## Bootstrap (first-time setup)

If `agent-host/repos/campfire` doesn't yet exist on the mac mini, the deploy script will refuse to run and print the bootstrap command. The gist:

```bash
ssh macmini '
  mv agent-host/repos/campfire agent-host/repos/campfire.bak-$(date +%Y%m%d) 2>/dev/null || true
  cd agent-host/repos &&
  git clone --branch campfire/v0 https://github.com/EvolveArt/campfire.git campfire &&
  cd campfire &&
  /opt/homebrew/bin/bun install
'
```

You'll also need:

- An `~/.ssh/config` alias `macmini` (or `MACMINI_HOST=` override) with key-based auth working in BatchMode.
- Tailscale Serve already configured to proxy `:8443 → 127.0.0.1:5733` and `:8444 → 127.0.0.1:13773`. Verify with `bun run mac-mini:status`.
- Push rights to `origin` (`EvolveArt/campfire`).

## Gotchas

Campfire deploys are unusual because **the mac mini is both the deploy target and the shared dev environment**. A few classes of problem to keep in mind:

### Shared instance side effects

- Every deploy kicks all paired sessions for ~30s. Coordinate on Slack/etc before deploying mid-day.
- WS provider sessions in flight (Claude/Codex/Cursor responding) are dropped — paired teammates will see the turn fail and need to retry.

### Migrations are forward-only

- Migrations under `apps/server/src/persistence/Migrations/` run on every backend startup against the shared SQLite store. There is no down-migration.
- A bad migration that ships to the mac mini can corrupt projection state for the whole team. For schema changes, test locally first against a fresh DB.

### The mac's working tree IS the running server

- The checkout at `agent-host/repos/campfire` is what the dev runner is serving. If a teammate paired into the mac uses an agent to edit files there, those edits **are** edits to the running backend's source — Vite/tsx watch will hot-reload (or crash on partial writes).
- For risky refactors (decider, ws, persistence layers), prefer a separate laptop checkout, not editing via campfire-on-campfire.

### `/tmp/campfire-mac.log` is truncated on each deploy

- The script `rm -f`s the log before restart. If you need post-incident logs, copy them off the mac before deploying again:
  ```bash
  ssh macmini 'cp /tmp/campfire-mac.log /tmp/campfire-mac.log.$(date +%s)'
  ```

### Working-tree dirt on the mac blocks pulls

- If something on the mac dirtied the checkout (an agent editing files, an aborted `bun install`), `git pull --ff-only` will fail and the deploy aborts before restart. Check with `bun run mac-mini:status` and clean up manually:
  ```bash
  ssh macmini 'cd agent-host/repos/campfire && git stash && git status --short'
  ```

### Identity attribution

- Threads, messages, and projects are attributed to the paired client's Tailscale identity (see migrations 036–038). Connecting from the mac's own browser will attribute work to the mac's identity, not yours.

## Troubleshooting

**"Backend never came up — tail /tmp/campfire-mac.log"**

The 30s poll timed out. Tail the log to see what's wrong:

```bash
ssh macmini 'tail -100 /tmp/campfire-mac.log'
```

Common causes: failed migration, port already held by a zombie process, TS compile error from a partially-committed change.

**No pairing token printed**

The backend started but didn't surface a pairing URL yet. Tail the log:

```bash
ssh macmini 'tail -30 /tmp/campfire-mac.log'
```

Or generate a fresh token manually:

```bash
bash scripts/new-pairing-token.sh
```

**Mac checkout is behind / has conflicts**

```bash
ssh macmini 'cd agent-host/repos/campfire && git fetch && git status'
# resolve manually, then re-run deploy
```

## Rollback

Fast path — redeploy a previous commit:

```bash
ssh macmini 'cd agent-host/repos/campfire && git checkout <previous-sha>'
# then restart in-place:
ssh macmini 'lsof -iTCP -sTCP:LISTEN -P | awk "/(:5733|:13773)/{print \$2}" | xargs kill'
ssh macmini 'cd agent-host/repos/campfire && nohup /opt/homebrew/bin/bun run dev > /tmp/campfire-mac.log 2>&1 < /dev/null &'
```

Or push a revert commit on `campfire/v0` and run `bun run deploy:mac-mini` normally — preferred when others need to see the rollback in git history.

For migration corruption: there is no automated rollback. Restore the projection DB from a backup (see [DEVELOPMENT.md](./DEVELOPMENT.md) for the DB path) and redeploy a known-good commit.

## Related

- [REMOTE.md](./REMOTE.md) — remote-access concepts and the pairing flow
- [AGENTS.md](./AGENTS.md) — peer-prompting / multi-user concurrency model
- [DEVELOPMENT.md](./DEVELOPMENT.md) — local dev setup and the dev runner
- [scripts/deploy-mac-mini.sh](./scripts/deploy-mac-mini.sh) — source of truth for the deploy flow
- [scripts/mac-mini-status.sh](./scripts/mac-mini-status.sh) — status helper
- [scripts/new-pairing-token.sh](./scripts/new-pairing-token.sh) — generate a fresh pairing URL without redeploying
