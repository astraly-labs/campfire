# Campfire completion audit

Audit date: 2026-07-22

This audit maps the active Campfire goal to current authoritative evidence. “Proven” means the
current branch has deterministic code/test or runtime evidence. It does not promote the candidate;
the external staging rows remain mandatory.

| Requirement                                | Status                    | Authoritative evidence                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current T3 Code base                       | Proven                    | `git rev-list --left-right --count upstream/main...HEAD` returns `0 15` for the H17 candidate after the latest rebase.                                                                                                                                                             |
| Mac mini owns agents/worktrees             | Proven deterministically  | `ProviderCommandReactor.test.ts` starts five independent Codex worktree turns with zero WebSocket subscribers. Provider session mappings persist and resume across layer restart.                                                                                                  |
| Five concurrent authenticated users        | Proven deterministically  | `server.test.ts` opens five Google sessions/WebSockets, overlaps five worktree creations, verifies five unique paths/subjects/session IDs, and measures acknowledgement latency.                                                                                                   |
| No lost, duplicate, or cross-thread replay | Proven deterministically  | The 1,000-event five-client reconnect fixture checks exact strictly ordered sequences, no duplicates, no leakage, fixed replay bounds, and isolation from one delayed consumer.                                                                                                    |
| Durable/idempotent commands                | Proven                    | SQLite command receipts, serial per-thread scheduling, duplicate-command fixtures, bounded command admission, and durable event replay are covered by orchestration engine tests.                                                                                                  |
| Bounded load and slow-client isolation     | Proven                    | Command mailbox capacity/timeout, one-slot durable wake-up feed, bounded reactor workers, 512-frame thread buffers, 2,048-frame shell buffers, and snapshot fallback above 1,000 events all have focused overflow/recovery tests.                                                  |
| Worktree default and collision model       | Proven                    | Five-client first-send bootstrap produces unique worktrees; the runbook explicitly treats shared workspace as an unsafe opt-in exception.                                                                                                                                          |
| Actionable observability                   | Proven                    | Metrics cover command pressure, authenticated WebSockets, resume decisions, overflow, event-loop lag, server/process-tree resources, provider latency/retry paths, plus `/healthz` and `/readyz`.                                                                                  |
| Google OIDC identity/onboarding            | Proven deterministically  | PKCE, state, nonce, browser binding, issuer/signature/audience, verified email, allowlist, replay denial, stable authorship, session inventory, and revocation are covered by Google and router tests.                                                                             |
| HTTP/WebSocket browser-origin protection   | Proven                    | Shared origin validation accepts same-authority/configured/native clients and rejects malicious-origin browser-cookie reuse through real HTTP and WebSocket router fixtures.                                                                                                       |
| Tailscale identity trust boundary          | Proven deterministically  | Headers are accepted only with Serve enabled, a loopback backend, and a loopback immediate peer; direct forged-header fixtures are rejected.                                                                                                                                       |
| Secret/error/path hardening                | Proven                    | OIDC tokens are not persisted; auth list output, workspace queries, preview URLs, Git failures, and relay activity have redaction fixtures; workspace symlink/root escape and malformed URL/path fixtures preserve structured non-secret failures.                                 |
| Production dependency exposure             | Proven                    | Frozen lockfile install succeeds and `bun run audit:prod` reports no known vulnerabilities after starting from 27 advisories/13 high.                                                                                                                                              |
| Backup/rollback/deployment safety          | Proven locally            | Commit-verified standalone packaging with zero escaping symlinks, fail-closed env/Node/callback/isolation preflight, ShellCheck/plist fixtures, online SQLite backup plus safe fresh-path restore, atomic promotion/rollback, and non-promotable JSONL soak evidence pass locally. |
| Real Google login through Tailscale        | Pending external evidence | The Mac mini has MagicDNS/HTTPS, but the Google OIDC variables are absent. Configure the exact production and `:10000` callback URIs without exposing the client secret in Git/chat.                                                                                               |
| Real five-person 60-minute soak            | Pending external evidence | Requires five allowlisted Google identities and production Codex credentials. Record latency percentiles, maximum queue/RSS/lag, disconnect/replay, zero-browser continuation, and revocation.                                                                                     |
| Promotion and merge to `main`              | Pending external evidence | Existing Serve ports 8443/8444 still point to the old backend and remain untouched. Promote only after the isolated port-10000 gate passes.                                                                                                                                        |

## Current verification commands

```bash
bun fmt
bun lint
bun typecheck
bun run test
bun run build
bun run audit:prod
corepack pnpm install --frozen-lockfile
```

The detailed experiments, thresholds, decisions, and failures are recorded in
`campfire-reliability-feedback-loop.md`; the deployment procedure is in
`campfire-mac-mini.md`.
