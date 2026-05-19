# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Language

- All product copy, UI strings, comments, logs, and identifiers stay in English. No translation/localization for now — write everything in English even if the user prompts in another language.

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Fork Context: Campfire

This repo is **campfire**, a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (tracked as the `upstream` remote; `origin` is `EvolveArt/campfire`). The fork exists to enable **peer-prompting**: a team-wide collaborative agentic coding workflow.

### Deployment Topology

- **One host machine** — a shared Mac mini in the office runs a single T3 Code backend, exposed over the team's tailnet via `tailscale serve` (see `REMOTE.md` → "Tailscale Endpoints" and `t3 serve --tailscale-serve`).
- **Many client machines** — every teammate connects from their own laptop using the standard pairing flow (`REMOTE.md` → "How Pairing Works"). Each teammate gets a paired session against the same backend.
- Everyone therefore shares the same projects, file system, git state, terminals, and provider sessions on the Mac mini. The "remote" in `REMOTE.md` is the _normal_ mode of operation here, not an edge case.

### What "Peer-Prompting" Means Here

Multiple humans + their agents operate against the same backend concurrently. When designing or changing features, assume:

- Multiple simultaneous paired sessions on a single backend (no "single-user" shortcuts).
- Shared mutable state (threads, files, terminals, provider sessions) that several humans may touch in the same minute.
- Concurrency, attribution, and visibility into "who/what is doing what" matter more than they would in a typical single-user desktop app.
- Performance/reliability priorities from the section above apply _per host_ serving the whole team, not per user.

When in doubt about a UX or protocol decision, ask: "does this still make sense when 4 teammates and their agents are all paired into this same backend at once?"

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Codex App Server (Important)

T3 Code is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
