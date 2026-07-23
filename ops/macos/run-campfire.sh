#!/bin/sh
set -eu
unset CDPATH

if [ "$#" -ne 1 ]; then
  echo "usage: $0 /absolute/path/to/server.env" >&2
  exit 64
fi

campfire_env_file=$1
campfire_script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
"$campfire_script_dir/campfire-preflight.sh" "$campfire_env_file"

set -a
# shellcheck disable=SC1090
. "$campfire_env_file"
set +a

: "${CAMPFIRE_RELEASE:?Set CAMPFIRE_RELEASE to the absolute built release directory}"
: "${CAMPFIRE_NODE:?Set CAMPFIRE_NODE to the absolute Node 24 executable}"
: "${T3CODE_HOME:?Set T3CODE_HOME to the absolute persistent data directory}"
: "${T3CODE_GOOGLE_OIDC_CLIENT_ID:?Set the Google web client ID}"
: "${T3CODE_GOOGLE_OIDC_CLIENT_SECRET:?Set the Google web client secret}"
: "${T3CODE_GOOGLE_OIDC_REDIRECT_URI:?Set the exact HTTPS callback URL}"
: "${T3CODE_GOOGLE_OIDC_ALLOWED_EMAILS:?Set the comma-separated team allowlist}"

export T3CODE_MODE=web
export T3CODE_HOST=127.0.0.1
export T3CODE_PORT="${T3CODE_PORT:-3773}"
export T3CODE_NO_BROWSER=true
export T3CODE_TAILSCALE_SERVE=true
export T3CODE_TAILSCALE_SERVE_PORT="${T3CODE_TAILSCALE_SERVE_PORT:-443}"
export T3CODE_CODEX_HOST_SOCKET="${T3CODE_CODEX_HOST_SOCKET:-$T3CODE_HOME/runtime/codex-provider-host.sock}"

campfire_wait_attempts=0
while [ ! -S "$T3CODE_CODEX_HOST_SOCKET" ]; do
  campfire_wait_attempts=$((campfire_wait_attempts + 1))
  if [ "$campfire_wait_attempts" -ge 120 ]; then
    echo "Codex provider host did not create $T3CODE_CODEX_HOST_SOCKET within 30 seconds" >&2
    exit 75
  fi
  sleep 0.25
done

exec "$CAMPFIRE_NODE" "$CAMPFIRE_RELEASE/apps/server/dist/bin.mjs" serve \
  --mode web \
  --host 127.0.0.1 \
  --port "$T3CODE_PORT" \
  --base-dir "$T3CODE_HOME" \
  --no-browser \
  --tailscale-serve \
  --tailscale-serve-port "$T3CODE_TAILSCALE_SERVE_PORT"
