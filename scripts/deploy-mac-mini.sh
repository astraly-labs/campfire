#!/usr/bin/env bash
# Deploy the latest pushed campfire/v0 to the Mac mini and restart the
# dev server bound to the Tailscale Serve HTTPS endpoints.
#
# Workflow:
#   1. git fetch + git pull --ff-only on the remote checkout
#   2. bun install (only if package.json or lockfile changed)
#   3. Kill any running dev server (ports 5733 / 13773)
#   4. Restart with VITE_HTTP_URL / VITE_WS_URL / T3CODE_CORS_ORIGIN wired
#      to the tailscale-serve HTTPS endpoints
#   5. Print the pairing URL (rewritten to the public hostname)
#
# Env overrides:
#   MACMINI_HOST                ssh alias                       (default: macmini)
#   MACMINI_REPO_PATH           remote path                     (default: agent-host/repos/campfire)
#   MACMINI_BUN                 remote bun binary               (default: /opt/homebrew/bin/bun)
#   MACMINI_TAILSCALE           remote tailscale binary
#   CAMPFIRE_TAILNET_HOSTNAME   MagicDNS hostname               (default: jeffs-mac-mini.tail289246.ts.net)
#   CAMPFIRE_WEB_HTTPS_PORT     tailscale-serve port for web    (default: 8443)
#   CAMPFIRE_BACKEND_HTTPS_PORT tailscale-serve port for backend(default: 8444)
#   CAMPFIRE_BRANCH             remote branch to deploy         (default: campfire/v0)
#   VITE_REALTIME_DEBUG         1 to enable [🚨 Realtime] console logging (default: off)

set -euo pipefail

HOST="${MACMINI_HOST:-macmini}"
REPO_PATH="${MACMINI_REPO_PATH:-agent-host/repos/campfire}"
BUN_BIN="${MACMINI_BUN:-/opt/homebrew/bin/bun}"
BRANCH="${CAMPFIRE_BRANCH:-campfire/v0}"
TAILNET_HOST="${CAMPFIRE_TAILNET_HOSTNAME:-jeffs-mac-mini.tail289246.ts.net}"
WEB_PORT="${CAMPFIRE_WEB_HTTPS_PORT:-8443}"
BACKEND_PORT="${CAMPFIRE_BACKEND_HTTPS_PORT:-8444}"

WEB_URL="https://${TAILNET_HOST}:${WEB_PORT}"
BACKEND_HTTPS="https://${TAILNET_HOST}:${BACKEND_PORT}"
BACKEND_WSS="wss://${TAILNET_HOST}:${BACKEND_PORT}"

color() { printf "\033[%sm%s\033[0m" "$1" "$2"; }
step() { printf "%s %s\n" "$(color "1;36" "→")" "$1"; }
ok()   { printf "%s %s\n" "$(color "1;32" "✓")" "$1"; }
warn() { printf "%s %s\n" "$(color "1;33" "!")" "$1"; }
fail() { printf "%s %s\n" "$(color "1;31" "✗")" "$1" >&2; exit 1; }

if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "${HOST}" "test -d ${REPO_PATH}/.git" 2>/dev/null; then
  fail "${HOST}:${REPO_PATH} has no .git. Bootstrap once with:
    ssh ${HOST} 'mv ${REPO_PATH} ${REPO_PATH}.bak-\$(date +%Y%m%d) && cd \$(dirname ${REPO_PATH}) && git clone --branch ${BRANCH} https://github.com/EvolveArt/campfire.git \$(basename ${REPO_PATH}) && cd ${REPO_PATH} && ${BUN_BIN} install'"
fi

step "Pulling latest ${BRANCH} on ${HOST}:${REPO_PATH}"
remote_log=$(ssh "${HOST}" "cd ${REPO_PATH} && git fetch origin --tags --quiet && git checkout ${BRANCH} 2>/dev/null && git pull --ff-only origin ${BRANCH} 2>&1")
echo "${remote_log}" | sed 's/^/    /'

if echo "${remote_log}" | grep -qE "Updating|Fast-forward"; then
  step "package.json or lockfile changed → running bun install"
  ssh "${HOST}" "cd ${REPO_PATH} && ${BUN_BIN} install 2>&1 | tail -3" | sed 's/^/    /'
else
  ok "Already up to date — skipping bun install"
fi

step "Stopping any running dev server (ports 5733 / 13773)"
# Two-phase shutdown: SIGTERM the port-holders so they can flush/close cleanly,
# then SIGKILL any straggler that ignored SIGTERM (the Effect-runtime backend
# has been observed to take many minutes to honor SIGTERM, leaving a multi-GB
# zombie alongside the freshly started replacement and doubling memory use).
ssh "${HOST}" 'lsof -iTCP -sTCP:LISTEN -P 2>/dev/null | awk "/(:5733|:13773)/{print \$2}" | sort -u | xargs -I {} kill {} 2>/dev/null || true'
sleep 5
ssh "${HOST}" '
  pgrep -fl "node --watch src/bin.ts|apps/web/node_modules/.bin/vite --host|scripts/dev-runner.ts" \
    | awk "{print \$1}" | xargs -I {} kill -9 {} 2>/dev/null || true
'
sleep 1

# Maintenance window: the dev runner is down so the SQLite store is uncontended
# and the runtime log writer has released its handles. Cheap, safe to skip on
# failure — we never let maintenance block the restart.
step "Maintenance: rotate logs > 100 MB + PRAGMA optimize on state.sqlite"
ssh "${HOST}" '
  log_dir="$HOME/.t3/dev/logs"
  if [ -d "$log_dir" ]; then
    total_kb=$(du -sk "$log_dir" 2>/dev/null | awk "{print \$1}")
    if [ "${total_kb:-0}" -gt 102400 ]; then
      archive="$log_dir.archive-$(date +%Y%m%d-%H%M%S)"
      mv "$log_dir" "$archive" && mkdir -p "$log_dir" \
        && echo "    rotated logs to $(basename "$archive") (${total_kb} KB)"
    else
      echo "    logs dir ${total_kb:-0} KB — no rotation"
    fi
  fi
  db="$HOME/.t3/dev/state.sqlite"
  if [ -s "$db" ] && command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$db" "PRAGMA optimize;" 2>&1 | sed "s/^/    sqlite: /" || true
    echo "    PRAGMA optimize done ($(du -sh "$db" | awk "{print \$1}"))"
  fi
' || true

step "Starting dev server with HTTPS env wired"
REALTIME_DEBUG="${VITE_REALTIME_DEBUG:-}"
if [[ -n "${REALTIME_DEBUG}" ]]; then
  step "Realtime debug logging enabled (VITE_REALTIME_DEBUG=${REALTIME_DEBUG})"
fi
ssh "${HOST}" "cd ${REPO_PATH} && rm -f /tmp/campfire-mac.log && \
  if [ -f \$HOME/.campfire.env ]; then set -a; . \$HOME/.campfire.env; set +a; fi && \
  nohup env \
  VITE_HTTP_URL='${BACKEND_HTTPS}' \
  VITE_WS_URL='${BACKEND_WSS}' \
  VITE_REALTIME_DEBUG='${REALTIME_DEBUG}' \
  T3CODE_CORS_ORIGIN='${WEB_URL}' \
  ${BUN_BIN} run dev > /tmp/campfire-mac.log 2>&1 < /dev/null &"

step "Waiting for backend (timeout 30s)"
ready=""
for _ in $(seq 1 30); do
  if curl -sf -m 3 "${BACKEND_HTTPS}/api/auth/session" > /dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ -z "${ready}" ]] && fail "Backend never came up — tail /tmp/campfire-mac.log on ${HOST}"
ok "Backend ready at ${BACKEND_HTTPS}"

step "Extracting pairing token"
sleep 2  # leave a moment for the auth-required banner to land
token=$(ssh "${HOST}" "grep -oE 'pair#token=[A-Z0-9]+' /tmp/campfire-mac.log | head -1 | cut -d= -f2" || true)
if [[ -z "${token}" ]]; then
  warn "No pairing token printed yet. Tail the log:  ssh ${HOST} 'tail -30 /tmp/campfire-mac.log'"
  exit 0
fi
pairing_url="${WEB_URL}/pair#token=${token}"
echo ""
ok "Pairing URL: ${pairing_url}"
if command -v pbcopy >/dev/null 2>&1; then
  printf "%s" "${pairing_url}" | pbcopy
  echo "    (copied to clipboard)"
fi
echo ""
echo "    Web:     ${WEB_URL}"
echo "    Backend: ${BACKEND_HTTPS}"
echo "    Log:     ssh ${HOST} 'tail -f /tmp/campfire-mac.log'"
