#!/bin/sh
set -eu
unset CDPATH

fail() {
  echo "Campfire release packaging failed: $*" >&2
  exit 78
}

if [ "$#" -ne 3 ]; then
  echo "usage: $0 /absolute/repository /absolute/release-root git-ref" >&2
  exit 64
fi

campfire_repo=$1
campfire_release_root=$2
campfire_ref=$3
case "$campfire_repo:$campfire_release_root" in
  /*:/*) ;;
  *) fail "repository and release root paths must be absolute" ;;
esac
[ -d "$campfire_repo/.git" ] || fail "repository is not a Git checkout: $campfire_repo"
[ -d "$campfire_release_root" ] || fail "release root does not exist: $campfire_release_root"
[ ! -L "$campfire_release_root" ] || fail "release root must not be a symbolic link"

campfire_repo=$(cd -- "$campfire_repo" && pwd -P)
campfire_release_root=$(cd -- "$campfire_release_root" && pwd -P)
campfire_commit=$(git -C "$campfire_repo" rev-parse --verify "$campfire_ref^{commit}" 2>/dev/null) ||
  fail "Git ref does not resolve to a commit: $campfire_ref"
case "$campfire_commit" in
  *[!0-9a-f]*) fail "resolved commit is malformed" ;;
esac
[ "${#campfire_commit}" -eq 40 ] || fail "resolved commit is malformed"
campfire_destination="$campfire_release_root/$campfire_commit"
[ ! -e "$campfire_destination" ] || fail "release already exists: $campfire_destination"

# Build output may be ignored, but all tracked and untracked build inputs must match the selected
# commit. Documentation and ops changes do not affect the Web/server artifact.
campfire_build_paths='apps packages package.json pnpm-lock.yaml pnpm-workspace.yaml vite.config.ts vite-plus.config.ts'
# shellcheck disable=SC2086
git -C "$campfire_repo" diff --quiet "$campfire_commit" -- $campfire_build_paths ||
  fail "tracked build inputs do not match $campfire_commit"
# shellcheck disable=SC2086
campfire_untracked=$(git -C "$campfire_repo" ls-files --others --exclude-standard -- $campfire_build_paths)
[ -z "$campfire_untracked" ] || fail "untracked build inputs are present"

campfire_node=${CAMPFIRE_NODE:-/opt/homebrew/opt/node@24/bin/node}
[ -x "$campfire_node" ] || fail "CAMPFIRE_NODE is not executable: $campfire_node"
campfire_node_version=$("$campfire_node" -p 'process.versions.node')
campfire_node_major=${campfire_node_version%%.*}
campfire_node_rest=${campfire_node_version#*.}
campfire_node_minor=${campfire_node_rest%%.*}
campfire_node_patch=${campfire_node_rest#*.}
if [ "$campfire_node_major" -ne 24 ] || [ "$campfire_node_minor" -lt 13 ] ||
  { [ "$campfire_node_minor" -eq 13 ] && [ "$campfire_node_patch" -lt 1 ]; }; then
  fail "Node 24.13.1 or newer within major 24 is required (found $campfire_node_version)"
fi

campfire_node_prefix=$(cd -- "$(dirname -- "$campfire_node")/.." && pwd -P)
campfire_corepack="$campfire_node_prefix/lib/node_modules/corepack/dist/corepack.js"
[ -f "$campfire_corepack" ] || fail "Corepack was not found beside CAMPFIRE_NODE"
campfire_vp="$campfire_repo/node_modules/vite-plus/bin/vp"
[ -f "$campfire_vp" ] || fail "Vite+ is not installed in the source checkout"

campfire_stage=$(mktemp -d "$campfire_release_root/.campfire-release.XXXXXX")
campfire_tools=$(mktemp -d "$campfire_release_root/.campfire-tools.XXXXXX")
cleanup() {
  if [ -d "$campfire_stage" ]; then
    chmod -R u+w "$campfire_stage" 2>/dev/null || true
    rm -rf "$campfire_stage"
  fi
  rm -rf "$campfire_tools"
}
trap cleanup EXIT HUP INT TERM

ln -s "$campfire_node" "$campfire_tools/node"
"$campfire_node" "$campfire_corepack" enable --install-directory "$campfire_tools"
campfire_pnpm="$campfire_tools/pnpm"
[ -x "$campfire_pnpm" ] || fail "Corepack did not create a pnpm shim"
campfire_pnpm_version=$(PATH="$campfire_tools:$PATH" "$campfire_pnpm" --version)

(
  cd "$campfire_repo"
  PATH="$campfire_tools:$PATH" "$campfire_pnpm" install --frozen-lockfile
  PATH="$campfire_tools:$PATH" "$campfire_node" "$campfire_vp" run \
    --filter @t3tools/web --filter t3 build
  mkdir -p "$campfire_stage/apps"
  PATH="$campfire_tools:$PATH" "$campfire_pnpm" --filter t3 deploy --prod --legacy \
    "$campfire_stage/apps/server"
)

# pnpm's legacy deploy leaves a workspace self-link back to the source checkout. It is not a
# runtime dependency and would make the artifact appear standalone while retaining ambient access
# to the mutable repository.
rm -f "$campfire_stage/apps/server/node_modules/.pnpm/node_modules/t3"

campfire_ops_archive="$campfire_tools/ops.tar"
git -C "$campfire_repo" archive --format=tar -o "$campfire_ops_archive" \
  "$campfire_commit" ops/macos
tar -C "$campfire_stage" -xf "$campfire_ops_archive"

"$campfire_node" "$campfire_stage/apps/server/dist/bin.mjs" --help >/dev/null
# shellcheck disable=SC2016
campfire_internal_symlink_count=$("$campfire_node" -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const root = fs.realpathSync(process.argv[1]);
  let links = 0;
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    links += 1;
    const item = path.join(entry.parentPath, entry.name);
    let target;
    try { target = fs.realpathSync(item); }
    catch { throw new Error(`broken release symlink: ${item}`); }
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`release symlink escapes artifact: ${item} -> ${target}`);
    }
  }
  process.stdout.write(String(links));
' "$campfire_stage")
campfire_bin_checksum=$(shasum -a 256 "$campfire_stage/apps/server/dist/bin.mjs" | awk '{ print $1 }')
campfire_lock_checksum=$(git -C "$campfire_repo" show "$campfire_commit:pnpm-lock.yaml" | \
  shasum -a 256 | awk '{ print $1 }')
campfire_built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat >"$campfire_stage/release-manifest.json" <<EOF
{"commit":"$campfire_commit","builtAt":"$campfire_built_at","nodeVersion":"$campfire_node_version","pnpmVersion":"$campfire_pnpm_version","internalSymlinkCount":$campfire_internal_symlink_count,"serverBinSha256":"$campfire_bin_checksum","lockfileSha256":"$campfire_lock_checksum"}
EOF

chmod -R a-w "$campfire_stage"
mv "$campfire_stage" "$campfire_destination"
trap - EXIT HUP INT TERM
rm -rf "$campfire_tools"

printf '{"status":"packaged","commit":"%s","release":"%s","nodeVersion":"%s","pnpmVersion":"%s"}\n' \
  "$campfire_commit" "$campfire_destination" "$campfire_node_version" "$campfire_pnpm_version"
