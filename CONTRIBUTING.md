# Contributing to Campfire

Campfire is a thin fork of T3 Code. The easiest contribution to maintain is the one we do not need to carry separately.

## Before opening a change

1. Search both Campfire and [T3 Code](https://github.com/pingdotgg/t3code) issues and pull requests.
2. If the change is useful without Campfire's trusted-team collaboration layer, propose it upstream first.
3. Open an issue before non-trivial features or architectural changes.

Small bug, reliability, performance, documentation, and security fixes may go straight to a pull request.

## Pull requests

- Start from `origin/staging`; do not implement directly on `staging`.
- Keep one concern per pull request.
- Preserve upstream names, packages, structure, and behavior unless the change requires otherwise.
- Avoid formatting-only churn, drive-by cleanup, unrelated generated files, and new dependencies without a measured need.
- Explain why the change belongs in Campfire rather than upstream.
- Include focused tests. UI changes need before-and-after screenshots; motion or timing changes need a short video.
- Rebase onto the current Campfire integration branch before review.

Maintainers periodically rebase `staging` onto `upstream/main`, so open contributor branches may need rebasing afterward. Read [the upstream policy](./docs/UPSTREAM.md) for the fork rules and [AGENTS.md](./AGENTS.md) for development and verification guidance.

By contributing, you agree to license your contribution under the repository's MIT License and follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
