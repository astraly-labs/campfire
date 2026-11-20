#!/bin/sh
set -eu
unset CDPATH

fail() {
  echo "Campfire provider host restart failed: $*" >&2
  exit 78
}

if [ "$#" -lt 3 ] || { [ "$#" -gt 3 ] && [ "$4" != -- ]; }; then
  echo "usage: $0 /absolute/provider-host.plist /absolute/server.plist /absolute/statev2.sqlite [-- release switch command]" >&2
  exit 64
fi

campfire_host_plist=$1
campfire_server_plist=$2
campfire_database=$3
shift 3
[ "$#" -eq 0 ] || shift
for campfire_plist in "$campfire_host_plist" "$campfire_server_plist"; do
  case "$campfire_plist" in
    /*) ;;
    *) fail "plist path must be absolute: $campfire_plist" ;;
  esac
  [ -f "$campfire_plist" ] || fail "plist not found: $campfire_plist"
done
[ -f "$campfire_database" ] || fail "database not found: $campfire_database"
campfire_host_label=$(plutil -extract Label raw -o - "$campfire_host_plist") ||
  fail "plist has no Label: $campfire_host_plist"
campfire_server_label=$(plutil -extract Label raw -o - "$campfire_server_plist") ||
  fail "plist has no Label: $campfire_server_plist"
campfire_domain=${CAMPFIRE_LAUNCHD_DOMAIN:-gui/$(id -u)}
campfire_idle_timeout=${CAMPFIRE_HOST_IDLE_TIMEOUT_SECONDS:-14400}
campfire_idle_poll=${CAMPFIRE_HOST_IDLE_POLL_SECONDS:-60}
campfire_stop_timeout=${CAMPFIRE_JOB_STOP_TIMEOUT_SECONDS:-30}
campfire_force=${CAMPFIRE_HOST_RESTART_FORCE:-0}

# Codex work that a host restart would end. A run or an item with no provider thread
# yet may still start on the host, so it counts. A completed run can still own a command
# or a subagent.
active_codex_work() {
  sqlite3 -readonly -cmd '.timeout 10000' "$campfire_database" "
    SELECT
      (SELECT COUNT(*)
        FROM orchestration_v2_projection_runs AS runs
        LEFT JOIN orchestration_v2_projection_provider_threads AS threads
          ON threads.provider_thread_id = runs.provider_thread_id
        WHERE runs.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
          AND (threads.driver IS NULL OR threads.driver = 'codex'))
      + (SELECT COUNT(*)
        FROM orchestration_v2_projection_turn_items AS items
        LEFT JOIN orchestration_v2_projection_provider_threads AS threads
          ON threads.provider_thread_id = items.provider_thread_id
        WHERE items.type IN ('command_execution', 'dynamic_tool', 'subagent')
          AND items.status IN ('pending', 'running', 'waiting')
          AND (threads.driver IS NULL OR threads.driver = 'codex'))
      + (SELECT COUNT(*)
        FROM orchestration_v2_projection_subagents AS agents
        WHERE agents.status IN ('pending', 'running', 'waiting')
          AND (agents.driver IS NULL OR agents.driver = 'codex'))"
}

stop_job() {
  launchctl bootout "$campfire_domain/$1" 2>/dev/null || true
  campfire_stop_wait=0
  while launchctl print "$campfire_domain/$1" >/dev/null 2>&1; do
    campfire_stop_wait=$((campfire_stop_wait + 1))
    [ "$campfire_stop_wait" -le "$campfire_stop_timeout" ] ||
      fail "$1 did not stop within $campfire_stop_timeout seconds"
    sleep 1
  done
}

# bootstrap can fail with EIO while launchd still tears down the old job.
start_job() {
  campfire_attempt=1
  until launchctl bootstrap "$campfire_domain" "$2"; do
    [ "$campfire_attempt" -lt 3 ] || fail "$1 is not loaded after 3 bootstrap attempts"
    campfire_attempt=$((campfire_attempt + 1))
    sleep 2
  done
}

# The server stops before the last check, so it cannot start a run that the host
# restart would end. A run that started before the stop sends the server back up.
campfire_waited=0
while :; do
  if [ "$campfire_force" != 1 ]; then
    campfire_active=$(active_codex_work)
    if [ "$campfire_active" -ne 0 ]; then
      if [ "$campfire_waited" -ge "$campfire_idle_timeout" ]; then
        echo "Campfire provider host kept running: $campfire_active Codex work item(s) still active after ${campfire_waited}s" >&2
        exit 75
      fi
      sleep "$campfire_idle_poll"
      campfire_waited=$((campfire_waited + campfire_idle_poll))
      continue
    fi
  fi
  stop_job "$campfire_server_label"
  [ "$campfire_force" != 1 ] || break
  [ "$(active_codex_work)" -ne 0 ] || break
  echo "A Codex run started before $campfire_server_label stopped. Starting it again to wait." >&2
  start_job "$campfire_server_label" "$campfire_server_plist"
done

# Switch the release only while both jobs are down, so a server never meets a host of
# another release.
if [ "$#" -gt 0 ] && ! "$@"; then
  start_job "$campfire_server_label" "$campfire_server_plist"
  fail "the release switch failed, so the server runs its previous release again"
fi
# kickstart -k would restart the definition launchd loaded, which can name an old release.
stop_job "$campfire_host_label"
start_job "$campfire_host_label" "$campfire_host_plist"
start_job "$campfire_server_label" "$campfire_server_plist"

printf '{"status":"restarted","host":"%s","server":"%s"}\n' "$campfire_host_label" "$campfire_server_label"
