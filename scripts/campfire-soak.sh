#!/bin/sh
set -eu
unset CDPATH

campfire_duration_seconds=${1:-3600}
campfire_evidence_file=${2:-}
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
if [ -n "$campfire_evidence_file" ]; then
  case "$campfire_evidence_file" in
    /*) ;;
    *)
      echo "evidence JSONL path must be absolute" >&2
      exit 64
      ;;
  esac
  [ -d "$(dirname "$campfire_evidence_file")" ] || {
    echo "evidence JSONL parent directory does not exist" >&2
    exit 66
  }
fi

campfire_repo_root=$(cd -- "$(dirname -- "$0")/.." && pwd)
campfire_node=${CAMPFIRE_NODE:-}
if [ -z "$campfire_node" ] && [ "$(uname -s)" = "Darwin" ] &&
  [ -x /opt/homebrew/opt/node@24/bin/node ]; then
  campfire_node=/opt/homebrew/opt/node@24/bin/node
fi
campfire_node=${campfire_node:-$(command -v node)}
[ -x "$campfire_node" ] || {
  echo "CAMPFIRE_NODE must point to an executable Node runtime" >&2
  exit 69
}
campfire_vp="$campfire_repo_root/node_modules/vite-plus/bin/vp"
[ -f "$campfire_vp" ] || {
  echo "Vite+ is not installed; run the frozen dependency install first" >&2
  exit 69
}
campfire_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
campfire_started_epoch=$(date +%s)
campfire_deadline=$((campfire_started_epoch + campfire_duration_seconds))
campfire_runs=0
campfire_commit=$(git -C "$campfire_repo_root" rev-parse HEAD)
campfire_node_version=$("$campfire_node" -p 'process.versions.node')
campfire_upstream_behind=null
campfire_upstream_ahead=null
if git -C "$campfire_repo_root" show-ref --verify --quiet refs/remotes/upstream/main; then
  campfire_upstream_counts=$(git -C "$campfire_repo_root" rev-list --left-right --count upstream/main...HEAD)
  campfire_upstream_behind=${campfire_upstream_counts%%[[:space:]]*}
  campfire_upstream_ahead=${campfire_upstream_counts##*[[:space:]]}
fi

cd "$campfire_repo_root/apps/server"
while :; do
  "$campfire_node" "$campfire_vp" test run src/server.test.ts \
    -t 'bootstraps five independent worktree turns concurrently for five Google users|reconnects five clients across a 1000-event catch-up without loss or leakage|tracks authenticated websocket connection lifecycle'
  "$campfire_node" "$campfire_vp" test run src/orchestration/Layers/ProviderCommandReactor.test.ts \
    -t 'runs five independent Codex worktree turns with zero browser subscribers'
  campfire_runs=$((campfire_runs + 1))

  campfire_now=$(date +%s)
  if [ "$campfire_now" -ge "$campfire_deadline" ]; then
    break
  fi
done

campfire_finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
campfire_summary=$(printf '{"type":"campfire.deterministic-soak","status":"passed","humanGateStatus":"pending","eligibleForPromotion":false,"commit":"%s","nodeVersion":"%s","upstreamBehind":%s,"upstreamAhead":%s,"startedAt":"%s","finishedAt":"%s","durationSeconds":%s,"runs":%s}' \
  "$campfire_commit" \
  "$campfire_node_version" \
  "$campfire_upstream_behind" \
  "$campfire_upstream_ahead" \
  "$campfire_started_at" \
  "$campfire_finished_at" \
  "$campfire_duration_seconds" \
  "$campfire_runs")
if [ -n "$campfire_evidence_file" ]; then
  umask 077
  printf '%s\n' "$campfire_summary" >>"$campfire_evidence_file"
fi
printf '%s\n' "$campfire_summary"
