#!/bin/sh
set -eu
unset CDPATH

fail() {
  echo "Campfire provider host restart failed: $*" >&2
  exit 78
}

if [ "$#" -ne 2 ]; then
  echo "usage: $0 /absolute/provider-host.plist /absolute/statev2.sqlite" >&2
  exit 64
fi

campfire_plist=$1
campfire_database=$2
case "$campfire_plist" in
  /*) ;;
  *) fail "plist path must be absolute" ;;
esac
[ -f "$campfire_plist" ] || fail "plist not found: $campfire_plist"
[ -f "$campfire_database" ] || fail "database not found: $campfire_database"
campfire_label=$(plutil -extract Label raw -o - "$campfire_plist") ||
  fail "plist has no Label: $campfire_plist"
campfire_domain=${CAMPFIRE_LAUNCHD_DOMAIN:-gui/$(id -u)}
campfire_idle_timeout=${CAMPFIRE_HOST_IDLE_TIMEOUT_SECONDS:-14400}
campfire_idle_poll=${CAMPFIRE_HOST_IDLE_POLL_SECONDS:-60}

# A run with no provider thread yet may still start on the host, so it counts.
active_codex_runs() {
  sqlite3 -readonly -cmd '.timeout 10000' "$campfire_database" "
    SELECT COUNT(*)
    FROM orchestration_v2_projection_runs AS runs
    LEFT JOIN orchestration_v2_projection_provider_threads AS threads
      ON threads.provider_thread_id = runs.provider_thread_id
    WHERE runs.status IN ('preparing', 'starting', 'running', 'waiting')
      AND (threads.driver IS NULL OR threads.driver = 'codex')"
}

campfire_waited=0
while :; do
  campfire_active=$(active_codex_runs)
  [ "$campfire_active" -ne 0 ] || break
  if [ "$campfire_waited" -ge "$campfire_idle_timeout" ]; then
    echo "Campfire provider host kept running: $campfire_active Codex run(s) still active after ${campfire_waited}s" >&2
    exit 75
  fi
  sleep "$campfire_idle_poll"
  campfire_waited=$((campfire_waited + campfire_idle_poll))
done

# kickstart -k would restart the definition launchd loaded, which can name an old release.
launchctl bootout "$campfire_domain/$campfire_label" 2>/dev/null || true
campfire_stop_wait=0
while launchctl print "$campfire_domain/$campfire_label" >/dev/null 2>&1; do
  campfire_stop_wait=$((campfire_stop_wait + 1))
  [ "$campfire_stop_wait" -le 30 ] || fail "$campfire_label did not stop within 30 seconds"
  sleep 1
done
# bootstrap can fail with EIO while launchd still tears down the old job.
campfire_attempt=1
until launchctl bootstrap "$campfire_domain" "$campfire_plist"; do
  [ "$campfire_attempt" -lt 3 ] || fail "$campfire_label is not loaded after 3 bootstrap attempts"
  campfire_attempt=$((campfire_attempt + 1))
  sleep 2
done

printf '{"status":"restarted","label":"%s","plist":"%s"}\n' "$campfire_label" "$campfire_plist"
