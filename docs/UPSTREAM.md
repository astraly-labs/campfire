# Upstream policy

Campfire is a thin fork of [T3 Code](https://github.com/pingdotgg/t3code). `upstream/main` is the architectural source of truth; Campfire carries only its trusted-team collaboration layer and the smallest operational changes needed to support it.

## Rules

- Preserve upstream package names, file layout, contracts, and documentation when they still describe Campfire.
- Put Campfire behavior at existing adapter and configuration boundaries instead of forking whole subsystems.
- Send generic fixes upstream when practical. Drop local patches once their upstream equivalent lands.
- Avoid mass rebranding, formatting-only churn, speculative abstractions, and dependency additions without a measured need.
- Keep one concern per commit or pull request and classify it as `campfire-only`, `upstreamable`, or `temporary-carry`.
- Sync before every Campfire release. Never rewrite release tags.

## Sync workflow

Start from a clean `staging` branch and perform the rebase on a review branch:

```bash
git fetch origin --prune
git fetch upstream main --prune
git switch staging
git pull --ff-only origin staging
git switch -c sync/upstream-YYYY-MM-DD
git rebase upstream/main
```

Resolve conflicts in favor of upstream unless Campfire still requires the difference. Review the rebased commit series with `git range-diff`, run focused checks for every touched surface, and record the upstream SHA in the sync change and release notes.

Updating the shared integration branch after a rebase rewrites its history. Announce the sync window, use `--force-with-lease` rather than `--force`, and require contributors to rebase open branches afterward. Package and deploy only after the rebased `staging` branch passes its release gates.

## 2026-10-13: orchestration V2

This sync starts from official T3 Code commit `98a6246d07624432a6e6d0ab4fb87bede90a49a6`.
The previous staging tip was `4ee4f93c00ac6315589c98d1dbd4a8f245afca32`; its original
commit history is retained in `codex/backup-staging-2026-10-13`. The old fork commits
were consolidated before the port because upstream removed the V1 engine and client reducer.

Campfire collaboration now uses V2 commands, events and projections. The upstream
`createdBy` actor enum remains unchanged; `collaborationCreatedBy` carries the authenticated
Google identity. Team discussions have their own projection, so provider updates do not copy
the discussion history. The importer preserves existing messages, authors, reactions, read
markers, archived discussions, project review defaults and review thread kinds.

Campfire migration IDs 1–50 keep their original meaning. Upstream migrations after 44
continue at 51–67, and migration 68 adds the collaboration projection. Do not renumber these
to match a stock T3 database. Back up the database before the first V2 deployment; rolling
back to V1 requires the matching pre-upgrade backup.

The provider host uses protocol 2 and retains V2 runtimes across backend restarts. The old
V1 host protocol is incompatible. For the first deployment, let existing turns finish,
then replace the backend and provider host together. Private briefing runtimes are ephemeral
and are excluded from durable recovery. A Git sync does not perform this deployment.

Host acknowledgements confirm local event ingestion, followed by at least 30 seconds of
replay retention. They are not SQLite commit receipts; this does not guarantee lossless
recovery if ingestion stalls beyond that grace period and the backend then crashes.

The deterministic multiplayer smoke now runs the V2 worker/replay test. It uses a fake
provider runtime with real SQLite and orchestration workers; it does not prove Google login,
browser rendering, a live provider CLI or the required human promotion gate. Command admission
is bounded at the existing external RPC/HTTP gate; direct MCP commands bypass that gate.
