#!/bin/bash
set -euo pipefail

OMBL_SCRIPTS="${OMBL_SCRIPTS:-$HOME/.claude/skills/om-bug-loop/scripts}"
OMBL_BASE_CACHE="${OMBL_BASE_CACHE:-$HOME/.claude/om-bug-loop/base-dist}"
OMBL_CHAT="${OMBL_CHAT:-$HOME/Documents/GitlabRepos/openmarket-chat}"
HELPER="$OMBL_SCRIPTS/arm-build-helper.mjs"
LOCK_DIR=""
TEMP_FILES=()
WS_NAMES=()
WS_DIRS=()
external_links=0
workspace_links=0
overlay_dirs=0

cleanup() {
  local temporary
  for temporary in "${TEMP_FILES[@]:-}"; do
    [ -n "$temporary" ] && rm -f "$temporary"
  done
  if [ -n "$LOCK_DIR" ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

die() {
  echo "$*" >&2
  exit 2
}

new_temp() {
  NEW_TEMP=$(mktemp "${TMPDIR:-/tmp}/ombl-arm-build.XXXXXX") || return 1
  TEMP_FILES+=("$NEW_TEMP")
}

canonical() {
  node "$HELPER" canonical "$1"
}

ensure_cache_is_safe() {
  local cache chat
  cache=$(canonical "$OMBL_BASE_CACHE") || return 1
  chat=$(canonical "$OMBL_CHAT") || return 1
  case "$cache" in
    "$chat"|"$chat"/*)
      echo "arm-build: refusing cache inside shared checkout: $cache" >&2
      exit 2
      ;;
  esac
  OMBL_BASE_CACHE="$cache"
  OMBL_CHAT="$chat"
}

load_manifest() {
  local repo="$1" commit="$2" output="$3" line name directory lines_file
  [ "${OMBL_TEST_FAIL_MANIFEST:-0}" != "1" ] || return 1
  node "$HELPER" manifest "$repo" "$commit" "$output" || return 1
  new_temp || return 1
  lines_file=$NEW_TEMP
  node "$HELPER" workspace-lines "$output" > "$lines_file" || return 1
  WS_NAMES=()
  WS_DIRS=()
  while IFS=$'\t' read -r name directory; do
    [ -n "$name" ] || continue
    WS_NAMES+=("$name")
    WS_DIRS+=("$directory")
  done < "$lines_file"
}

is_workspace_name() {
  local candidate="$1" index
  for ((index = 0; index < ${#WS_NAMES[@]}; index += 1)); do
    [ "${WS_NAMES[$index]}" = "$candidate" ] && return 0
  done
  return 1
}

scope_has_workspace() {
  local scope="$1" name
  for name in "${WS_NAMES[@]:-}"; do
    case "$name" in
      "$scope"/*) return 0 ;;
    esac
  done
  return 1
}

prepare_overlay_dir() {
  local destination="$1" first
  if [ -L "$destination" ]; then
    unlink "$destination" || return 1
  elif [ -e "$destination" ]; then
    [ -d "$destination" ] || {
      echo "overlay: $destination exists and is not a directory" >&2
      return 1
    }
    first=$(find "$destination" -mindepth 1 -maxdepth 1 -print -quit) || return 1
    [ -z "$first" ] || {
      echo "overlay: $destination exists and is not empty" >&2
      return 1
    }
  fi
  mkdir -p "$destination" || return 1
}

link_external() {
  local source="$1" destination="$2" nested="$3" target
  if [ "$nested" = "1" ]; then
    if ! target=$(/bin/realpath "$source" 2>/dev/null); then
      echo "overlay: warning: skipping dangling nested entry $source" >&2
      return 0
    fi
  else
    target="$source"
  fi
  ln -s "$target" "$destination" || return 1
  external_links=$((external_links + 1))
}

mirror_install() {
  local source_nm="$1" destination_nm="$2" nested="$3"
  local source base destination child child_base package_name index parent relative
  prepare_overlay_dir "$destination_nm" || return 1
  overlay_dirs=$((overlay_dirs + 1))

  shopt -s dotglob nullglob
  for source in "$source_nm"/*; do
    base=${source##*/}
    case "$base" in
      .vite|.vite-temp|.cache|.tmp|.old_modules-*) continue ;;
    esac
    if is_workspace_name "$base"; then
      continue
    fi
    destination="$destination_nm/$base"
    if [[ "$base" == @* ]] && [ -d "$source" ] && scope_has_workspace "$base"; then
      mkdir -p "$destination" || return 1
      for child in "$source"/*; do
        child_base=${child##*/}
        package_name="$base/$child_base"
        is_workspace_name "$package_name" && continue
        link_external "$child" "$destination/$child_base" "$nested" || return 1
      done
    else
      link_external "$source" "$destination" "$nested" || return 1
    fi
  done

  for ((index = 0; index < ${#WS_NAMES[@]}; index += 1)); do
    package_name=${WS_NAMES[$index]}
    if [ "$nested" = "1" ] && [ ! -e "$source_nm/$package_name" ] && [ ! -L "$source_nm/$package_name" ]; then
      continue
    fi
    if [[ "$package_name" == */* ]]; then
      parent="$destination_nm/${package_name%%/*}"
      mkdir -p "$parent" || return 1
    else
      parent="$destination_nm"
    fi
    destination="$destination_nm/$package_name"
    relative=$(node "$HELPER" relative "$(dirname "$destination")" "$CURRENT_WT/${WS_DIRS[$index]}") || return 1
    ln -s "$relative" "$destination" || return 1
    workspace_links=$((workspace_links + 1))
  done
}

overlay_main() {
  [ "$#" -eq 2 ] || die "usage: arm-build.sh overlay <wt> <commit>"
  local wt commit manifest index shared_nested names
  OMBL_CHAT=$(canonical "$OMBL_CHAT") || return 1
  wt=$(canonical "$1") || return 1
  commit=$(git -C "$OMBL_CHAT" rev-parse --verify "$2^{commit}" 2>/dev/null) || {
    echo "overlay: unknown commit '$2'" >&2
    return 2
  }
  new_temp || return 1
  manifest=$NEW_TEMP
  load_manifest "$OMBL_CHAT" "$commit" "$manifest" || return 1
  CURRENT_WT="$wt"
  mirror_install "$OMBL_CHAT/node_modules" "$wt/node_modules" 0 || return 1
  for ((index = 0; index < ${#WS_DIRS[@]}; index += 1)); do
    shared_nested="$OMBL_CHAT/${WS_DIRS[$index]}/node_modules"
    if [ -d "$shared_nested" ]; then
      mirror_install "$shared_nested" "$wt/${WS_DIRS[$index]}/node_modules" 1 || return 1
    fi
  done
  if [ "${#WS_NAMES[@]}" -eq 0 ]; then names="<none>"; else names=$(IFS=,; echo "${WS_NAMES[*]}"); fi
  echo "overlay: dirs=$overlay_dirs external_links=$external_links workspace_links=$workspace_links workspaces=$names" >&2
  return 0
}

assert_main() {
  [ "$#" -eq 2 ] || { [ "$#" -eq 4 ] && [ "$3" = "--json" ]; } || \
    die "usage: arm-build.sh assert <wt> <commit> [--json <out>]"
  local wt commit rc
  wt=$(canonical "$1") || return 3
  commit=$(git -C "$wt" rev-parse --verify "$2^{commit}" 2>/dev/null) || {
    echo "assert: unknown commit '$2'" >&2
    return 3
  }
  rc=0
  if [ "$#" -eq 4 ]; then
    node "$HELPER" assert "$wt" "$commit" --json "$4" || rc=$?
  else
    node "$HELPER" assert "$wt" "$commit" || rc=$?
  fi
  [ "$rc" -eq 0 ] || return 3
}

cache_valid() {
  local slot="$1" commit="$2"
  [ -f "$slot/.ombl-ready" ] && node "$HELPER" cache-valid "$slot/BUILD-INFO.json" "$commit"
}

registered_worktree() {
  local wanted="$1" line listed listing
  wanted=$(canonical "$wanted") || return 2
  listing=$(git -C "$OMBL_CHAT" worktree list --porcelain) || return 2
  while IFS= read -r line; do
    case "$line" in
      "worktree "*)
        listed=$(canonical "${line#worktree }") || return 2
        [ "$listed" = "$wanted" ] && return 0
        ;;
    esac
  done <<< "$listing"
  return 1
}

remove_registered_worktree() {
  local wt="$1" rc
  wt=$(canonical "$wt") || return 1
  if registered_worktree "$wt"; then
    echo "arm-build: removing registered worktree $wt" >&2
    git -C "$OMBL_CHAT" worktree remove --force "$wt" >&2 || return 1
  else
    rc=$?
    [ "$rc" -eq 1 ] || return 1
  fi
  return 0
}

quarantine_slot() {
  local slot="$1" label="$2" epoch destination suffix
  epoch=$(date +%s) || return 1
  destination="$slot.$label-$epoch"
  suffix=0
  while [ -e "$destination" ] || [ -L "$destination" ]; do
    suffix=$((suffix + 1))
    destination="$slot.$label-$epoch-$suffix"
  done
  mv "$slot" "$destination" || return 1
  printf '%s\n' "$destination" || return 1
}

base_dist_main() {
  [ "$#" -eq 1 ] || die "usage: arm-build.sh base-dist <commit>"
  ensure_cache_is_safe || return 1
  local requested="$1" full slot lock waited wt quarantined started finished seconds
  local assertion_json assert_rc built_at built_epoch build_info_tmp host
  full=$(git -C "$OMBL_CHAT" rev-parse --verify "$requested^{commit}" 2>/dev/null) || {
    echo "base_dist: unknown commit '$requested'" >&2
    return 2
  }
  slot="$OMBL_BASE_CACHE/$full"
  lock="$slot.lock"
  mkdir -p "$OMBL_BASE_CACHE" || return 1

  if cache_valid "$slot" "$full"; then
    echo "base_dist: cache HIT (verified) $full" >&2
    printf '%s\n' "$slot/dist"
    return 0
  fi

  waited=0
  while ! mkdir "$lock" 2>/dev/null; do
    if cache_valid "$slot" "$full"; then
      echo "base_dist: cache HIT (verified) $full" >&2
      printf '%s\n' "$slot/dist"
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
    if [ "$waited" -ge 900 ]; then
      echo "base_dist: stale lock after 15m: $lock" >&2
      return 1
    fi
  done
  LOCK_DIR="$lock"

  if cache_valid "$slot" "$full"; then
    echo "base_dist: cache HIT (verified) $full" >&2
    printf '%s\n' "$slot/dist"
    return 0
  fi

  if [ -e "$slot" ] || [ -L "$slot" ]; then
    if [ -f "$slot/.ombl-ready" ]; then
      quarantined=$(quarantine_slot "$slot" "UNVERIFIED") || return 1
      echo "base_dist: quarantined legacy/unverified slot as $quarantined" >&2
    else
      remove_registered_worktree "$slot/wt" || return 1
      quarantined=$(quarantine_slot "$slot" "INCOMPLETE") || return 1
      echo "base_dist: quarantined incomplete slot as $quarantined" >&2
    fi
  fi

  echo "base_dist: cache MISS, building $full once for the batch" >&2
  mkdir -p "$slot" || return 1
  wt="$slot/wt"
  if ! git -C "$OMBL_CHAT" worktree add --detach "$wt" "$full" >&2; then
    quarantined=$(quarantine_slot "$slot" "FAILED-build") || return 1
    echo "base_dist: worktree add failed; preserved $quarantined" >&2
    return 1
  fi

  if ! overlay_main "$wt" "$full"; then
    remove_registered_worktree "$wt" || true
    quarantined=$(quarantine_slot "$slot" "FAILED-build") || return 1
    echo "base_dist: overlay failed; preserved $quarantined" >&2
    return 1
  fi

  started=$(date +%s)
  if ! (cd "$wt" && bun run build) >&2; then
    remove_registered_worktree "$wt" || true
    quarantined=$(quarantine_slot "$slot" "FAILED-build") || return 1
    echo "base_dist: build failed; preserved $quarantined" >&2
    return 1
  fi
  finished=$(date +%s)
  seconds=$((finished - started))

  assertion_json="$slot/assert.json"
  unset OMBL_ASSERT_SKIP_VITE
  assert_rc=0
  assert_main "$wt" "$full" --json "$assertion_json" || assert_rc=$?
  if [ "$assert_rc" -ne 0 ]; then
    remove_registered_worktree "$wt" || true
    quarantined=$(quarantine_slot "$slot" "FAILED-assert") || return 1
    echo "base_dist: assertion failed; preserved verdict in $quarantined/assert.json" >&2
    return 3
  fi

  if ! cp -Rc "$wt/dist" "$slot/dist" 2>/dev/null; then
    if ! cp -R "$wt/dist" "$slot/dist"; then
      remove_registered_worktree "$wt" || true
      quarantined=$(quarantine_slot "$slot" "FAILED-build") || return 1
      echo "base_dist: dist copy failed; preserved $quarantined" >&2
      return 1
    fi
  fi

  built_epoch=$(date +%s)
  built_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  host=$(hostname -s)
  build_info_tmp="$slot/BUILD-INFO.json.tmp"
  if ! node "$HELPER" build-info "$build_info_tmp" "$full" "$built_at" "$built_epoch" "$seconds" \
    "$host" "$OMBL_CHAT/node_modules" "$wt" "$assertion_json"; then
    remove_registered_worktree "$wt" || true
    quarantined=$(quarantine_slot "$slot" "FAILED-build") || return 1
    echo "base_dist: build metadata failed; preserved $quarantined" >&2
    return 1
  fi
  if ! mv "$build_info_tmp" "$slot/BUILD-INFO.json"; then
    remove_registered_worktree "$wt" || true
    quarantined=$(quarantine_slot "$slot" "FAILED-build") || return 1
    echo "base_dist: build metadata install failed; preserved $quarantined" >&2
    return 1
  fi

  if ! remove_registered_worktree "$wt" || [ -e "$wt" ]; then
    quarantined=$(quarantine_slot "$slot" "FAILED-build") || return 1
    echo "base_dist: could not remove build worktree; preserved $quarantined" >&2
    return 1
  fi
  touch "$slot/.ombl-ready"
  printf '%s\n' "$slot/dist"
}

gc_main() {
  [ "$#" -eq 0 ] || die "usage: arm-build.sh gc"
  ensure_cache_is_safe
  mkdir -p "$OMBL_BASE_CACHE"
  local candidate base sha wt
  while IFS= read -r -d '' candidate; do
    base=${candidate##*/}
    [[ "$base" =~ ^[0-9a-f]{40}$|^[0-9a-f]{40}\.(FAILED|INCOMPLETE)-.+$ ]] || continue
    case "$base" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]|\
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].FAILED-*|\
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].INCOMPLETE-*) ;;
      *) continue ;;
    esac
    sha=${base%%.*}
    [ -d "$candidate.lock" ] && continue
    [ -d "$OMBL_BASE_CACHE/$sha.lock" ] && continue
    wt="$candidate/wt"
    remove_registered_worktree "$wt"
    rm -rf "$candidate"
    echo "base_dist_gc: removed $candidate"
  done < <(find "$OMBL_BASE_CACHE" -mindepth 1 -maxdepth 1 -type d -mtime +2 -print0)
  echo "base_dist_gc: done"
}

command=${1:-}
[ -n "$command" ] || die "usage: arm-build.sh <overlay|assert|base-dist|gc> ..."
shift
case "$command" in
  overlay) overlay_main "$@" ;;
  assert) assert_main "$@" ;;
  base-dist) base_dist_main "$@" ;;
  gc) gc_main "$@" ;;
  *) die "unknown subcommand: $command" ;;
esac
