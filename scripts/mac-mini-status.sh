#!/usr/bin/env bash
# Quick status: is the dev server up on the Mac mini, what commit is it on,
# what's the last pairing URL.

set -euo pipefail

HOST="${MACMINI_HOST:-macmini}"
REPO_PATH="${MACMINI_REPO_PATH:-agent-host/repos/campfire}"
TAILNET_HOST="${CAMPFIRE_TAILNET_HOSTNAME:-jeffs-mac-mini.tail289246.ts.net}"
WEB_PORT="${CAMPFIRE_WEB_HTTPS_PORT:-8443}"
BACKEND_PORT="${CAMPFIRE_BACKEND_HTTPS_PORT:-8444}"

printf "Mac mini: %s\n" "${HOST}"
printf "Repo:     %s\n\n" "${REPO_PATH}"

echo "── git ──"
ssh "${HOST}" "cd ${REPO_PATH} && git log --oneline -3 && echo && git status --short" | sed 's/^/  /'

echo
echo "── processes ──"
ssh "${HOST}" 'lsof -iTCP -sTCP:LISTEN -P 2>/dev/null | awk "/(:5733|:13773)/{printf \"  %s pid=%s\\n\", \$NF, \$2}"'

echo
echo "── tailscale serve ──"
ssh "${HOST}" '/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status 2>&1' | sed 's/^/  /'

echo
echo "── last pairing URL ──"
token=$(ssh "${HOST}" "grep -oE 'pair#token=[A-Z0-9]+' /tmp/campfire-mac.log 2>/dev/null | tail -1 | cut -d= -f2" || true)
if [[ -n "${token}" ]]; then
  echo "  https://${TAILNET_HOST}:${WEB_PORT}/pair#token=${token}"
else
  echo "  (no token in /tmp/campfire-mac.log — server may not be running)"
fi
