#!/bin/sh
set -eu
unset CDPATH

if [ "$#" -ne 2 ]; then
  echo "usage: $0 /absolute/campfire-backup.tar.gz /absolute/new-base-directory" >&2
  exit 64
fi

campfire_archive=$1
campfire_restore_dir=$2
case "$campfire_archive:$campfire_restore_dir" in
  /*:/*) ;;
  *)
    echo "Both paths must be absolute." >&2
    exit 64
    ;;
esac
[ -f "$campfire_archive" ] || {
  echo "Campfire backup archive not found: $campfire_archive" >&2
  exit 66
}
[ ! -L "$campfire_archive" ] || {
  echo "Campfire backup archive must not be a symbolic link." >&2
  exit 64
}
[ ! -e "$campfire_restore_dir" ] || {
  echo "Restore destination must not already exist: $campfire_restore_dir" >&2
  exit 73
}

command -v sqlite3 >/dev/null 2>&1 || {
  echo "sqlite3 is required." >&2
  exit 69
}
command -v tar >/dev/null 2>&1 || {
  echo "tar is required." >&2
  exit 69
}

campfire_restore_parent=$(dirname "$campfire_restore_dir")
[ -d "$campfire_restore_parent" ] || {
  echo "Restore destination parent does not exist: $campfire_restore_parent" >&2
  exit 73
}

tar -tzf "$campfire_archive" | awk '
  /^\// { exit 1 }
  {
    path = $0
    sub(/^\.\//, "", path)
    if (path == ".." || path ~ /^\.\.\// || path ~ /\/\.\.\// || path ~ /\/\.\.$/) exit 1
  }
' || {
  echo "Backup archive contains an unsafe path." >&2
  exit 65
}

campfire_staging_dir=$(mktemp -d "$campfire_restore_parent/.campfire-restore.XXXXXX")
cleanup() {
  rm -rf "$campfire_staging_dir"
}
trap cleanup EXIT HUP INT TERM

tar -C "$campfire_staging_dir" -xzf "$campfire_archive"
campfire_database="$campfire_staging_dir/userdata/state.sqlite"
[ -f "$campfire_database" ] || {
  echo "Backup archive does not contain userdata/state.sqlite." >&2
  exit 65
}
campfire_database_integrity=$(sqlite3 "$campfire_database" 'PRAGMA integrity_check;')
[ "$campfire_database_integrity" = "ok" ] || {
  echo "Restored Campfire database failed integrity_check." >&2
  exit 74
}

mv "$campfire_staging_dir" "$campfire_restore_dir"
trap - EXIT HUP INT TERM
printf '{"status":"restored","destination":"%s","databaseIntegrity":"ok"}\n' \
  "$campfire_restore_dir"
