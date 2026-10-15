#!/bin/sh
set -eu
unset CDPATH

fail() {
  echo "Campfire worktree maintenance failed: $*" >&2
  exit 78
}

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 /absolute/t3code-home retention-days [--dry-run]" >&2
  exit 64
fi

campfire_home=$1
campfire_retention_days=$2
campfire_dry_run=${3:-}
# Seconds one git command may run before its worktree is skipped for this pass.
campfire_git_timeout=${CAMPFIRE_WORKTREE_GIT_TIMEOUT_SECONDS:-60}
case "$campfire_home:$campfire_retention_days:$campfire_dry_run" in
  /*:*:|/*:*:--dry-run) ;;
  *) fail "home must be absolute, retention must be an integer, and mode must be --dry-run" ;;
esac
case "$campfire_retention_days" in
  ''|*[!0-9]*) fail "retention-days must be a non-negative integer" ;;
esac
case "$campfire_git_timeout" in
  ''|*[!0-9]*|0) fail "CAMPFIRE_WORKTREE_GIT_TIMEOUT_SECONDS must be a positive integer" ;;
esac

campfire_database="$campfire_home/userdata/statev2.sqlite"
campfire_worktree_root="$campfire_home/worktrees"
campfire_lock="$campfire_home/userdata/.worktree-maintenance.lock"
[ -f "$campfire_database" ] || fail "database not found: $campfire_database"
[ -d "$campfire_worktree_root" ] || exit 0
command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 is required"
command -v git >/dev/null 2>&1 || fail "git is required"
# Never take index.lock in an agent's worktree, so a git killed on timeout leaves nothing behind.
export GIT_OPTIONAL_LOCKS=0

if ! mkdir "$campfire_lock" 2>/dev/null; then
  echo "Campfire worktree maintenance already running; skipping."
  exit 0
fi
campfire_tmp=$(mktemp -d "${TMPDIR:-/tmp}/campfire-worktree-maintenance.XXXXXX")
cleanup() {
  rm -rf "$campfire_tmp"
  rmdir "$campfire_lock" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
# The git watchdog sends USR1 so the pass stops waiting on a git that ignores TERM.
trap ':' USR1

campfire_now=$(date +%s)
campfire_cutoff=$((campfire_now - campfire_retention_days * 86400))
campfire_cleaned=0
campfire_removed=0
campfire_skipped_active=0
campfire_skipped_dirty=0
campfire_skipped_unresponsive=0

sql_quote() {
  printf '%s' "$1" | sed "s/'/''/g"
}

query_db() {
  sqlite3 -cmd '.timeout 5000' "$campfire_database" "$1"
}

# Runs git in a worktree with a deadline and leaves its stdout in $campfire_tmp/git.out.
# A wedged worktree is reported and skipped instead of stalling every worktree after it.
run_git() {
  campfire_git_worktree=$1
  shift
  rm -f "$campfire_tmp/git.out" "$campfire_tmp/git-timed-out"
  git -C "$campfire_git_worktree" "$@" >"$campfire_tmp/git.out" &
  campfire_git_pid=$!
  (
    trap 'kill "$campfire_sleep_pid" 2>/dev/null; exit 0' TERM
    sleep "$campfire_git_timeout" &
    campfire_sleep_pid=$!
    wait "$campfire_sleep_pid"
    : >"$campfire_tmp/git-timed-out"
    kill -TERM "$campfire_git_pid" 2>/dev/null || true
    kill -USR1 "$$" 2>/dev/null || true
  ) >/dev/null 2>&1 &
  campfire_watchdog_pid=$!
  campfire_git_status=0
  wait "$campfire_git_pid" || campfire_git_status=$?
  kill -TERM "$campfire_watchdog_pid" 2>/dev/null || true
  wait "$campfire_watchdog_pid" 2>/dev/null || true
  if [ -e "$campfire_tmp/git-timed-out" ]; then
    campfire_skipped_unresponsive=$((campfire_skipped_unresponsive + 1))
    echo "kept unresponsive worktree: $campfire_git_worktree (git $1 timed out after ${campfire_git_timeout}s)"
    return 124
  fi
  return "$campfire_git_status"
}

# Same activity signals as the server's runtime recovery (ProjectionStore.getRecoveryThreadIds):
# a run that has not settled, or a provider session whose process is still alive.
is_active_worktree() {
  campfire_active_worktree_sql=$(sql_quote "$1")
  campfire_active_count=$(query_db "
    WITH active_threads AS (
      SELECT thread_id
      FROM orchestration_v2_projection_runs
      WHERE status IN ('preparing', 'starting', 'running', 'waiting')
        OR (status = 'queued' AND json_extract(payload_json, '\$.queueHeld') IS NOT 1)
      UNION
      SELECT bindings.thread_id
      FROM orchestration_v2_projection_provider_session_bindings AS bindings
      JOIN orchestration_v2_projection_provider_sessions AS sessions
        ON sessions.provider_session_id = bindings.provider_session_id
      WHERE sessions.status NOT IN ('stopped', 'error')
    )
    SELECT COUNT(*)
    FROM orchestration_v2_projection_threads AS thread
    JOIN active_threads AS active ON active.thread_id = thread.thread_id
    WHERE thread.deleted_at IS NULL
      AND json_extract(thread.payload_json, '\$.worktreePath') = '$campfire_active_worktree_sql';") ||
    fail "could not read thread activity for $1"
  case "$campfire_active_count" in
    ''|*[!0-9]*) fail "could not read thread activity for $1" ;;
  esac
  [ "$campfire_active_count" -gt 0 ]
}

for campfire_worktree in "$campfire_worktree_root"/*/*; do
  [ -d "$campfire_worktree" ] || continue

  if is_active_worktree "$campfire_worktree"; then
    campfire_skipped_active=$((campfire_skipped_active + 1))
    continue
  fi

  campfire_target="$campfire_worktree/target"
  if [ -d "$campfire_target" ]; then
    if [ "$campfire_dry_run" = "--dry-run" ]; then
      echo "would clean: $campfire_target"
    elif [ -f "$campfire_worktree/Cargo.toml" ] &&
      command -v cargo >/dev/null 2>&1 &&
      CARGO_TARGET_DIR="$campfire_target" cargo clean \
        --manifest-path "$campfire_worktree/Cargo.toml" >/dev/null 2>&1; then
      echo "cleaned: $campfire_target"
    else
      rm -rf "$campfire_target"
      echo "cleaned: $campfire_target"
    fi
    campfire_cleaned=$((campfire_cleaned + 1))
  fi

  campfire_worktree_sql=$(sql_quote "$campfire_worktree")
  campfire_thread_metadata=$(query_db "SELECT
       SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END),
       COALESCE(MAX(unixepoch(updated_at)), 0)
     FROM orchestration_v2_projection_threads
     WHERE json_extract(payload_json, '\$.worktreePath') = '$campfire_worktree_sql';")
  campfire_live_threads=${campfire_thread_metadata%%|*}
  campfire_last_activity=${campfire_thread_metadata#*|}
  campfire_live_threads=${campfire_live_threads:-0}
  campfire_last_activity=${campfire_last_activity:-0}
  [ "$campfire_live_threads" -eq 0 ] || continue

  if [ "$campfire_last_activity" -eq 0 ]; then
    campfire_last_activity=$(stat -f '%m' "$campfire_worktree" 2>/dev/null || stat -c '%Y' "$campfire_worktree")
  fi
  [ "$campfire_last_activity" -le "$campfire_cutoff" ] || continue
  [ -e "$campfire_worktree/.git" ] || continue
  run_git "$campfire_worktree" symbolic-ref -q HEAD 2>/dev/null || continue

  run_git "$campfire_worktree" status --porcelain --untracked-files=all || continue
  if [ -s "$campfire_tmp/git.out" ]; then
    campfire_skipped_dirty=$((campfire_skipped_dirty + 1))
    echo "kept dirty worktree: $campfire_worktree"
    continue
  fi

  if [ "$campfire_dry_run" = "--dry-run" ]; then
    echo "would remove: $campfire_worktree"
  elif run_git "$campfire_worktree" worktree remove "$campfire_worktree"; then
    echo "removed: $campfire_worktree"
  else
    continue
  fi
  campfire_removed=$((campfire_removed + 1))
done

printf '{"status":"ok","dryRun":%s,"cleaned":%s,"removed":%s,"skippedActive":%s,"skippedDirty":%s,"skippedUnresponsive":%s}\n' \
  "$(if [ "$campfire_dry_run" = "--dry-run" ]; then echo true; else echo false; fi)" \
  "$campfire_cleaned" "$campfire_removed" "$campfire_skipped_active" "$campfire_skipped_dirty" \
  "$campfire_skipped_unresponsive"
