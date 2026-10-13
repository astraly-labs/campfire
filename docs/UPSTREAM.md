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
