# campfire — Architecture & deployment

> Internal Pragma fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Adds
> Slack-style side-threads anchored to agent messages so two teammates can peer-prompt
> a Claude Code / Codex session on a shared remote machine without polluting the agent's context.

This document describes **how the pieces fit together**: which process runs where, how
network traffic flows, why we use Tailscale Serve, and what the dev/release workflow
looks like.

---

## 1. Mental model in one paragraph

Two humans (Matthias, Matteo) each run a thin client (browser or desktop app) on
their MacBook. The thin client talks WebSocket + HTTP to a **single shared backend**
that runs on a Mac mini sitting on the Pragma Tailscale tailnet. The backend hosts
the agent processes (Claude Code / Codex), the SQLite event store, and the file
worktrees the agents edit. Because both humans connect to the _same_ backend, they
see the same threads in real time (broadcasts via PubSub) and can comment in
side-threads anchored to specific agent messages.

```
┌─────────────────┐                        ┌─────────────────┐
│ Matthias laptop │ ◀── tailnet (tailscale) ──▶ │ Matteo laptop   │
│   browser /     │                        │   browser /     │
│   desktop app   │                        │   desktop app   │
└────────┬────────┘                        └────────┬────────┘
         │                                          │
         │           HTTPS (Tailscale Serve)        │
         └────────────────┬─────────────────────────┘
                          ▼
                ┌─────────────────────┐
                │   Mac mini          │   100.110.28.83
                │   jeffs-mac-mini    │   jeffs-mac-mini.tail289246.ts.net
                │                     │
                │   Tailscale Serve   │   :8443 → 127.0.0.1:5733  (web)
                │                     │   :8444 → 127.0.0.1:13773 (backend)
                │                     │
                │   Bun dev server    │   apps/web  on :5733 (Vite)
                │                     │   apps/server on :13773 (HTTP + WS)
                │                     │
                │   Claude Code / Codex│   spawned per-thread by the backend
                │                     │
                │   ~/.t3/dev/state.sqlite (event store)
                │   ~/agent-host/repos/ (source)
                │   ~/agent-host/worktrees/<thread-id>/ (per-thread checkouts)
                └─────────────────────┘
```

---

## 2. Network layers

### 2.1 Tailnet (Tailscale)

A private VPN mesh between devices. Members of the `EvolveArt` tailnet get a
stable `100.x.x.x` IP and an HTTPS-able MagicDNS hostname:

```
matthias laptop  → 100.70.148.102  macbook-pro-de-0xevolve
matteo laptop    → 100.113.214.61  matteos-macbook-pro
mac mini         → 100.110.28.83   jeffs-mac-mini.tail289246.ts.net
```

The tailnet is the _only_ network path between the laptops and the Mac mini. No
public internet exposure, no firewall rules to maintain.

### 2.2 Tailscale Serve (the HTTPS proxy on the Mac mini)

**Why we need it**: the dev backend binds to `127.0.0.1:13773` for safety and
because that's where the loopback proxy in Vite expects it. Browsers reject
several APIs (clipboard, service workers, mixed-content) when the page is loaded
over plain HTTP outside of `localhost`. We need a TLS terminator that:

1. accepts HTTPS connections from tailnet peers,
2. holds a valid certificate (no "your connection is not private" prompts),
3. proxies plaintext to the backend on `127.0.0.1`.

Tailscale Serve does all three, gratis, with certificates auto-issued for the
MagicDNS hostname. Setup is two commands on the Mac mini:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:5733  # web (Vite)
tailscale serve --bg --https=8444 http://127.0.0.1:13773 # backend (HTTP + WS)
```

Yields:

```
https://jeffs-mac-mini.tail289246.ts.net:8443/    → Vite frontend
https://jeffs-mac-mini.tail289246.ts.net:8444/    → backend HTTP + WS
```

Why two ports and not one + Vite proxy? The Vite proxy works in development but
adds an extra hop and we'd need to set `VITE_HTTP_URL` to the same origin as the
page. Two ports keeps the wire layout obvious: one HTTPS endpoint per process.

### 2.3 Why HTTPS at all in dev?

- Browsers gate `navigator.clipboard.writeText` to secure contexts (HTTPS or
  `localhost`). With HTTP-on-tailnet, the "copy error" button is silently a
  no-op (we ship a `document.execCommand("copy")` fallback as a safety net,
  but it's brittle and not the right long-term answer).
- Mixed-content rules: a page served over HTTPS cannot make HTTP requests. If
  we ever wrap the web frontend behind any HTTPS endpoint (Tailscale Serve,
  Cloudflare tunnel, custom reverse-proxy), the backend has to be HTTPS too.
- Service workers, WebTransport, getUserMedia — all gated to secure contexts.

---

## 3. Process topology on the Mac mini

```
PID  Process                              Binds         Role
─────────────────────────────────────────────────────────────────────────
?    Tailscale Serve (HTTPS proxy)        :8443, :8444  TLS termination → loopback
?    bun run dev (turbo umbrella)         —             Spawns the two children below
?    └── apps/server (node --watch)       127.0.0.1:13773   HTTP API + WebSocket RPC
?    └── apps/web (vite)                  127.0.0.1:5733    HMR-enabled web frontend
?    Claude Code / Codex (spawned per thread)              Agent subprocess, talks to apps/server
```

The agents (Claude Code / Codex CLI) are spawned by the backend on demand —
**one process per thread**, with `cwd` set to that thread's git worktree.

---

## 4. Filesystem layout on the Mac mini

```
~/agent-host/
├── repos/                    Source repos shared by all threads
│   ├── campfire/             ← this repo (cloned/rsynced from a teammate's laptop)
│   ├── alpha-engine/         ← teammate's working repo
│   └── ...                   ← one folder per project added in the UI
│
├── worktrees/                One git worktree per agent thread
│   └── <thread-id>/          ← isolated checkout, agent edits files here
│
└── daemon/                   (placeholder for daemon-local state)

~/.t3/dev/state.sqlite        Event store + projections (orchestration & sidethread aggregates)
~/.t3/dev/...                 Runtime state (per-thread caches, attachments, …)
```

Convention: **one worktree per thread**, _not_ per user. Both Matthias and
Matteo prompt against the same worktree because they're collaborating on the
same task. Worktrees decouple parallel threads from each other (no branch
collisions, no "you're on the wrong branch").

> ⚠️ The worktree-per-thread automation is **not yet wired** end-to-end. v0
> threads operate against the repo root. Adding it is a future server-side
> task in `apps/server/src/sidethreads/` or similar.

---

## 5. Code architecture (campfire-specific layers)

The fork extends t3code's CQRS event-sourcing scaffold with a new aggregate
called **SideThread**. We mirror the existing `Orchestration*` modules so
upstream rebases stay clean.

### 5.1 Contracts (`packages/contracts/`)

```
src/user.ts              UserId, UserRef (denormalized into events)
src/sidethread.ts        SideThreadId, anchor, commands, events, RPCs, errors
src/rpc.ts               WsSideThreadDispatchCommandRpc + WsSideThreadSubscribeRpc
                         registered in WsRpcGroup
src/ipc.ts               EnvironmentApi.sideThread wire interface
```

### 5.2 Server aggregate (`apps/server/src/sidethreads/`)

```
readModel.ts             SideThreadReadModel: in-memory state
decider.ts               (cmd, readModel) → planned event (pure)
projector.ts             (event, readModel) → next read model (pure)
Errors.ts                Domain errors + UserIdentity errors
Services/                Tags (Effect Context.Service)
  ├── SideThreadEngine.ts
  ├── SideThreadProjectionPipeline.ts
  └── UserIdentity.ts                ← `tailscale whois` resolver (not wired into ws.ts yet)
Layers/                  Live implementations
  ├── SideThreadEngine.ts            ← dispatch worker fiber + PubSub broadcast
  ├── SideThreadProjectionPipeline.ts ← SQL writes + bootstrap
  └── UserIdentity.ts                ← spawns `tailscale whois --json`, caches 5min, upserts users
runtimeLayer.ts          Composes the SideThread Live layers
```

Plus an EventStore in `apps/server/src/persistence/`:

```
Services/SideThreadEventStore.ts  Tag
Layers/SideThreadEventStore.ts    Live (SQLite append + replay)
Migrations/031_Users.ts           users + user_devices
Migrations/032_SideThreadEvents.ts side_thread_events (event log)
Migrations/033_ProjectionSideThreads.ts projection_side_threads + projection_side_thread_messages
```

The Layer composition gets merged into `RuntimeCoreDependenciesLive` in
`apps/server/src/server.ts`, alongside `OrchestrationLayerLive`.

### 5.3 WebSocket RPC handlers (`apps/server/src/ws.ts`)

Two new handlers:

- `sidethread.dispatchCommand` — delegate to `sideThreadEngine.dispatch`, return
  `{ acceptedAt, events: [] }` (client subscribes to receive the actual event).
- `sidethread.subscribeSideThread` — emit initial snapshot from
  `sideThreadEngine.getSnapshot(id)`, then stream events filtered by
  `event.aggregateId === input.sideThreadId` from `streamDomainEvents` PubSub.

### 5.4 Web client (`apps/web/src/sidethread/`)

```
identity.ts              localStorage prompt for displayName + stable client id
sideThreadStore.ts       zustand store: { anchor, open, close } + deriveSideThreadId
SideThreadAnchorButton.tsx  💬 button injected next to AssistantCopyButton in MessagesTimeline
SideThreadDrawer.tsx     Inline panel, mounted as flex sibling of the chat column
                         in ChatView.tsx (next to PlanSidebar). Same look-and-feel.
```

The drawer:

1. Computes a deterministic `sideThreadId = "st-<threadId>-<messageId>"` so
   both ends converge on the same aggregate without a server-side discovery
   round trip.
2. Optimistically dispatches `sidethread.create` (idempotent in practice — if
   the aggregate exists, the second `create` fails silently and we just
   subscribe).
3. Subscribes; renders snapshot + live events; dispatches `sidethread.message.post`
   on send.

### 5.5 Identity model (v0)

- Client side: `UserRef` is prompted on first post and cached in
  `localStorage` (`campfire.sidethread.userRef.v1`).
- Server side: `UserIdentityService` exists and works (talks `tailscale whois`,
  upserts `users` + `user_devices`) but **isn't wired into `ws.ts` yet**.
  Once wired, the server overrides client-supplied `createdBy/author` with
  the resolved `UserRef` to prevent spoofing.
- v1 step: replace the client prompt with the server-resolved identity in
  the dispatch handler.

---

## 6. Data flow: "Matteo opens a side thread on a message Matthias's agent wrote"

```
1. Browser loads https://jeffs-mac-mini.tail289246.ts.net:8443/
   └── HTML + JS bundled with VITE_HTTP_URL = https://...:8444

2. Bootstrap GET https://...:8444/.well-known/t3/environment
   └── Tailscale Serve :8444 → backend 127.0.0.1:13773
   └── Backend returns env descriptor
   └── Web app marks primary environment ready

3. WS upgrade wss://...:8444/<rpc-endpoint>
   └── Tailscale Serve proxies WS transparent
   └── Backend authenticates session (pairing token)

4. Matteo clicks 💬 on agent message <messageId> in thread <threadId>
   └── setOpenAnchor({ parentThreadId, anchorMessageId })
   └── deriveSideThreadId() = "st-<threadId>-<messageId>"

5. Drawer mounts:
   a. dispatchCommand({ type: "sidethread.create", sideThreadId, anchor, createdBy: matteoRef })
      └── apps/server: decider rejects (already exists in commandReadModel)
          OR accepts; appends event; projector writes SQL; PubSub publish.
   b. subscribeSideThread({ sideThreadId })
      └── Snapshot from sideThreadEngine.getSnapshot() (in-memory map)
      └── Live stream filtered by aggregateId

6. Matthias's drawer (already subscribed):
   └── Receives the live event from PubSub
   └── React state appends the new message

7. Matteo types and sends:
   └── dispatchCommand({ type: "sidethread.message.post", text, author: matteoRef })
   └── Decider validates (sideThread exists, not archived, messageId unique)
   └── Append + project + publish
   └── Both drawers refresh
```

All this happens over the **same WS connection** per client. Multiple subscribers
to the same `sideThreadId` each receive their own copy of the event stream
(PubSub fans out).

---

## 7. Dev workflow

### 7.1 Local-only loop (your own laptop)

```bash
git clone https://github.com/EvolveArt/campfire.git
cd campfire
git checkout campfire/v0
bun install
bun run dev
```

Open the printed pairing URL. Edits in `apps/server/`, `apps/web/`, or
`packages/` hot-reload.

Invariants while editing:

```bash
bun typecheck   # whole monorepo
bun lint        # oxlint
bun fmt         # oxfmt
bun run test    # vitest (never `bun test`)
```

### 7.2 Mac mini loop (POC mode, for peer-prompting)

**Today (manual `rsync`)**: faster iteration because no commit/push round-trip.

```bash
rsync -az \
  --exclude node_modules --exclude .git --exclude .turbo \
  --exclude .next --exclude dist --exclude build --exclude '*.log' \
  --exclude '.t3' --exclude '.claude' \
  ./ macmini:agent-host/repos/campfire/

ssh macmini "cd agent-host/repos/campfire && /opt/homebrew/bin/bun install"

# (re)launch dev server bound to loopback, advertised over HTTPS:
ssh macmini "lsof -iTCP -sTCP:LISTEN -P | grep -E '5733|13773' | awk '{print \$2}' | sort -u | xargs -I {} kill {} 2>/dev/null"
ssh macmini "cd agent-host/repos/campfire && nohup env \
  VITE_HTTP_URL='https://jeffs-mac-mini.tail289246.ts.net:8444' \
  VITE_WS_URL='wss://jeffs-mac-mini.tail289246.ts.net:8444' \
  T3CODE_CORS_ORIGIN='https://jeffs-mac-mini.tail289246.ts.net:8443' \
  /opt/homebrew/bin/bun run dev > /tmp/campfire-mac.log 2>&1 < /dev/null &"
```

**Why `rsync` and not `git pull`?** Because uncommitted local edits don't exist
in any remote yet. In tight POC mode we don't want to push half-baked branches
to GitHub just to deploy them.

**Tomorrow (clean `git pull`)**: once commits land in `origin/campfire/v0`,
the Mac mini deploys via:

```bash
ssh macmini "cd agent-host/repos/campfire && git pull && bun install && <restart>"
```

Same restart command. Or, when we wire it, a tag-triggered GHA can `ssh macmini`
and do this automatically.

### 7.3 Tailscale Serve setup (one-time, persists across reboots)

```bash
ssh macmini '/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8443 http://127.0.0.1:5733'
ssh macmini '/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8444 http://127.0.0.1:13773'
```

Verify:

```bash
ssh macmini '/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status'
```

(Tailscale Serve is an account-level feature; an admin must enable it once on
the tailnet via the Tailscale admin console.)

### 7.4 Pairing teammates

1. Capture the latest token: `ssh macmini "grep pairingUrl /tmp/campfire-mac.log | tail -1"`.
2. The log prints `pairingUrl: http://localhost:5733/pair#token=…`. **Rewrite
   `localhost:5733` → `jeffs-mac-mini.tail289246.ts.net:8443`** before sending.
3. Tokens are _single-use_. Either:
   - Restart the dev server for a fresh token (invalidates current session).
   - Or generate additional links from **Settings → Connections → Create Link**
     in the already-paired client.

---

## 8. Release workflow

### 8.1 Tag-based release (`v*-campfire.*`)

```bash
git checkout campfire/v0
git tag v0.0.24-campfire.1 -m "campfire build 1"
git push origin v0.0.24-campfire.1
```

Triggers `.github/workflows/release-campfire.yml`:

1. Boots `macos-14` (Apple Silicon) runner.
2. `bun install --frozen-lockfile`.
3. `bun run build:desktop` (compiles `apps/server` + `apps/desktop` to a bundle).
4. `bun run dist:desktop:dmg:arm64` with `CSC_IDENTITY_AUTO_DISCOVERY=false`
   (skip signing).
5. Locates the `.dmg` under `release/` and uploads it as both:
   - a workflow-run artifact (30 days), and
   - a GitHub Release asset (permanent, marked prerelease).

The Release is private to the `EvolveArt/campfire` fork. Share the direct
download URL with teammates.

### 8.2 First install on a teammate's Mac

1. Download `T3-Code-<version>-arm64.dmg` from the GitHub Release.
2. Open the DMG, drag the app to `~/Applications/`.
3. **First launch only**: right-click → **Open** → confirm in the Gatekeeper
   dialog (unsigned build). Subsequent launches work normally.
4. In the app, paste a pairing URL or scan a QR code from the Mac mini.

### 8.3 Why unsigned for now

Apple code-signing + notarization removes the right-click step and unlocks
auto-update, but it requires:

- An Apple Developer Account (~$99/yr) tied to Pragma.
- `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`
  GitHub secrets in the fork.
- 5–15 min of notarization runtime in each build.

For a 5-teammate internal dogfood, right-clicking once is acceptable. We defer
signing until the dogfood graduates.

---

## 9. Known caveats / things to fix soon

| Area                  | What's hacky                                                | What clean looks like                                                                                                |
| --------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Identity              | Client localStorage prompt is trustable nowhere.            | Wire `UserIdentityService` (already implemented) into `ws.ts` so the server stamps `UserRef` from `tailscale whois`. |
| Deployment            | `rsync` from a laptop.                                      | `git pull` (or GHA push-to-deploy when we tag).                                                                      |
| Pairing URL           | Log prints `localhost:5733`, share requires manual rewrite. | Use `t3 serve --tailscale-serve` (or env-driven host advertise) so the URL is share-ready.                           |
| Side-thread anchoring | Per-message only.                                           | Per-block (tool call, file diff, plan item) — see grill-me roadmap.                                                  |
| Worktrees             | Threads run against repo root in v0.                        | Auto `git worktree add` per thread on creation.                                                                      |
| Updates               | Teammates re-download `.dmg` manually.                      | Electron auto-updater + `campfire-internal` channel + a tiny update server (Cloudflare R2 / Tailscale Serve / VM).   |
| Notifications         | Browser tab only.                                           | Desktop notifications (already supported by Electron) tied to `@user` mentions.                                      |

---

## 10. Glossary

- **Aggregate** — A consistency boundary in the event-sourcing model. We have
  two: `Orchestration` (project + thread + turn + checkpoint, inherited from
  t3code) and `SideThread` (this fork's addition).
- **Decider** — Pure function `(state, command) → events`. No I/O.
- **Projector** — Pure function `(state, event) → state` (in-memory). The
  _projection pipeline_ mirrors this into SQL for queries.
- **Event store** — Append-only SQLite table per aggregate
  (`orchestration_events`, `side_thread_events`).
- **PubSub** — Effect's in-process publish/subscribe primitive. We broadcast
  saved domain events on it so every WS subscriber gets a copy.
- **MagicDNS** — Tailscale's auto-generated hostname for tailnet members
  (`jeffs-mac-mini.tail289246.ts.net`). Resolvable only inside the tailnet.
- **Tailscale Serve** — Built-in HTTPS reverse proxy with auto-issued certs.
  Tailnet-only (use `tailscale funnel` to expose publicly).
- **Worktree** — Git's `git worktree`: a secondary checkout sharing the same
  `.git` directory. Lets multiple branches coexist on disk for the same repo.

---

## 11. Pointers

- `DEVELOPMENT.md` — operational runbook (dev/deploy/build/release/troubleshoot).
- `REMOTE.md` — upstream t3code's remote-access doc (LAN, Tailscale, SSH-launched envs).
- `AGENTS.md` — coding conventions (Effect-TS strict, performance/reliability first).
- `~/.claude/journal/2026-05.journal.md` — session-by-session decisions log.
