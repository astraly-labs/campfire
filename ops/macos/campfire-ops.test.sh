#!/bin/sh
set -eu
unset CDPATH

campfire_repo_root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
campfire_fixture=$(mktemp -d "${TMPDIR:-/tmp}/campfire-ops.XXXXXX")
cleanup() {
  rm -rf "$campfire_fixture"
}
trap cleanup EXIT HUP INT TERM

fail() {
  echo "campfire ops test failed: $*" >&2
  exit 1
}

expect_failure() {
  if "$@" >"$campfire_fixture/unexpected.stdout" 2>"$campfire_fixture/unexpected.stderr"; then
    fail "command unexpectedly passed: $*"
  fi
}

campfire_real_node=$(command -v node)
export CAMPFIRE_TEST_REAL_NODE="$campfire_real_node"
write_fake_node() {
  campfire_fake_path=$1
  campfire_fake_version=$2
  campfire_fake_tos=$3
  cat >"$campfire_fake_path" <<EOF
#!/bin/sh
if [ "\${1:-}" = "-p" ]; then
  case "\${2:-}" in
    *setTypeOfService*) echo $campfire_fake_tos ;;
    *) echo $campfire_fake_version ;;
  esac
  exit 0
fi
exec "\$CAMPFIRE_TEST_REAL_NODE" "\$@"
EOF
  chmod 700 "$campfire_fake_path"
}
campfire_fake_node24="$campfire_fixture/node24"
campfire_fake_node24_tos="$campfire_fixture/node24-tos"
campfire_fake_node25="$campfire_fixture/node25"
write_fake_node "$campfire_fake_node24" 24.14.1 undefined
write_fake_node "$campfire_fake_node24_tos" 24.18.0 function
write_fake_node "$campfire_fake_node25" 25.8.2 undefined

campfire_service_root="$campfire_fixture/service"
campfire_release_a="$campfire_service_root/releases/a"
campfire_release_b="$campfire_service_root/releases/b"
mkdir -p "$campfire_release_a/apps/server/dist" "$campfire_release_b/apps/server/dist"
: >"$campfire_release_a/apps/server/dist/bin.mjs"
: >"$campfire_release_b/apps/server/dist/bin.mjs"
campfire_release_a_real=$(cd -- "$campfire_release_a" && pwd -P)
campfire_release_b_real=$(cd -- "$campfire_release_b" && pwd -P)

campfire_env_file="$campfire_fixture/server.env"
write_env() {
  campfire_deployment=$1
  campfire_node=$2
  campfire_home=$3
  campfire_production_home=$4
  campfire_backend_port=$5
  campfire_serve_port=$6
  campfire_redirect=$7
  cat >"$campfire_env_file" <<EOF
CAMPFIRE_DEPLOYMENT='$campfire_deployment'
CAMPFIRE_RELEASE='$campfire_release_a'
CAMPFIRE_NODE='$campfire_node'
CAMPFIRE_PRODUCTION_HOME='$campfire_production_home'
T3CODE_HOME='$campfire_home'
T3CODE_PORT='$campfire_backend_port'
T3CODE_TAILSCALE_SERVE_PORT='$campfire_serve_port'
T3CODE_GOOGLE_OIDC_CLIENT_ID='fixture.apps.googleusercontent.com'
T3CODE_GOOGLE_OIDC_CLIENT_SECRET='fixture-secret-never-logged'
T3CODE_GOOGLE_OIDC_REDIRECT_URI='$campfire_redirect'
T3CODE_GOOGLE_OIDC_ALLOWED_EMAILS='alice@example.com,bob@example.com'
EOF
  chmod 600 "$campfire_env_file"
}

campfire_production_home="$campfire_fixture/data/production"
campfire_staging_home="$campfire_fixture/data/staging"
write_env production "$campfire_fake_node24" "$campfire_production_home" \
  "$campfire_production_home" 3773 443 \
  'https://fixture.tail000000.ts.net/auth/google/callback'
"$campfire_repo_root/ops/macos/campfire-preflight.sh" "$campfire_env_file" >/dev/null

chmod 644 "$campfire_env_file"
expect_failure "$campfire_repo_root/ops/macos/campfire-preflight.sh" "$campfire_env_file"

write_env production "$campfire_fake_node25" "$campfire_production_home" \
  "$campfire_production_home" 3773 443 \
  'https://fixture.tail000000.ts.net/auth/google/callback'
expect_failure "$campfire_repo_root/ops/macos/campfire-preflight.sh" "$campfire_env_file"

write_env production "$campfire_fake_node24_tos" "$campfire_production_home" \
  "$campfire_production_home" 3773 443 \
  'https://fixture.tail000000.ts.net/auth/google/callback'
expect_failure "$campfire_repo_root/ops/macos/campfire-preflight.sh" "$campfire_env_file"
grep -q "setTypeOfService" "$campfire_fixture/unexpected.stderr" ||
  fail "preflight rejected Node 24.18.0 for a reason other than setTypeOfService"

write_env staging "$campfire_fake_node24" "$campfire_production_home" \
  "$campfire_production_home" 3774 10000 \
  'https://fixture.tail000000.ts.net:10000/auth/google/callback'
expect_failure "$campfire_repo_root/ops/macos/campfire-preflight.sh" "$campfire_env_file"

write_env staging "$campfire_fake_node24" "$campfire_fixture/data/staging/../production" \
  "$campfire_production_home" 3774 10000 \
  'https://fixture.tail000000.ts.net:10000/auth/google/callback'
expect_failure "$campfire_repo_root/ops/macos/campfire-preflight.sh" "$campfire_env_file"

write_env staging "$campfire_fake_node24" "$campfire_staging_home" \
  "$campfire_production_home" 3774 10000 \
  'https://fixture.tail000000.ts.net:10001/auth/google/callback'
expect_failure "$campfire_repo_root/ops/macos/campfire-preflight.sh" "$campfire_env_file"

write_env staging "$campfire_fake_node24" "$campfire_staging_home" \
  "$campfire_production_home" 3774 10000 \
  'https://fixture.tail000000.ts.net:10000/auth/google/callback'
"$campfire_repo_root/ops/macos/campfire-preflight.sh" "$campfire_env_file" >/dev/null

sed -i '' \
  "s/alice@example.com,bob@example.com/alice@example.com,bob@example.com,carol@example.com,dave@example.com,eve@example.com,frank@example.com/" \
  "$campfire_env_file"
"$campfire_repo_root/ops/macos/campfire-preflight.sh" "$campfire_env_file" >/dev/null
sed -i '' 's/frank@example.com/frank@example.com,grace@example.com/' "$campfire_env_file"
expect_failure "$campfire_repo_root/ops/macos/campfire-preflight.sh" "$campfire_env_file"

campfire_current="$campfire_service_root/current"
ln -s "$campfire_release_a" "$campfire_current"
campfire_outside_release="$campfire_fixture/outside-release"
mkdir -p "$campfire_outside_release/apps/server/dist"
: >"$campfire_outside_release/apps/server/dist/bin.mjs"
expect_failure "$campfire_repo_root/ops/macos/campfire-release.sh" promote \
  "$campfire_current" "$campfire_outside_release"
"$campfire_repo_root/ops/macos/campfire-release.sh" promote \
  "$campfire_current" "$campfire_release_b" >/dev/null
[ "$(readlink "$campfire_current")" = "$campfire_release_b_real" ] || fail "promotion target mismatch"
[ "$(readlink "$campfire_current.previous")" = "$campfire_release_a" ] || \
  fail "previous release was not preserved"
"$campfire_repo_root/ops/macos/campfire-release.sh" rollback "$campfire_current" >/dev/null
[ "$(readlink "$campfire_current")" = "$campfire_release_a_real" ] || fail "rollback target mismatch"
[ "$(readlink "$campfire_current.previous")" = "$campfire_release_b_real" ] || \
  fail "rollback did not preserve the replaced release"

campfire_backup_home="$campfire_fixture/backup-source"
campfire_backup_dir="$campfire_fixture/backups"
mkdir -p "$campfire_backup_home/userdata/runtime" "$campfire_backup_home/worktrees/thread-a"
sqlite3 "$campfire_backup_home/userdata/state.sqlite" \
  'CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ("durable");'
echo runtime >"$campfire_backup_home/userdata/runtime/state.txt"
echo worktree >"$campfire_backup_home/worktrees/thread-a/proof.txt"
campfire_archive=$("$campfire_repo_root/ops/macos/campfire-backup.sh" \
  "$campfire_backup_home" "$campfire_backup_dir")
campfire_restore="$campfire_fixture/restore"
"$campfire_repo_root/ops/macos/campfire-restore.sh" \
  "$campfire_archive" "$campfire_restore" >/dev/null
[ "$(sqlite3 "$campfire_restore/userdata/state.sqlite" 'PRAGMA integrity_check;')" = "ok" ] || \
  fail "restored database integrity failed"
[ "$(sqlite3 "$campfire_restore/userdata/state.sqlite" 'SELECT value FROM proof;')" = "durable" ] || \
  fail "restored database content mismatch"
[ -f "$campfire_restore/worktrees/thread-a/proof.txt" ] || fail "worktree backup missing"

campfire_maintenance_home="$campfire_fixture/maintenance-home"
campfire_maintenance_running="$campfire_maintenance_home/worktrees/project/running"
campfire_maintenance_live="$campfire_maintenance_home/worktrees/project/live"
campfire_maintenance_idle="$campfire_maintenance_home/worktrees/project/idle"
campfire_maintenance_source="$campfire_fixture/maintenance-source"
campfire_maintenance_orphan="$campfire_maintenance_home/worktrees/project/orphan"
campfire_maintenance_dirty="$campfire_maintenance_home/worktrees/project/dirty"
campfire_maintenance_hung_head="$campfire_maintenance_home/worktrees/project/hung-head"
campfire_maintenance_hung_status="$campfire_maintenance_home/worktrees/project/hung-status"
campfire_maintenance_bin="$campfire_fixture/maintenance-bin"
mkdir -p \
  "$campfire_maintenance_home/userdata" \
  "$campfire_maintenance_running/target" \
  "$campfire_maintenance_live/target" \
  "$campfire_maintenance_idle/target" \
  "$campfire_maintenance_bin"
echo running >"$campfire_maintenance_running/target/proof.txt"
echo live >"$campfire_maintenance_live/target/proof.txt"
echo idle >"$campfire_maintenance_idle/target/proof.txt"
cat >"$campfire_maintenance_bin/cargo" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod 700 "$campfire_maintenance_bin/cargo"
# A git that wedges in two worktrees, like the one that stalled a staging pass for hours.
# The HEAD read also ignores TERM, as a git stuck in an uninterruptible read would.
campfire_real_git=$(command -v git)
export CAMPFIRE_TEST_REAL_GIT="$campfire_real_git"
cat >"$campfire_maintenance_bin/git" <<'EOF'
#!/bin/sh
case "${2:-}:${3:-}" in
  */hung-head:symbolic-ref) trap '' TERM; sleep 10; exit 0 ;;
  */hung-status:status) exec sleep 10 ;;
esac
exec "$CAMPFIRE_TEST_REAL_GIT" "$@"
EOF
chmod 700 "$campfire_maintenance_bin/git"
# The V1 database is frozen after the V2 import and no longer sees live work.
sqlite3 "$campfire_maintenance_home/userdata/state.sqlite" <<EOF
CREATE TABLE projection_threads (
  thread_id TEXT PRIMARY KEY,
  worktree_path TEXT,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE projection_turns (
  row_id INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL,
  state TEXT NOT NULL
);
CREATE TABLE provider_session_runtime (
  thread_id TEXT PRIMARY KEY,
  status TEXT NOT NULL
);
INSERT INTO projection_threads VALUES
  ('running', '$campfire_maintenance_running', '2026-01-01T00:00:00.000Z', NULL),
  ('live', '$campfire_maintenance_live', '2026-01-01T00:00:00.000Z', NULL),
  ('idle', '$campfire_maintenance_idle', '2026-01-01T00:00:00.000Z', NULL);
INSERT INTO projection_turns VALUES
  (1, 'running', 'completed'),
  (2, 'live', 'completed'),
  (3, 'idle', 'completed');
EOF
sqlite3 "$campfire_maintenance_home/userdata/statev2.sqlite" <<EOF
CREATE TABLE orchestration_v2_projection_threads (
  thread_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  payload_json TEXT NOT NULL
);
CREATE TABLE orchestration_v2_projection_runs (
  run_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE orchestration_v2_projection_provider_sessions (
  provider_session_id TEXT PRIMARY KEY,
  status TEXT NOT NULL
);
CREATE TABLE orchestration_v2_projection_provider_session_bindings (
  provider_session_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  PRIMARY KEY (provider_session_id, thread_id)
);
INSERT INTO orchestration_v2_projection_threads VALUES
  ('running', '2026-01-01T00:00:00.000Z', NULL,
    json_object('worktreePath', '$campfire_maintenance_running')),
  ('live', '2026-01-01T00:00:00.000Z', NULL,
    json_object('worktreePath', '$campfire_maintenance_live')),
  ('idle', '2026-01-01T00:00:00.000Z', NULL,
    json_object('worktreePath', '$campfire_maintenance_idle'));
INSERT INTO orchestration_v2_projection_runs VALUES
  ('run-running', 'running', 'running', '{}'),
  ('run-live', 'live', 'completed', '{}'),
  ('run-idle', 'idle', 'completed', '{}');
INSERT INTO orchestration_v2_projection_provider_sessions VALUES
  ('session-live', 'ready'),
  ('session-idle', 'stopped');
INSERT INTO orchestration_v2_projection_provider_session_bindings VALUES
  ('session-live', 'live'),
  ('session-idle', 'idle');
EOF
git init -q "$campfire_maintenance_source"
git -C "$campfire_maintenance_source" config user.name fixture
git -C "$campfire_maintenance_source" config user.email fixture@example.com
echo fixture >"$campfire_maintenance_source/proof.txt"
git -C "$campfire_maintenance_source" add proof.txt
git -C "$campfire_maintenance_source" commit -qm fixture
git -C "$campfire_maintenance_source" worktree add -qb orphan "$campfire_maintenance_orphan"
git -C "$campfire_maintenance_source" worktree add -qb dirty "$campfire_maintenance_dirty"
git -C "$campfire_maintenance_source" worktree add -qb hung-head "$campfire_maintenance_hung_head"
git -C "$campfire_maintenance_source" worktree add -qb hung-status "$campfire_maintenance_hung_status"
echo dirty >"$campfire_maintenance_dirty/untracked.txt"

PATH="$campfire_maintenance_bin:$PATH" CAMPFIRE_WORKTREE_GIT_TIMEOUT_SECONDS=1 \
  "$campfire_repo_root/ops/macos/campfire-worktree-maintenance.sh" \
  "$campfire_maintenance_home" 0 --dry-run >/dev/null 2>&1
[ -f "$campfire_maintenance_running/target/proof.txt" ] || fail "dry-run cleaned running target"
[ -f "$campfire_maintenance_idle/target/proof.txt" ] || fail "dry-run cleaned idle target"
[ -d "$campfire_maintenance_orphan" ] || fail "dry-run removed orphan worktree"

campfire_maintenance_started=$(date +%s)
PATH="$campfire_maintenance_bin:$PATH" CAMPFIRE_WORKTREE_GIT_TIMEOUT_SECONDS=1 \
  "$campfire_repo_root/ops/macos/campfire-worktree-maintenance.sh" \
  "$campfire_maintenance_home" 0 >"$campfire_fixture/maintenance.stdout" 2>&1
[ $(($(date +%s) - campfire_maintenance_started)) -lt 8 ] ||
  fail "maintenance waited on a wedged git past its timeout"
[ -f "$campfire_maintenance_running/target/proof.txt" ] || fail "target of a running turn was cleaned"
[ -f "$campfire_maintenance_live/target/proof.txt" ] || fail "target of a live provider session was cleaned"
[ ! -e "$campfire_maintenance_idle/target" ] || fail "idle target was not cleaned"
[ ! -e "$campfire_maintenance_orphan" ] || fail "clean orphan worktree was not removed"
[ -d "$campfire_maintenance_dirty" ] || fail "dirty orphan worktree was removed"
[ -d "$campfire_maintenance_hung_head" ] || fail "worktree with a wedged HEAD read was removed"
[ -d "$campfire_maintenance_hung_status" ] || fail "worktree with a wedged status was removed"
grep -q '"skippedUnresponsive":2' "$campfire_fixture/maintenance.stdout" ||
  fail "summary does not count the two wedged worktrees"

expect_failure sh "$campfire_repo_root/scripts/campfire-soak.sh" 0
plutil -lint "$campfire_repo_root/ops/macos/com.campfire.server.plist.example" >/dev/null
plutil -lint "$campfire_repo_root/ops/macos/com.campfire.provider-host.plist.example" >/dev/null
plutil -lint "$campfire_repo_root/ops/macos/com.campfire.worktree-maintenance.plist.example" >/dev/null
sh -n "$campfire_repo_root/ops/macos/campfire-preflight.sh"
sh -n "$campfire_repo_root/ops/macos/campfire-package-release.sh"
sh -n "$campfire_repo_root/ops/macos/campfire-release.sh"
sh -n "$campfire_repo_root/ops/macos/run-campfire.sh"
sh -n "$campfire_repo_root/ops/macos/run-campfire-provider-host.sh"
sh -n "$campfire_repo_root/ops/macos/campfire-backup.sh"
sh -n "$campfire_repo_root/ops/macos/campfire-restore.sh"
sh -n "$campfire_repo_root/ops/macos/campfire-worktree-maintenance.sh"
sh -n "$campfire_repo_root/scripts/campfire-soak.sh"

echo "campfire ops fixtures passed"
