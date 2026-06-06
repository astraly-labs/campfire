#!/bin/bash
# Nightly auto-restart for campfire — installed once on the Mac mini and
# fired by the LaunchAgent `com.t3code.restart` (Library/LaunchAgents/...).
#
# Why: the Effect-runtime backend accumulates RSS over a few days of activity
# until fork() of git subprocesses becomes slow enough to miss WS heartbeats,
# which the team observes as continuous deco/reco. A nightly restart resets
# the heap and keeps the team experience steady. The exact maintenance steps
# mirror `scripts/deploy-mac-mini.sh` so we never drift between the two paths.

set -u
LOG="/tmp/campfire-cron.log"
exec >> "$LOG" 2>&1
echo "==== restart at $(date) ===="

# Two-phase shutdown: SIGTERM port-holders, wait for graceful close, SIGKILL
# any straggler. We have observed the Effect backend taking minutes to honor
# SIGTERM, leaving a multi-GB zombie alongside the freshly started replacement.
lsof -iTCP -sTCP:LISTEN -P 2>/dev/null \
  | awk "/(:5733|:13773)/{print \$2}" | sort -u \
  | xargs -I {} kill {} 2>/dev/null || true
sleep 5
pgrep -fl "node --watch src/bin.ts|apps/web/node_modules/.bin/vite --host|scripts/dev-runner.ts" \
  | awk "{print \$1}" | xargs -I {} kill -9 {} 2>/dev/null || true
sleep 1

# Maintenance window — runner is down, SQLite uncontended, log writer released.
LOG_DIR="$HOME/.t3/dev/logs"
if [ -d "$LOG_DIR" ]; then
  total_kb=$(du -sk "$LOG_DIR" 2>/dev/null | awk "{print \$1}")
  if [ "${total_kb:-0}" -gt 102400 ]; then
    archive="$LOG_DIR.archive-$(date +%Y%m%d-%H%M%S)"
    mv "$LOG_DIR" "$archive" && mkdir -p "$LOG_DIR" \
      && echo "rotated logs to $(basename "$archive") (${total_kb} KB)"
  fi
fi
# Same archive-retention policy as the deploy script (keep most recent 2).
ls -1dt "$HOME"/.t3/dev/logs.archive-* 2>/dev/null | tail -n +3 | while read old; do
  rm -rf "$old" && echo "pruned $(basename "$old")"
done
if [ -s "$HOME/.t3/dev/state.sqlite" ] && command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$HOME/.t3/dev/state.sqlite" "PRAGMA optimize;" 2>&1 || true
fi

# Source runtime secrets (Giphy API key, etc.).
[ -f "$HOME/.campfire.env" ] && set -a && . "$HOME/.campfire.env" && set +a

# Restart with the same env wiring as the deploy script.
cd "$HOME/agent-host/repos/campfire"
rm -f /tmp/campfire-mac.log
nohup env \
  VITE_HTTP_URL="https://jeffs-mac-mini.tail289246.ts.net:8444" \
  VITE_WS_URL="wss://jeffs-mac-mini.tail289246.ts.net:8444" \
  T3CODE_CORS_ORIGIN="https://jeffs-mac-mini.tail289246.ts.net:8443" \
  /opt/homebrew/bin/bun run dev > /tmp/campfire-mac.log 2>&1 < /dev/null &

# Wait until the backend is responding before declaring done — surfaces
# startup crashes in the cron log instead of letting them go unnoticed.
for _ in $(seq 1 30); do
  if curl -sf -m 3 https://jeffs-mac-mini.tail289246.ts.net:8444/api/auth/session >/dev/null 2>&1; then
    echo "backend ready"
    exit 0
  fi
  sleep 1
done
echo "WARN: backend did not respond within 30s — check /tmp/campfire-mac.log"
exit 1
