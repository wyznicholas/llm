#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ARM_BUILD="$SCRIPT_DIR/arm-build.sh"
FIXTURE=$(mktemp -d "${TMPDIR:-/tmp}/ombl-arm-build-test.XXXXXX")
REPO="$FIXTURE/chat"
CACHE="$FIXTURE/cache"

cleanup() {
  rm -rf "$FIXTURE"
}
trap cleanup EXIT

fail() {
  echo "arm-build.test: FAIL: $*" >&2
  exit 1
}

mkdir -p "$REPO/packages/ui/src" "$REPO/node_modules/@x" "$REPO/node_modules/dep" "$REPO/node_modules/.vite"
git -C "$REPO" init -q
git -C "$REPO" config user.email fixture@example.test
git -C "$REPO" config user.name "Fixture User"

cat > "$REPO/package.json" <<'JSON'
{
  "name": "fixture-root",
  "private": true,
  "workspaces": ["packages/*"],
  "dependencies": {"@x/ui": "workspace:*"}
}
JSON
cat > "$REPO/bun.lock" <<'JSON'
{
  "workspaces": {
    "": {"name": "fixture-root",},
    "packages/ui": {"name": "@x/ui",},
  },
}
JSON
cat > "$REPO/packages/ui/package.json" <<'JSON'
{
  "name": "@x/ui",
  "exports": {"./a": "./src/a.js"}
}
JSON
cat > "$REPO/packages/ui/src/a.js" <<'JS'
module.exports = "commit-a";
JS
git -C "$REPO" add package.json bun.lock packages
git -C "$REPO" commit -qm "commit A"
COMMIT_A=$(git -C "$REPO" rev-parse HEAD)

cat > "$REPO/packages/ui/src/a.js" <<'JS'
module.exports = "commit-b";
JS
git -C "$REPO" add packages/ui/src/a.js
git -C "$REPO" commit -qm "commit B"
COMMIT_B=$(git -C "$REPO" rev-parse HEAD)

ln -s ../../packages/ui "$REPO/node_modules/@x/ui"
cat > "$REPO/node_modules/dep/index.js" <<'JS'
module.exports = "shared dependency";
JS
mkdir -p "$REPO/packages/ui/node_modules/nested-dep"
cat > "$REPO/packages/ui/node_modules/nested-dep/index.js" <<'JS'
module.exports = "nested dependency";
JS
touch "$REPO/node_modules/.vite/shared-cache-marker"

OLD_WT="$FIXTURE/old-wt"
git -C "$REPO" worktree add -q --detach "$OLD_WT" "$COMMIT_A"
ln -s "$REPO/node_modules" "$OLD_WT/node_modules"
set +e
OMBL_CHAT="$REPO" OMBL_ASSERT_SKIP_VITE=1 \
  bash "$ARM_BUILD" assert "$OLD_WT" "$COMMIT_A" --json "$FIXTURE/old.json"
OLD_RC=$?
set -e
[ "$OLD_RC" -eq 3 ] || fail "old-layout assertion returned $OLD_RC, expected 3"
node - "$FIXTURE/old.json" "$OLD_WT" <<'JS'
const fs = require("node:fs");
const [file] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(file, "utf8"));
const workspace = result.workspacePackages[0];
if (result.status !== "fail") throw new Error(`old status was ${result.status}`);
if (workspace.node.packageRoot.startsWith(`${result.worktree}/`)) throw new Error("old package root is inside worktree");
if (workspace.tree.mismatches < 1) throw new Error("old tree unexpectedly matched");
JS
git -C "$REPO" worktree remove --force "$OLD_WT"

NEW_WT="$FIXTURE/new-wt"
git -C "$REPO" worktree add -q --detach "$NEW_WT" "$COMMIT_A"
LC_ALL=C ls -laR "$REPO/node_modules" > "$FIXTURE/node-modules.before"
OMBL_CHAT="$REPO" bash "$ARM_BUILD" overlay "$NEW_WT" "$COMMIT_A"
OMBL_CHAT="$REPO" OMBL_ASSERT_SKIP_VITE=1 \
  bash "$ARM_BUILD" assert "$NEW_WT" "$COMMIT_A" --json "$FIXTURE/new.json"
[ -d "$NEW_WT/node_modules" ] && [ ! -L "$NEW_WT/node_modules" ] || fail "overlay node_modules is not local"
[ ! -e "$NEW_WT/node_modules/.vite" ] && [ ! -L "$NEW_WT/node_modules/.vite" ] || fail ".vite leaked into overlay"
[ ! -e "$NEW_WT/packages/ui/node_modules/@x/ui" ] && [ ! -L "$NEW_WT/packages/ui/node_modules/@x/ui" ] || \
  fail "nested overlay created a workspace self-link absent from the shared nested install"
node -e "require.resolve('dep', { paths: [process.argv[1]] })" "$NEW_WT" || fail "dep is not resolvable"
LC_ALL=C ls -laR "$REPO/node_modules" > "$FIXTURE/node-modules.after"
cmp "$FIXTURE/node-modules.before" "$FIXTURE/node-modules.after" || fail "shared node_modules changed"
node - "$FIXTURE/new.json" "$NEW_WT" <<'JS'
const fs = require("node:fs");
const [file] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(file, "utf8"));
const workspace = result.workspacePackages[0];
if (result.status !== "pass-no-vite") throw new Error(`new status was ${result.status}`);
if (!result.nodeModulesIsLocalDir) throw new Error("new node_modules was not local");
if (workspace.node.packageRoot !== `${result.worktree}/packages/ui`) throw new Error(`wrong package root: ${workspace.node.packageRoot}`);
if (workspace.tree.mismatches !== 0) throw new Error("new tree did not match");
JS
git -C "$REPO" worktree remove --force "$NEW_WT"

MANIFEST_STDOUT="$FIXTURE/manifest-failure.stdout"
set +e
OMBL_CHAT="$REPO" OMBL_BASE_CACHE="$CACHE" OMBL_TEST_FAIL_MANIFEST=1 \
  bash "$ARM_BUILD" base-dist "$COMMIT_A" > "$MANIFEST_STDOUT"
MANIFEST_RC=$?
set -e
[ "$MANIFEST_RC" -ne 0 ] || fail "manifest failure unexpectedly passed in base-dist"
[ ! -s "$MANIFEST_STDOUT" ] || fail "manifest failure wrote to stdout"
[ ! -e "$CACHE/$COMMIT_A/.ombl-ready" ] || fail "manifest failure left a ready marker"
FAILED_MANIFEST_SLOT=$(find "$CACHE" -mindepth 1 -maxdepth 1 -type d -name "$COMMIT_A.FAILED-build-*" -print -quit)
[ -n "$FAILED_MANIFEST_SLOT" ] || fail "manifest failure did not leave a FAILED-build slot"
[ ! -e "$FAILED_MANIFEST_SLOT/.ombl-ready" ] || fail "failed manifest slot contains a ready marker"

cat > "$REPO/bun.lock" <<'JSON'
{
  "workspaces": {
    "": {"name": "fixture-root",},
    "packages/not-ui": {"name": "@x/ui",},
  },
}
JSON
git -C "$REPO" add bun.lock
git -C "$REPO" commit -qm "mismatched lock"
COMMIT_MISMATCH=$(git -C "$REPO" rev-parse HEAD)
git -C "$REPO" checkout -q --detach "$COMMIT_B"
MISMATCH_WT="$FIXTURE/mismatch-wt"
git -C "$REPO" worktree add -q --detach "$MISMATCH_WT" "$COMMIT_MISMATCH"
set +e
OMBL_CHAT="$REPO" bash "$ARM_BUILD" overlay "$MISMATCH_WT" "$COMMIT_MISMATCH" >/dev/null 2>&1
MISMATCH_RC=$?
set -e
[ "$MISMATCH_RC" -ne 0 ] || fail "bun.lock mismatch unexpectedly passed"
git -C "$REPO" worktree remove --force "$MISMATCH_WT"

SHA=0123456789abcdef0123456789abcdef01234567
mkdir -p "$CACHE/$SHA.WRONG-chat-ui-1" "$CACHE/$SHA.FAILED-build-1"
touch -t 202001010000 "$CACHE/$SHA.WRONG-chat-ui-1" "$CACHE/$SHA.FAILED-build-1"
OMBL_CHAT="$REPO" OMBL_BASE_CACHE="$CACHE" bash "$ARM_BUILD" gc >/dev/null
[ -d "$CACHE/$SHA.WRONG-chat-ui-1" ] || fail "gc removed quarantined WRONG slot"
[ ! -e "$CACHE/$SHA.FAILED-build-1" ] || fail "gc did not remove eligible FAILED slot"

echo "arm-build.test: PASS"
