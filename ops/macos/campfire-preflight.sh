#!/bin/sh
set -eu
unset CDPATH

fail() {
  echo "Campfire preflight failed: $*" >&2
  exit 78
}

if [ "$#" -ne 1 ]; then
  echo "usage: $0 /absolute/path/to/server.env" >&2
  exit 64
fi

campfire_env_file=$1
case "$campfire_env_file" in
  /*) ;;
  *) fail "the environment file path must be absolute" ;;
esac

[ -f "$campfire_env_file" ] || fail "environment file not found: $campfire_env_file"
[ ! -L "$campfire_env_file" ] || fail "environment file must not be a symbolic link"

campfire_env_mode=$(stat -f '%Lp' "$campfire_env_file" 2>/dev/null || stat -c '%a' "$campfire_env_file")
[ "$campfire_env_mode" = "600" ] || fail "environment file mode must be 0600 (found $campfire_env_mode)"
campfire_env_uid=$(stat -f '%u' "$campfire_env_file" 2>/dev/null || stat -c '%u' "$campfire_env_file")
[ "$campfire_env_uid" = "$(id -u)" ] || fail "environment file must be owned by the service user"

set -a
# The file is sourced only after its ownership and permissions have been verified.
# shellcheck disable=SC1090
. "$campfire_env_file"
set +a

: "${CAMPFIRE_DEPLOYMENT:?Set CAMPFIRE_DEPLOYMENT to staging or production}"
: "${CAMPFIRE_RELEASE:?Set CAMPFIRE_RELEASE to the absolute built release directory}"
: "${CAMPFIRE_NODE:?Set CAMPFIRE_NODE to the absolute Node 24 executable}"
: "${T3CODE_HOME:?Set T3CODE_HOME to the absolute persistent data directory}"
: "${T3CODE_GOOGLE_OIDC_CLIENT_ID:?Set the Google web client ID}"
: "${T3CODE_GOOGLE_OIDC_CLIENT_SECRET:?Set the Google web client secret}"
: "${T3CODE_GOOGLE_OIDC_REDIRECT_URI:?Set the exact HTTPS callback URL}"
: "${T3CODE_GOOGLE_OIDC_ALLOWED_EMAILS:?Set the comma-separated team allowlist}"

T3CODE_PORT=${T3CODE_PORT:-3773}
T3CODE_TAILSCALE_SERVE_PORT=${T3CODE_TAILSCALE_SERVE_PORT:-443}

case "$CAMPFIRE_DEPLOYMENT" in
  staging|production) ;;
  *) fail "CAMPFIRE_DEPLOYMENT must be staging or production" ;;
esac
case "$CAMPFIRE_RELEASE:$CAMPFIRE_NODE:$T3CODE_HOME" in
  /*:/*:/*) ;;
  *) fail "CAMPFIRE_RELEASE, CAMPFIRE_NODE, and T3CODE_HOME must be absolute paths" ;;
esac

[ -d "$CAMPFIRE_RELEASE" ] || fail "release directory not found: $CAMPFIRE_RELEASE"
[ -f "$CAMPFIRE_RELEASE/apps/server/dist/bin.mjs" ] || fail "release is not built"
[ -x "$CAMPFIRE_NODE" ] || fail "CAMPFIRE_NODE is not executable"

campfire_node_version=$("$CAMPFIRE_NODE" -p 'process.versions.node')
campfire_node_major=${campfire_node_version%%.*}
campfire_node_rest=${campfire_node_version#*.}
campfire_node_minor=${campfire_node_rest%%.*}
campfire_node_patch=${campfire_node_rest#*.}
if [ "$campfire_node_major" -ne 24 ] || [ "$campfire_node_minor" -lt 13 ] ||
  { [ "$campfire_node_minor" -eq 13 ] && [ "$campfire_node_patch" -lt 1 ]; }; then
  fail "Node 24.13.1 or newer within major 24 is required (found $campfire_node_version)"
fi

case "$T3CODE_PORT:$T3CODE_TAILSCALE_SERVE_PORT" in
  *[!0-9:]*|:*|*:|*:*:*) fail "backend and Serve ports must be integers" ;;
esac
if [ "$T3CODE_PORT" -lt 1 ] || [ "$T3CODE_PORT" -gt 65535 ] ||
  [ "$T3CODE_TAILSCALE_SERVE_PORT" -lt 1 ] || [ "$T3CODE_TAILSCALE_SERVE_PORT" -gt 65535 ]; then
  fail "backend and Serve ports must be between 1 and 65535"
fi

if [ "$CAMPFIRE_DEPLOYMENT" = "staging" ]; then
  : "${CAMPFIRE_PRODUCTION_HOME:?Set CAMPFIRE_PRODUCTION_HOME for staging isolation checks}"
  case "$CAMPFIRE_PRODUCTION_HOME" in
    /*) ;;
    *) fail "CAMPFIRE_PRODUCTION_HOME must be absolute" ;;
  esac
  [ "$T3CODE_HOME" != "$CAMPFIRE_PRODUCTION_HOME" ] || fail "staging must not reuse production data"
  [ "$T3CODE_PORT" != "3773" ] || fail "staging must not use the production backend port 3773"
  [ "$T3CODE_TAILSCALE_SERVE_PORT" != "443" ] || fail "staging must not use production Serve port 443"
fi

export CAMPFIRE_DEPLOYMENT CAMPFIRE_RELEASE CAMPFIRE_NODE CAMPFIRE_PRODUCTION_HOME T3CODE_HOME
export T3CODE_PORT T3CODE_TAILSCALE_SERVE_PORT
export T3CODE_GOOGLE_OIDC_CLIENT_ID T3CODE_GOOGLE_OIDC_CLIENT_SECRET
export T3CODE_GOOGLE_OIDC_REDIRECT_URI T3CODE_GOOGLE_OIDC_ALLOWED_EMAILS

# shellcheck disable=SC2016
"$CAMPFIRE_NODE" -e '
  const path = require("node:path");
  const fail = (message) => { console.error(`Campfire preflight failed: ${message}`); process.exit(78); };
  const release = path.resolve(process.env.CAMPFIRE_RELEASE);
  const home = path.resolve(process.env.T3CODE_HOME);
  if (home === release || home.startsWith(`${release}${path.sep}`) || release.startsWith(`${home}${path.sep}`)) {
    fail("release and persistent data directories must not overlap");
  }
  if (process.env.CAMPFIRE_DEPLOYMENT === "staging" &&
      home === path.resolve(process.env.CAMPFIRE_PRODUCTION_HOME)) {
    fail("staging must not reuse production data through a path alias");
  }
  let redirect;
  try { redirect = new URL(process.env.T3CODE_GOOGLE_OIDC_REDIRECT_URI); }
  catch { fail("Google redirect URI is malformed"); }
  const expectedPort = process.env.T3CODE_TAILSCALE_SERVE_PORT === "443"
    ? ""
    : process.env.T3CODE_TAILSCALE_SERVE_PORT;
  if (redirect.protocol !== "https:" || redirect.username || redirect.password ||
      !redirect.hostname.endsWith(".ts.net") || redirect.port !== expectedPort ||
      redirect.pathname !== "/auth/google/callback" || redirect.search || redirect.hash) {
    fail("Google redirect URI must be the exact HTTPS Tailnet callback for the configured Serve port");
  }
  if (!process.env.T3CODE_GOOGLE_OIDC_CLIENT_ID.endsWith(".apps.googleusercontent.com")) {
    fail("Google client ID has an unexpected format");
  }
  const emails = process.env.T3CODE_GOOGLE_OIDC_ALLOWED_EMAILS.split(",").map((value) => value.trim());
  if (emails.length < 1 || emails.length > 5 || new Set(emails.map((email) => email.toLowerCase())).size !== emails.length ||
      emails.some((email) => !/^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(email))) {
    fail("Google allowlist must contain one to five unique email addresses");
  }
' || exit $?

printf '{"status":"passed","deployment":"%s","nodeVersion":"%s","backendPort":%s,"servePort":%s}\n' \
  "$CAMPFIRE_DEPLOYMENT" "$campfire_node_version" "$T3CODE_PORT" "$T3CODE_TAILSCALE_SERVE_PORT"
