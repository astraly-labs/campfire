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
# Build caches regrow on the next build, so they can expire sooner than worktrees.
campfire_target_retention_days=${CAMPFIRE_TARGET_RETENTION_DAYS:-$campfire_retention_days}
# Colon-separated folders whose direct children are Cargo target directories.
campfire_cargo_target_roots=${CAMPFIRE_CARGO_TARGET_ROOTS:-}
# Seconds one git command may run before its worktree is skipped for this pass.
campfire_git_timeout=${CAMPFIRE_WORKTREE_GIT_TIMEOUT_SECONDS:-60}
case "$campfire_home:$campfire_retention_days:$campfire_dry_run" in
  /*:*:|/*:*:--dry-run) ;;
  *) fail "home must be absolute, retention must be an integer, and mode must be --dry-run" ;;
esac
case "$campfire_retention_days" in
  ''|*[!0-9]*) fail "retention-days must be a non-negative integer" ;;
esac
case "$campfire_target_retention_days" in
  ''|*[!0-9]*) fail "CAMPFIRE_TARGET_RETENTION_DAYS must be a non-negative integer" ;;
esac
case "$campfire_git_timeout" in
  ''|*[!0-9]*|0) fail "CAMPFIRE_WORKTREE_GIT_TIMEOUT_SECONDS must be a positive integer" ;;
esac

campfire_database="$campfire_home/userdata/statev2.sqlite"
campfire_settings="$campfire_home/userdata/settings.json"
campfire_lock="$campfire_home/userdata/.worktree-maintenance.lock"
[ -f "$campfire_database" ] || fail "database not found: $campfire_database"
command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 is required"
command -v git >/dev/null 2>&1 || fail "git is required"
command -v lsof >/dev/null 2>&1 || fail "lsof is required"
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
campfire_target_cutoff=$((campfire_now - campfire_target_retention_days * 86400))
campfire_cleaned=0
campfire_removed=0
campfire_skipped_active=0
campfire_skipped_dirty=0
campfire_skipped_unresponsive=0
campfire_unreadable_roots=0

sql_quote() {
  printf '%s' "$1" | sed "s/'/''/g"
}

query_db() {
  sqlite3 -cmd '.timeout 5000' "$campfire_database" "$1"
}

# Runs git in a worktree with a deadline, leaves its output in $campfire_tmp/git.out and
# $campfire_tmp/git.err, and forwards the errors to the job log.
# A wedged worktree is reported and skipped instead of stalling every worktree after it.
run_git() {
  campfire_git_worktree=$1
  shift
  rm -f "$campfire_tmp/git.out" "$campfire_tmp/git.err" "$campfire_tmp/git-timed-out"
  git -C "$campfire_git_worktree" "$@" >"$campfire_tmp/git.out" 2>"$campfire_tmp/git.err" &
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
  cat "$campfire_tmp/git.err" >&2
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

# Every directory holding managed worktrees, as the server's managedWorktreesDirectories
# reads them. A drive that is not mounted only skips its own worktrees.
list_worktree_roots() {
  echo "$campfire_home/worktrees"
  [ -f "$campfire_settings" ] || return 0
  campfire_settings_sql=$(sql_quote "$campfire_settings")
  sqlite3 :memory: "
    SELECT json_extract(readfile('$campfire_settings_sql'), '\$.worktreesDirectory')
    UNION ALL
    SELECT value FROM json_each(readfile('$campfire_settings_sql'), '\$.previousWorktreesDirectories');" ||
    fail "could not read worktree directories from $campfire_settings"
}

# A denied listing leaves a glob literal, which looks exactly like an empty folder.
# On an external drive, macOS denies it unless launchd starts this script through a
# binary holding the removable-volumes permission (see the plist example).
# A folder that does not exist, such as an unplugged drive, is a quiet skip.
can_list_root() {
  [ -d "$1" ] || return 1
  ls -A "$1" >/dev/null && return 0
  campfire_unreadable_roots=$((campfire_unreadable_roots + 1))
  echo "Campfire worktree maintenance skipped a folder it cannot list: $1" >&2
  return 1
}

# Agents also create and use worktrees by hand, so no thread vouches for those.
newest_mtime() {
  campfire_newest=0
  for campfire_path in "$@"; do
    [ -e "$campfire_path" ] || continue
    campfire_mtime=$(stat -f '%m' "$campfire_path" 2>/dev/null || stat -c '%Y' "$campfire_path")
    [ "$campfire_mtime" -le "$campfire_newest" ] || campfire_newest=$campfire_mtime
  done
  echo "$campfire_newest"
}

# A build rewrites these folders; the target's own top level can stay untouched for days.
target_is_stale() {
  [ "$(newest_mtime "$1" "$1/debug" "$1/debug/deps" "$1/debug/.fingerprint" \
    "$1/release" "$1/release/deps" "$1/release/.fingerprint")" -le "$campfire_target_cutoff" ]
}

# Anything a process runs from, such as a long QA run or a build in a hand-made worktree.
is_process_cwd() {
  campfire_real_worktree=$(cd "$1" && pwd -P) || return 0
  grep -Fq "n$campfire_real_worktree/" "$campfire_tmp/process-cwds"
}

lsof -b -w -d cwd -Fn 2>/dev/null | sed -n 's|^\(n/.*\)$|\1/|p' >"$campfire_tmp/process-cwds" || true
# This pass has a cwd of its own: an empty list means lsof failed, not that nothing runs.
[ -s "$campfire_tmp/process-cwds" ] || fail "could not list process working directories"

list_worktree_roots >"$campfire_tmp/roots"
set --
while IFS= read -r campfire_root <&3; do
  case "$campfire_root" in
    '~') campfire_root=$HOME ;;
    '~/'*) campfire_root="$HOME/${campfire_root#'~/'}" ;;
  esac
  case "$campfire_root" in
    /?*) can_list_root "$campfire_root" || continue ;;
    *) continue ;;
  esac
  for campfire_worktree in "$campfire_root"/*/*; do
    [ -d "$campfire_worktree" ] && set -- "$@" "$campfire_worktree"
  done
done 3<"$campfire_tmp/roots"

for campfire_worktree in "$@"; do
  if is_active_worktree "$campfire_worktree" || is_process_cwd "$campfire_worktree"; then
    campfire_skipped_active=$((campfire_skipped_active + 1))
    continue
  fi

  campfire_target="$campfire_worktree/target"
  if [ -d "$campfire_target" ] && target_is_stale "$campfire_target"; then
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

  campfire_gitdir=$(sed -n 's/^gitdir: //p' "$campfire_worktree/.git" 2>/dev/null || true)
  campfire_disk_activity=$(newest_mtime "$campfire_worktree" \
    "$campfire_gitdir/index" "$campfire_gitdir/HEAD" "$campfire_gitdir/logs/HEAD")
  [ "$campfire_disk_activity" -le "$campfire_last_activity" ] ||
    campfire_last_activity=$campfire_disk_activity
  [ "$campfire_last_activity" -le "$campfire_cutoff" ] || continue

  [ "$campfire_live_threads" -eq 0 ] || continue
  [ -e "$campfire_worktree/.git" ] || continue
  run_git "$campfire_worktree" symbolic-ref -q HEAD 2>/dev/null || continue

  run_git "$campfire_worktree" status --porcelain --untracked-files=all || continue
  # A failing drive makes status warn and exit 0 with no output, which reads as clean.
  if [ -s "$campfire_tmp/git.err" ]; then
    campfire_skipped_unresponsive=$((campfire_skipped_unresponsive + 1))
    echo "kept unreadable worktree: $campfire_worktree"
    continue
  fi
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

campfire_roots_left=$campfire_cargo_target_roots
while [ -n "$campfire_roots_left" ]; do
  campfire_root=${campfire_roots_left%%:*}
  case "$campfire_roots_left" in
    *:*) campfire_roots_left=${campfire_roots_left#*:} ;;
    *) campfire_roots_left= ;;
  esac
  can_list_root "$campfire_root" || continue
  for campfire_target in "$campfire_root"/*; do
    # Cargo leaves these markers, so nothing else in the folder can be mistaken for a cache.
    [ -f "$campfire_target/CACHEDIR.TAG" ] || [ -f "$campfire_target/.rustc_info.json" ] || continue
    if is_process_cwd "$campfire_target"; then
      campfire_skipped_active=$((campfire_skipped_active + 1))
      continue
    fi
    target_is_stale "$campfire_target" || continue
    if [ "$campfire_dry_run" = "--dry-run" ]; then
      echo "would clean: $campfire_target"
    else
      rm -rf "$campfire_target"
      echo "cleaned: $campfire_target"
    fi
    campfire_cleaned=$((campfire_cleaned + 1))
  done
done

campfire_status=ok
[ "$campfire_unreadable_roots" -eq 0 ] || campfire_status=partial
printf '{"status":"%s","dryRun":%s,"cleaned":%s,"removed":%s,"skippedActive":%s,"skippedDirty":%s,"skippedUnresponsive":%s,"unreadableRoots":%s}\n' \
  "$campfire_status" \
  "$(if [ "$campfire_dry_run" = "--dry-run" ]; then echo true; else echo false; fi)" \
  "$campfire_cleaned" "$campfire_removed" "$campfire_skipped_active" "$campfire_skipped_dirty" \
  "$campfire_skipped_unresponsive" "$campfire_unreadable_roots"
[ "$campfire_unreadable_roots" -eq 0 ] || exit 74
