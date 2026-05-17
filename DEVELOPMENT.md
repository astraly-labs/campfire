# campfire — dev & release workflow

Internal Pragma fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code), extending it with
side-thread comments anchored to agent messages for collaborative AI engineering.

> ⚠️ This document covers **how to ship campfire to teammates**, not how to use t3code as a user.
> For end-user docs, see the upstream README.

---

## 1. Local development

### Prerequisites
- macOS or Linux (Windows untested for the dev loop)
- [Bun](https://bun.sh) ≥ 1.3.14 (`curl -fsSL https://bun.sh/install | bash`)
- Node ≥ 22 (for the electron-builder + GHA workflows)

### Bootstrap
```bash
git clone https://github.com/EvolveArt/campfire.git
cd campfire
git checkout campfire/v0
bun install
```

### Run dev (server + web)
```bash
# Defaults: server on :13773, web on :5733, backend bound to loopback.
bun run dev
```

Open the pairing URL printed in stdout. The dev loop is hot-reloading; edits to
`apps/server/`, `apps/web/`, or `packages/` take effect on save.

Common variants:
- `bun run dev:server` — only the server, no Vite.
- `bun run dev:web` — only the Vite frontend (proxies to a backend you start separately).
- `T3CODE_PORT_OFFSET=100 bun run dev` — shift ports if you already have a t3code stable running.

### Useful invariants while editing
```bash
bun typecheck   # whole monorepo, ~1 min
bun lint        # oxlint, fast
bun fmt         # oxfmt, fast
bun run test    # vitest (NOT `bun test`)
```

---

## 2. Remote dev on the Mac mini (peer-prompting setup)

The Pragma Mac mini (`jeffs-mac-mini` on the tailnet, IPv4 `100.110.28.83`) hosts the shared
campfire server. Teammates connect from their MacBook via Tailscale.

### 2.1 Deploy code to Mac mini
From your local checkout:
```bash
rsync -az --exclude node_modules --exclude .git --exclude .turbo \
  --exclude .next --exclude dist --exclude build --exclude '*.log' --exclude '.t3' \
  --exclude '.claude' ./ macmini:agent-host/repos/campfire/
ssh macmini "cd agent-host/repos/campfire && /opt/homebrew/bin/bun install"
```

### 2.2 Expose via Tailscale Serve (HTTPS with valid certs)
Tailscale Serve must be enabled once on the tailnet by an admin
(https://login.tailscale.com → Settings → Features → enable Serve).

Then on the Mac mini:
```bash
ssh macmini '/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8443 http://127.0.0.1:5733'
ssh macmini '/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8444 http://127.0.0.1:13773'
```

Yields two stable HTTPS URLs:
- Web: `https://jeffs-mac-mini.<tailnet>.ts.net:8443/`
- Backend: `https://jeffs-mac-mini.<tailnet>.ts.net:8444/`

### 2.3 Start the dev server with the HTTPS endpoints wired
```bash
ssh macmini "lsof -iTCP -sTCP:LISTEN -P | grep -E '5733|13773' | awk '{print \$2}' | sort -u | xargs -I {} kill {}"
ssh macmini "cd agent-host/repos/campfire && \
  nohup env \
    VITE_HTTP_URL='https://jeffs-mac-mini.<tailnet>.ts.net:8444' \
    VITE_WS_URL='wss://jeffs-mac-mini.<tailnet>.ts.net:8444' \
    T3CODE_CORS_ORIGIN='https://jeffs-mac-mini.<tailnet>.ts.net:8443' \
    /opt/homebrew/bin/bun run dev > /tmp/campfire-mac.log 2>&1 < /dev/null &"
ssh macmini "sleep 20 && grep pairingUrl /tmp/campfire-mac.log"
```

The pairing URL prints with `localhost:5733/pair#token=…` — **replace `localhost:5733` by
`jeffs-mac-mini.<tailnet>.ts.net:8443`** when sharing with teammates.

### 2.4 Pair a teammate
1. Send them: `https://jeffs-mac-mini.<tailnet>.ts.net:8443/pair#token=<TOKEN>`
2. They open it in their browser (Tailscale must be up on their device).
3. Pairing tokens are **one-time**. For a second teammate, either restart the dev server
   (generates a fresh token) or, once paired, generate additional links from
   **Settings → Connections → Create Link**.

---

## 3. Building the desktop app

The fork inherits t3code's electron build pipeline. Build locally with:
```bash
bun run dist:desktop:dmg:arm64
# → apps/desktop/dist/T3-Code-<version>-arm64.dmg
```

Other targets:
- `bun run dist:desktop:dmg:x64` — Intel Macs
- `bun run dist:desktop:linux` — AppImage x64
- `bun run dist:desktop:win` — Windows nsis

### Caveats
- **Unsigned**: macOS Gatekeeper will refuse the first launch by default.
  Teammates must right-click the app → **Open** → confirm. Once approved,
  subsequent launches work normally.
- **Universal arm64 + x64 builds** are slower (≈2×) and bigger; default to arm64
  for Apple Silicon teammates.
- **Code signing + notarization** would remove the Gatekeeper friction; requires
  an Apple Developer Account (~$99/yr) and adds `CSC_LINK` + `APPLE_ID` +
  `APPLE_APP_SPECIFIC_PASSWORD` secrets to CI. Defer until painful.

---

## 4. Release workflow

### 4.1 Cut a release tag
Version tags follow `v<base>-campfire.<N>` to coexist with upstream t3code tags:
```bash
git checkout campfire/v0
git tag v0.0.24-campfire.1 -m "campfire build 1"
git push origin v0.0.24-campfire.1
```

Pushing the tag triggers `.github/workflows/release-campfire.yml`:
1. Spins up a macOS arm64 runner (`macos-14`).
2. Runs `bun install`, `bun run build:desktop`, `bun run dist:desktop:dmg:arm64`
   with `CSC_IDENTITY_AUTO_DISCOVERY=false` (skip signing).
3. Uploads the `.dmg` as both a workflow-run artifact (30d) and a GitHub Release
   asset (permanent, marked prerelease).

### 4.2 Manual release dispatch
```
gh workflow run release-campfire.yml -f version=0.0.24-campfire.2
```

### 4.3 Distributing to teammates
The workflow publishes a private GitHub Release on `EvolveArt/campfire`. Share
the direct download URL with teammates. They install once, then receive future
releases by checking the releases page (no auto-update yet — see roadmap).

---

## 5. SideThread architecture (what this fork adds)

The differentiating feature is a Slack-style side-thread anchored to an agent
message. v0 implementation:

- **Contracts** (`packages/contracts/src/sidethread.ts`): aggregate schemas
  (`SideThread`, `SideThreadMessage`, commands, events, RPCs).
- **Server aggregate** (`apps/server/src/sidethreads/`): decider, projector,
  engine layer, event store, projection pipeline. Mirrors the orchestration
  aggregate pattern (Effect-TS CQRS).
- **Migrations 31-33**: `users`, `user_devices`, `side_thread_events`,
  `projection_side_threads`, `projection_side_thread_messages`.
- **WS RPCs**: `sidethread.dispatchCommand`, `sidethread.subscribeSideThread`
  registered in `WsRpcGroup`.
- **Web UI** (`apps/web/src/sidethread/`): inline panel matching the
  `PlanSidebar` style. Bouton 💬 in `MessagesTimeline` opens the drawer
  anchored to that message.
- **Client identity**: prompted on first post, stored in localStorage.
  Server-side `tailscale whois` resolver exists but not wired yet (`apps/server/src/sidethreads/Services/UserIdentity.ts`).

---

## 6. Troubleshooting

### Clipboard / copy buttons not working
Symptom: `navigator.clipboard.writeText` is undefined in non-secure contexts
(HTTP outside loopback). Either:
- Serve via Tailscale Serve HTTPS (recommended, see §2.2), or
- Use the new legacy `execCommand("copy")` fallback we ship in
  `apps/web/src/hooks/useCopyToClipboard.ts`.

### CORS errors when pairing from a Tailscale device
Symptom: `Access-Control-Allow-Origin: *` blocked by browser with `credentials: include`.
Fix: pass `T3CODE_CORS_ORIGIN=https://...:8443` to the dev server env so the
backend echoes the explicit origin + `Allow-Credentials: true`.

### Vite blocks unknown hosts
Symptom: `Blocked request. This host ("xyz.ts.net") is not allowed`.
Fix: `apps/web/vite.config.ts` declares `server.allowedHosts = [".ts.net", "localhost", "127.0.0.1"]`.
Add custom hosts if you serve via a different domain.

### "Failed to switch ref" with truncated error
The toast shows `error: …`. Copy the full message via the copy icon, or
inspect via `git status` in the worktree. Common causes:
- Untracked files would be overwritten → `git stash --include-untracked` first.
- Merge conflict in index → resolve with `git checkout --theirs/ours <path>` + `git add`.

### Backend bound to a hostname instead of loopback
Symptom: Tailscale Serve returns 502 because the backend listens on
`hostname:port` but Serve proxies to `127.0.0.1:port`.
Fix: don't set `T3CODE_HOST` to a remote hostname. Let the backend default to
loopback; Tailscale Serve handles the public-facing TLS termination.

---

## 7. Roadmap (post-V0)

- Wire `UserIdentityService` (`tailscale whois`) into `ws.ts` so commands are
  stamped server-side instead of trusting the client localStorage prompt.
- Auto-update server with `campfire-internal` channel (Cloudflare R2 + Electron
  updater).
- Code signing + notarization (Apple Developer Account).
- `@user` mentions in side-thread composer (autocomplete from paired devices).
- Inbox of unread mentions (per channel + global).
