#!/usr/bin/env bash
# Issue a single-use pairing token against the Campfire dev server running
# on the Mac mini, ready to share with a coworker over Tailscale.
#
# Usage:
#   ./scripts/new-pairing-token.sh                  # label defaults to coworker-<date>
#   ./scripts/new-pairing-token.sh "alice"          # custom label
#   ./scripts/new-pairing-token.sh "alice" 7d       # custom label + TTL

set -euo pipefail

HOST="${MACMINI_HOST:-macmini}"
REPO_PATH="${MACMINI_REPO_PATH:-agent-host/repos/campfire}"
T3CODE_HOME="${MACMINI_T3CODE_HOME:-/Users/jeffbezos/.t3}"
DEV_URL="${MACMINI_DEV_URL:-http://localhost:5733}"
TAILNET_HOST="${CAMPFIRE_TAILNET_HOSTNAME:-jeffs-mac-mini.tail289246.ts.net}"
WEB_PORT="${CAMPFIRE_WEB_HTTPS_PORT:-8443}"
NODE_BIN="${MACMINI_NODE_BIN:-/opt/homebrew/bin/node}"

LABEL="${1:-coworker-$(date +%Y%m%d-%H%M)}"
TTL="${2:-24h}"
BASE_URL="https://${TAILNET_HOST}:${WEB_PORT}"

printf "Issuing pairing token on %s\n" "${HOST}"
printf "  label: %s\n  ttl:   %s\n\n" "${LABEL}" "${TTL}"

output=$(ssh "${HOST}" "cd ${REPO_PATH} && ${NODE_BIN} apps/server/src/bin.ts auth pairing create \
  --base-dir ${T3CODE_HOME} \
  --dev-url ${DEV_URL} \
  --base-url ${BASE_URL} \
  --label '${LABEL}' \
  --ttl ${TTL}" 2>&1)

pair_url=$(printf '%s\n' "${output}" | grep -oE "https://[^[:space:]]+/pair#token=[A-Z0-9]+" | tail -1)

if [[ -z "${pair_url}" ]]; then
  printf "Failed to extract pair URL. Raw output:\n%s\n" "${output}" >&2
  exit 1
fi

printf '%s\n' "${output}" | grep -E "^(Issued|Token:|Expires)" | sed 's/^/  /'
printf "\nPair URL:\n  %s\n" "${pair_url}"

if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "${pair_url}" | pbcopy
  printf "\n(copied to clipboard)\n"
fi
