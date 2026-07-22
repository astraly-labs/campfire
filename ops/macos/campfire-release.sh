#!/bin/sh
set -eu
unset CDPATH

fail() {
  echo "Campfire release switch failed: $*" >&2
  exit 78
}

usage() {
  echo "usage: $0 promote /absolute/current /absolute/release" >&2
  echo "       $0 rollback /absolute/current" >&2
  exit 64
}

[ "$#" -ge 2 ] || usage
campfire_action=$1
campfire_current=$2
case "$campfire_current" in
  /*) ;;
  *) fail "current symlink path must be absolute" ;;
esac

campfire_parent=$(dirname "$campfire_current")
[ -d "$campfire_parent" ] || fail "current symlink parent does not exist"
campfire_previous="$campfire_current.previous"
campfire_release_root="$campfire_parent/releases"
[ -d "$campfire_release_root" ] || fail "release root does not exist: $campfire_release_root"
campfire_release_root=$(cd -- "$campfire_release_root" && pwd -P)

resolve_release() {
  campfire_candidate=$1
  case "$campfire_candidate" in
    /*) ;;
    *) fail "release path must be absolute" ;;
  esac
  [ -d "$campfire_candidate" ] || fail "release directory not found: $campfire_candidate"
  [ -f "$campfire_candidate/apps/server/dist/bin.mjs" ] || fail "release is not built: $campfire_candidate"
  campfire_candidate=$(cd -- "$campfire_candidate" && pwd -P)
  [ "$(dirname "$campfire_candidate")" = "$campfire_release_root" ] ||
    fail "release must be a direct child of $campfire_release_root"
  printf '%s\n' "$campfire_candidate"
}

switch_release() {
  campfire_target=$(resolve_release "$1")
  if [ -e "$campfire_current" ] && [ ! -L "$campfire_current" ]; then
    fail "current exists and is not a symbolic link"
  fi

  campfire_old_target=
  if [ -L "$campfire_current" ]; then
    campfire_old_target=$(readlink "$campfire_current")
    [ "$campfire_old_target" != "$campfire_target" ] || fail "release is already current"
  fi

  campfire_current_tmp="$campfire_parent/.campfire-current.$$"
  campfire_previous_tmp="$campfire_parent/.campfire-previous.$$"
  cleanup() {
    rm -f "$campfire_current_tmp" "$campfire_previous_tmp"
  }
  trap cleanup EXIT HUP INT TERM

  if [ -n "$campfire_old_target" ]; then
    ln -s "$campfire_old_target" "$campfire_previous_tmp"
    /bin/mv -fh "$campfire_previous_tmp" "$campfire_previous"
  fi
  ln -s "$campfire_target" "$campfire_current_tmp"
  /bin/mv -fh "$campfire_current_tmp" "$campfire_current"
  trap - EXIT HUP INT TERM
  cleanup

  printf '{"status":"switched","current":"%s","release":"%s","previous":"%s"}\n' \
    "$campfire_current" "$campfire_target" "${campfire_old_target:-}"
}

case "$campfire_action" in
  promote)
    [ "$#" -eq 3 ] || usage
    switch_release "$3"
    ;;
  rollback)
    [ "$#" -eq 2 ] || usage
    [ -L "$campfire_previous" ] || fail "no previous release is recorded"
    switch_release "$(readlink "$campfire_previous")"
    ;;
  *) usage ;;
esac
