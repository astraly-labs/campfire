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

export T3CODE_MODE=web
export T3CODE_NO_BROWSER=true
export T3CODE_CODEX_HOST_SOCKET="${T3CODE_CODEX_HOST_SOCKET:-$T3CODE_HOME/runtime/codex-provider-host.sock}"

exec "$CAMPFIRE_NODE" "$CAMPFIRE_RELEASE/apps/server/dist/bin.mjs" provider-host \
  --mode web \
  --base-dir "$T3CODE_HOME" \
  --no-browser
