#!/bin/sh
set -eu

campfire_duration_seconds=${1:-3600}
case "$campfire_duration_seconds" in
  ''|*[!0-9]*)
    echo "duration must be a positive integer number of seconds" >&2
    exit 64
    ;;
esac
if [ "$campfire_duration_seconds" -le 0 ]; then
  echo "duration must be greater than zero" >&2
  exit 64
fi

campfire_repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
campfire_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
campfire_started_epoch=$(date +%s)
campfire_deadline=$((campfire_started_epoch + campfire_duration_seconds))
campfire_runs=0

cd "$campfire_repo_root/apps/server"
while :; do
  corepack pnpm exec vp test run src/server.test.ts \
    -t 'bootstraps five independent worktree turns concurrently for five Google users|reconnects five clients across a 1000-event catch-up without loss or leakage|tracks authenticated websocket connection lifecycle'
  corepack pnpm exec vp test run src/orchestration/Layers/ProviderCommandReactor.test.ts \
    -t 'runs five independent Codex worktree turns with zero browser subscribers'
  campfire_runs=$((campfire_runs + 1))

  campfire_now=$(date +%s)
  if [ "$campfire_now" -ge "$campfire_deadline" ]; then
    break
  fi
done

campfire_finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"status":"passed","startedAt":"%s","finishedAt":"%s","durationSeconds":%s,"runs":%s}\n' \
  "$campfire_started_at" \
  "$campfire_finished_at" \
  "$campfire_duration_seconds" \
  "$campfire_runs"
