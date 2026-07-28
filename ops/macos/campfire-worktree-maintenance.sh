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
case "$campfire_home:$campfire_retention_days:$campfire_dry_run" in
  /*:*:|/*:*:--dry-run) ;;
  *) fail "home must be absolute, retention must be an integer, and mode must be --dry-run" ;;
esac
case "$campfire_retention_days" in
  ''|*[!0-9]*) fail "retention-days must be a non-negative integer" ;;
esac

campfire_database="$campfire_home/userdata/state.sqlite"
campfire_worktree_root="$campfire_home/worktrees"
campfire_lock="$campfire_home/userdata/.worktree-maintenance.lock"
[ -f "$campfire_database" ] || fail "database not found: $campfire_database"
[ -d "$campfire_worktree_root" ] || exit 0
command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 is required"
command -v git >/dev/null 2>&1 || fail "git is required"

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

campfire_now=$(date +%s)
campfire_cutoff=$((campfire_now - campfire_retention_days * 86400))
campfire_cleaned=0
campfire_removed=0
campfire_skipped_active=0
campfire_skipped_dirty=0

sql_quote() {
  printf '%s' "$1" | sed "s/'/''/g"
}

is_active_worktree() {
  campfire_active_worktree_sql=$(sql_quote "$1")
  campfire_active_count=$(sqlite3 "$campfire_database" "
    WITH latest_turn AS (
      SELECT
        thread_id,
        state,
        ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY row_id DESC) AS rank
      FROM projection_turns
    ),
    active_threads AS (
      SELECT thread_id
      FROM latest_turn
      WHERE rank = 1 AND state IN ('pending', 'running')
      UNION
      SELECT thread_id
      FROM provider_session_runtime
      WHERE status = 'running'
    )
    SELECT COUNT(*)
    FROM projection_threads AS thread
    JOIN active_threads AS active ON active.thread_id = thread.thread_id
    WHERE thread.deleted_at IS NULL
      AND thread.worktree_path = '$campfire_active_worktree_sql';")
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
  campfire_thread_metadata=$(sqlite3 -separator '|' "$campfire_database" \
    "SELECT
       SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END),
       COALESCE(MAX(unixepoch(updated_at)), 0)
     FROM projection_threads
     WHERE worktree_path = '$campfire_worktree_sql';")
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
  git -C "$campfire_worktree" symbolic-ref -q HEAD >/dev/null 2>&1 || continue

  if [ -n "$(git -C "$campfire_worktree" status --porcelain --untracked-files=all)" ]; then
    campfire_skipped_dirty=$((campfire_skipped_dirty + 1))
    echo "kept dirty worktree: $campfire_worktree"
    continue
  fi

  if [ "$campfire_dry_run" = "--dry-run" ]; then
    echo "would remove: $campfire_worktree"
  else
    git -C "$campfire_worktree" worktree remove "$campfire_worktree"
    echo "removed: $campfire_worktree"
  fi
  campfire_removed=$((campfire_removed + 1))
done

printf '{"status":"ok","dryRun":%s,"cleaned":%s,"removed":%s,"skippedActive":%s,"skippedDirty":%s}\n' \
  "$(if [ "$campfire_dry_run" = "--dry-run" ]; then echo true; else echo false; fi)" \
  "$campfire_cleaned" "$campfire_removed" "$campfire_skipped_active" "$campfire_skipped_dirty"
