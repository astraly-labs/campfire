#!/bin/sh
set -eu
unset CDPATH

if [ "$#" -ne 2 ]; then
  echo "usage: $0 /absolute/t3code-home /absolute/backup-directory" >&2
  exit 64
fi

campfire_base_dir=$1
campfire_backup_dir=$2
campfire_state_dir="$campfire_base_dir/userdata"
campfire_database="$campfire_state_dir/state.sqlite"

case "$campfire_base_dir:$campfire_backup_dir" in
  /*:/*) ;;
  *)
    echo "Both paths must be absolute." >&2
    exit 64
    ;;
esac

if [ ! -f "$campfire_database" ]; then
  echo "Campfire database not found: $campfire_database" >&2
  exit 66
fi

command -v sqlite3 >/dev/null 2>&1 || {
  echo "sqlite3 is required for a transactionally consistent live backup." >&2
  exit 69
}
command -v rsync >/dev/null 2>&1 || {
  echo "rsync is required." >&2
  exit 69
}

mkdir -p "$campfire_backup_dir"
campfire_base_dir_real=$(cd -- "$campfire_base_dir" && pwd -P)
campfire_backup_dir_real=$(cd -- "$campfire_backup_dir" && pwd -P)
case "$campfire_backup_dir_real/" in
  "$campfire_base_dir_real"/*)
    echo "Backup directory must not be inside the Campfire base directory." >&2
    exit 64
    ;;
esac
case "$campfire_base_dir_real/" in
  "$campfire_backup_dir_real"/*)
    echo "Campfire base directory must not be inside the backup directory." >&2
    exit 64
    ;;
esac
campfire_timestamp=$(date -u +%Y%m%dT%H%M%SZ)
campfire_staging_dir=$(mktemp -d "$campfire_backup_dir/.campfire-$campfire_timestamp.XXXXXX")
campfire_backup_id=$(basename "$campfire_staging_dir")
campfire_archive="$campfire_backup_dir/${campfire_backup_id#.}.tar.gz"

cleanup() {
  rm -rf "$campfire_staging_dir"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$campfire_staging_dir/userdata"
sqlite3 "$campfire_database" ".backup '$campfire_staging_dir/userdata/state.sqlite'"
rsync -a \
  --exclude 'state.sqlite' \
  --exclude 'state.sqlite-shm' \
  --exclude 'state.sqlite-wal' \
  --exclude 'logs/' \
  "$campfire_state_dir/" "$campfire_staging_dir/userdata/"

if [ -d "$campfire_base_dir/worktrees" ]; then
  rsync -a "$campfire_base_dir/worktrees/" "$campfire_staging_dir/worktrees/"
fi

campfire_database_integrity=$(sqlite3 "$campfire_staging_dir/userdata/state.sqlite" \
  'PRAGMA integrity_check;')
if [ "$campfire_database_integrity" != "ok" ]; then
  echo "Copied Campfire database failed integrity_check." >&2
  exit 74
fi

{
  echo "created_at=$campfire_timestamp"
  echo "source_base_dir=$campfire_base_dir"
  echo "database_integrity=$campfire_database_integrity"
} >"$campfire_staging_dir/manifest.txt"

tar -C "$campfire_staging_dir" -czf "$campfire_archive" .
chmod 600 "$campfire_archive"
echo "$campfire_archive"
