#!/usr/bin/env bash
# Deploy the latest pushed campfire/v0 to the Mac mini and restart the
# server bound to the Tailscale Serve HTTPS endpoints.
#
# Default mode is a PRODUCTION-STATIC deploy: the web app is built once on
# the mini (vite build, URLs baked) and served by the backend's static
# route with gzip + immutable caching, and tailscale-serve points the web
# port straight at the backend. Remote teammates on slow links get a
# minified, compressed, browser-cached bundle instead of hundreds of
# uncached Vite dev-server module requests per page load.
#
# Workflow:
#   1. git fetch + git pull --ff-only on the remote checkout
#   2. bun install (only if package.json or lockfile changed)
#   3. Kill any running server (ports 5733 / 13773)
#   4. Prod mode: vite build apps/web with VITE_* baked, start the backend
#      only, point tailscale-serve web port at the backend.
#      Dev mode (CAMPFIRE_DEV_MODE=1): legacy behavior — vite dev server +
#      backend, tailscale-serve web port at vite.
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
#   CAMPFIRE_DEV_MODE           1 to serve the web app from the Vite dev
#                               server instead of the built bundle (default: off)
#   VITE_REALTIME_DEBUG         1 to enable [🚨 Realtime] console logging (default: off)

set -euo pipefail

HOST="${MACMINI_HOST:-macmini}"
REPO_PATH="${MACMINI_REPO_PATH:-agent-host/repos/campfire}"
BUN_BIN="${MACMINI_BUN:-/opt/homebrew/bin/bun}"
TAILSCALE_BIN="${MACMINI_TAILSCALE:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}"
BRANCH="${CAMPFIRE_BRANCH:-campfire/v0}"
TAILNET_HOST="${CAMPFIRE_TAILNET_HOSTNAME:-jeffs-mac-mini.tail289246.ts.net}"
WEB_PORT="${CAMPFIRE_WEB_HTTPS_PORT:-8443}"
BACKEND_PORT="${CAMPFIRE_BACKEND_HTTPS_PORT:-8444}"
DEV_MODE="${CAMPFIRE_DEV_MODE:-}"

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
step "Maintenance: rotate logs > 100 MB, drop old archives, PRAGMA optimize"
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
  # Prune old log archives — keep only the 2 most recent so a sequence of
  # deploys does not fill the disk (one ENOSPC incident already produced a
  # zombie backend stuck at 99% CPU with no listening sockets).
  archives=$(ls -1dt "$HOME"/.t3/dev/logs.archive-* 2>/dev/null)
  if [ -n "$archives" ]; then
    keep=2
    pruned=0
    pruned_kb=0
    printf "%s\n" "$archives" | tail -n +$((keep + 1)) | while read -r old; do
      size_kb=$(du -sk "$old" 2>/dev/null | awk "{print \$1}")
      rm -rf "$old" && echo "    pruned $(basename "$old") (${size_kb:-?} KB)"
    done
  fi
  # Surface low free space as a warning so we can act before ENOSPC.
  free_mb=$(df -m "$HOME" 2>/dev/null | awk "NR==2 {print \$4}")
  if [ "${free_mb:-0}" -lt 5120 ]; then
    echo "    !!! WARNING: only ${free_mb} MB free on $HOME — backend may ENOSPC"
  fi
  db="$HOME/.t3/dev/state.sqlite"
  if [ -s "$db" ] && command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$db" "PRAGMA optimize;" 2>&1 | sed "s/^/    sqlite: /" || true
    echo "    PRAGMA optimize done ($(du -sh "$db" | awk "{print \$1}"))"
  fi
' || true

REALTIME_DEBUG="${VITE_REALTIME_DEBUG:-}"
if [[ -n "${REALTIME_DEBUG}" ]]; then
  step "Realtime debug logging enabled (VITE_REALTIME_DEBUG=${REALTIME_DEBUG})"
fi

if [[ -z "${DEV_MODE}" ]]; then
  # Production-static mode: bake the HTTPS endpoints into a one-time vite
  # build. The backend's static route serves apps/web/dist (gzip + immutable
  # caching), so remote page loads cost a couple of cached requests instead
  # of hundreds of uncached dev-server module fetches. Sourcemaps stay on
  # disk but are not referenced (hidden) so browsers never download them.
  step "Building web bundle (vite build, URLs baked, sourcemaps hidden)"
  ssh "${HOST}" "cd ${REPO_PATH} && \
    if [ -f \$HOME/.campfire.env ]; then set -a; . \$HOME/.campfire.env; set +a; fi && \
    env \
    VITE_HTTP_URL='${BACKEND_HTTPS}' \
    VITE_WS_URL='${BACKEND_WSS}' \
    VITE_REALTIME_DEBUG='${REALTIME_DEBUG}' \
    T3CODE_WEB_SOURCEMAP=hidden \
    ${BUN_BIN} run build --filter=@t3tools/web --force 2>&1 | tail -5" | sed 's/^/    /'
  ssh "${HOST}" "test -f ${REPO_PATH}/apps/web/dist/index.html" \
    || fail "vite build did not produce apps/web/dist/index.html"
  ok "Web bundle built at apps/web/dist"

  step "Starting backend (serves the built web bundle)"
  ssh "${HOST}" "cd ${REPO_PATH} && rm -f /tmp/campfire-mac.log && \
    if [ -f \$HOME/.campfire.env ]; then set -a; . \$HOME/.campfire.env; set +a; fi && \
    nohup env \
    VITE_HTTP_URL='${BACKEND_HTTPS}' \
    VITE_WS_URL='${BACKEND_WSS}' \
    VITE_REALTIME_DEBUG='${REALTIME_DEBUG}' \
    T3CODE_CORS_ORIGIN='${WEB_URL}' \
    ${BUN_BIN} run dev:server > /tmp/campfire-mac.log 2>&1 < /dev/null &"

  step "Pointing tailscale-serve web port ${WEB_PORT} at the backend (13773)"
  ssh "${HOST}" "${TAILSCALE_BIN} serve --bg --https=${WEB_PORT} http://127.0.0.1:13773" \
    | sed 's/^/    /' || warn "tailscale serve reconfiguration failed — check manually"
else
  step "Starting dev server with HTTPS env wired (CAMPFIRE_DEV_MODE=1)"
  ssh "${HOST}" "cd ${REPO_PATH} && rm -f /tmp/campfire-mac.log && \
    if [ -f \$HOME/.campfire.env ]; then set -a; . \$HOME/.campfire.env; set +a; fi && \
    nohup env \
    VITE_HTTP_URL='${BACKEND_HTTPS}' \
    VITE_WS_URL='${BACKEND_WSS}' \
    VITE_REALTIME_DEBUG='${REALTIME_DEBUG}' \
    T3CODE_CORS_ORIGIN='${WEB_URL}' \
    ${BUN_BIN} run dev > /tmp/campfire-mac.log 2>&1 < /dev/null &"

  step "Pointing tailscale-serve web port ${WEB_PORT} at the vite dev server (5733)"
  ssh "${HOST}" "${TAILSCALE_BIN} serve --bg --https=${WEB_PORT} http://127.0.0.1:5733" \
    | sed 's/^/    /' || warn "tailscale serve reconfiguration failed — check manually"
fi

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

if [[ -z "${DEV_MODE}" ]]; then
  step "Checking the web bundle is served compressed at ${WEB_URL}"
  web_headers=$(curl -s -m 10 -H "Accept-Encoding: gzip" -D - -o /dev/null "${WEB_URL}/" || true)
  if echo "${web_headers}" | grep -qi "^HTTP/.* 200"; then
    if echo "${web_headers}" | grep -qi "content-encoding: gzip"; then
      ok "Web bundle served with gzip"
    else
      warn "Web URL is up but responses are not gzip-compressed"
    fi
  else
    warn "Web URL did not return 200 — check tailscale serve config (${WEB_URL})"
  fi
fi

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
