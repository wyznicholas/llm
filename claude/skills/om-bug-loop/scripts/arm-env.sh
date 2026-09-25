#!/bin/bash
# om-bug-loop arm environment helpers.
#
# Two costs used to dominate every task's wall clock, and both are removed here:
#   1. a 347 MB rsync of the home, per arm      -> APFS clone, ~0.07 s
#   2. rebuilding an identical base bundle,     -> one shared build per commit,
#      once per task in the batch                  reused by every task
#
# The node_modules overlay must be per-entry. On 2026-09-15 a whole-directory
# symlink made @openmarket/chat-ui resolve to the shared checkout's working tree,
# proven on T156 f6c9b8fa and T186 c1458c4b. A base bundle is now served only
# when its BUILD-INFO.json contains a passing assertion.
#
# Source it, do not copy the commands out:  . ~/.claude/skills/om-bug-loop/scripts/arm-env.sh

OMBL_BASE_CACHE="${OMBL_BASE_CACHE:-$HOME/.claude/om-bug-loop/base-dist}"
OMBL_SRC_HOME="${OMBL_SRC_HOME:-$HOME/.openmarket-dev}"
OMBL_CHAT="${OMBL_CHAT:-$HOME/Documents/GitlabRepos/openmarket-chat}"
OMBL_SCRIPTS="${OMBL_SCRIPTS:-$HOME/.claude/skills/om-bug-loop/scripts}"

# _clone_guard_port <dest>
# Explicit overrides win. Otherwise keep each ref in its own stable 33xxx slot,
# with a canonical-path hash for clone names that do not carry a ref token.
# Never let a failed parse look like a valid derivation. Measured before this fix:
# zsh: T901 -> 33000, T902 -> 33000 (no error, no warning); bash: 33901, 33902.
# A ref is parsed with shell-neutral globs, or we hash the canonical path; derived
# ports are always in 33001-33999, so 33000 can never mask another shell mismatch.
_clone_guard_port() {
  local dest="$1"
  [ -n "$dest" ] || { echo "_clone_guard_port: need a destination" >&2; return 2; }

  if [ -n "${OMBL_CLONE_GUARD_PORT:-}" ]; then
    printf '%s\n' "$OMBL_CLONE_GUARD_PORT"
    return 0
  fi

  local dest_basename remaining token ref_digits="" ref_number ref_slot
  dest_basename="$(basename "$dest")"
  remaining="$dest_basename"
  while [ -n "$remaining" ]; do
    case "$remaining" in
      [![:alnum:]]*) remaining="${remaining#?}"; continue ;;
    esac
    token="${remaining%%[![:alnum:]]*}"
    remaining="${remaining#"$token"}"
    case "$token" in
      [[:alpha:]]*)
        ref_digits="${token#?}"
        case "$ref_digits" in
          ""|*[!0-9]*) ref_digits="" ;;
        esac
        ;;
      *) ref_digits="" ;;
    esac
    [ -z "$ref_digits" ] || break
  done

  if [ -n "$ref_digits" ]; then
    ref_number="$ref_digits"
    while [ "${ref_number#0}" != "$ref_number" ]; do
      ref_number="${ref_number#0}"
    done
    [ -n "$ref_number" ] || ref_number=0
    ref_slot="$((ref_number % 1000))"
    [ "$ref_slot" -ne 0 ] || ref_slot=999
    [ "$ref_slot" -ge 1 ] && [ "$ref_slot" -le 999 ] || {
      echo "_clone_guard_port: ref token '$token' is outside the derivable port range" >&2
      return 1
    }
    printf '%s\n' "$((33000 + ref_slot))"
    return 0
  fi

  local absolute_dest checksum hash_slot
  absolute_dest="$(cd -P -- "$dest" >/dev/null 2>&1 && pwd -P)" || {
    echo "_clone_guard_port: cannot resolve destination '$dest'" >&2
    return 1
  }
  checksum="$(printf '%s' "$absolute_dest" | LC_ALL=C cksum)" || return 1
  checksum="${checksum%% *}"
  case "$checksum" in
    ""|*[!0-9]*)
      echo "_clone_guard_port: invalid checksum for destination '$absolute_dest'" >&2
      return 1
      ;;
  esac
  hash_slot="$((checksum % 1000))"
  [ "$hash_slot" -ne 0 ] || hash_slot=999
  [ "$hash_slot" -ge 1 ] && [ "$hash_slot" -le 999 ] || {
    echo "_clone_guard_port: checksum for '$absolute_dest' is outside the derivable port range" >&2
    return 1
  }
  printf '%s\n' "$((33000 + hash_slot))"
}

# _clone_databases <dest>
# Print every account database in the clone, including databases in nested
# adopted-guest homes. A failed walk is a containment failure, not an empty set.
_clone_databases() {
  local dest="$1"
  [ -d "$dest/accounts" ] || {
    echo "clone filesystem guard: missing accounts directory at $dest/accounts" >&2
    return 1
  }
  find "$dest/accounts" -type f -name om.sqlite -print
}

# _rewrite_clone_settings_paths <dest>
# The source home is read-only input. Each clone database is rewritten in one
# transaction before any clone daemon has a chance to open it.
_rewrite_clone_settings_paths() {
  local dest="$1"
  command -v sqlite3 >/dev/null 2>&1 || {
    echo "clone_home: sqlite3 is required to contain clone filesystem paths" >&2
    return 1
  }

  local database_list
  database_list="$(_clone_databases "$dest")" || return 1
  [ -n "$database_list" ] || {
    echo "clone_home: no account databases found under $dest/accounts" >&2
    return 1
  }

  local old_prefix="$OMBL_SRC_HOME/"
  local new_prefix="$dest/"
  local sql_old_prefix="${old_prefix//\'/\'\'}"
  local sql_new_prefix="${new_prefix//\'/\'\'}"
  local db uri
  while IFS= read -r db; do
    [ -n "$db" ] || continue
    uri="file:$db?mode=rw"
    if ! sqlite3 -bail "$uri" "
      BEGIN IMMEDIATE;
      UPDATE settings
         SET value = '$sql_new_prefix' || substr(value, length('$sql_old_prefix') + 1)
       WHERE (key = 'agent.library_root'
              OR substr(key, 1, length('agent.library_space_dir.')) = 'agent.library_space_dir.')
         AND substr(value, 1, length('$sql_old_prefix')) = '$sql_old_prefix';
      UPDATE settings
         SET value = json_set(
           value,
           '\$.walkerRoot',
           '$sql_new_prefix' || substr(json_extract(value, '\$.walkerRoot'), length('$sql_old_prefix') + 1)
         )
       WHERE substr(key, 1, length('agent.library_link.')) = 'agent.library_link.'
         AND substr(json_extract(value, '\$.walkerRoot'), 1, length('$sql_old_prefix')) = '$sql_old_prefix';
      COMMIT;
    "; then
      echo "clone_home: failed to rewrite path-bearing settings in $db" >&2
      return 1
    fi
  done <<<"$database_list"
}

# _assert_clone_settings_paths <dest>
# Inspect only the product-owned path settings, opening every database read-only.
_assert_clone_settings_paths() {
  local dest="$1"
  command -v sqlite3 >/dev/null 2>&1 || {
    echo "assert_clone_inert: sqlite3 is required to inspect clone filesystem paths" >&2
    return 1
  }

  local database_list
  database_list="$(_clone_databases "$dest")" || return 1
  [ -n "$database_list" ] || {
    echo "assert_clone_inert: no account databases found under $dest/accounts" >&2
    return 1
  }

  local db uri rows
  while IFS= read -r db; do
    [ -n "$db" ] || continue
    # mode=ro prevents database changes; immutable=1 also prevents SQLite from
    # creating WAL/SHM sidecars while this assertion inspects the clone.
    uri="file:$db?mode=ro&immutable=1"
    if ! rows="$(sqlite3 -json "$uri" "
      SELECT key,
             CASE
               WHEN substr(key, 1, length('agent.library_link.')) = 'agent.library_link.'
                 THEN json_extract(value, '\$.walkerRoot')
               ELSE value
             END AS path
        FROM settings
       WHERE key = 'agent.library_root'
          OR substr(key, 1, length('agent.library_space_dir.')) = 'agent.library_space_dir.'
          OR substr(key, 1, length('agent.library_link.')) = 'agent.library_link.'
       ORDER BY key;
    ")"; then
      echo "assert_clone_inert: cannot read path-bearing settings from $db" >&2
      return 1
    fi

    if ! CLONE_SETTINGS_ROOT="$dest" CLONE_SETTINGS_DB="$db" CLONE_SETTINGS_ROWS="$rows" bun -e '
      import { isAbsolute, sep } from "node:path";
      import { realpathSync } from "node:fs";

      const root = realpathSync(process.env.CLONE_SETTINGS_ROOT ?? "");
      const db = process.env.CLONE_SETTINGS_DB ?? "unknown database";
      const rows = JSON.parse(process.env.CLONE_SETTINGS_ROWS || "[]") as Array<{ key: unknown; path: unknown }>;
      for (const row of rows) {
        const key = typeof row.key === "string" ? row.key : "<invalid key>";
        const path = typeof row.path === "string" ? row.path : "<missing walkerRoot>";
        if (!isAbsolute(path)) {
          console.error(`assert_clone_inert: ${key} names path outside clone: ${path}`);
          process.exit(1);
        }
        let resolved: string;
        try {
          resolved = realpathSync(path);
        } catch {
          console.error(`assert_clone_inert: ${key} names unresolvable path outside clone: ${path}`);
          process.exit(1);
        }
        if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
          console.error(`assert_clone_inert: ${key} names path outside clone: ${path}`);
          process.exit(1);
        }
      }
      console.log(`assert_clone_inert: checked ${db}: ${rows.length} path-bearing setting(s) resolve inside ${root}`);
    '; then
      return 1
    fi
  done <<<"$database_list"
}

# clone_home <dest>
# APFS copy-on-write clone of the live home + the boot hygiene that is NOT optional.
# NEVER use rsync/cp -R for this: a full byte copy of 347 MB costs minutes under load,
# a clone costs milliseconds and shares blocks until written.
clone_home() {
  local dest="$1"
  [ -n "$dest" ] || { echo "clone_home: need a destination" >&2; return 2; }
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  local t0=$SECONDS
  if ! cp -Rc "$OMBL_SRC_HOME" "$dest" 2>/dev/null; then
    # Only reachable if dest is on a different volume than $HOME. Fix the path, do not
    # fall back to a slow copy silently.
    echo "clone_home: APFS clone FAILED — is '$dest' on the same volume as $OMBL_SRC_HOME?" >&2
    return 1
  fi
  _rewrite_clone_settings_paths "$dest" || return 1
  # Account-local runtime artifacts are copied from the live and nested homes. A live
  # pid in a copied lock prevents clone boot, and copied SQLite sidecars are not safe.
  rm -f "$dest/om.sqlite-shm" "$dest/om.sqlite-wal" "$dest/runner.boot.marker" "$dest/.om-runner.lock"
  find "$dest/accounts" \( -type f -o -type l \) \
    \( -name om.sqlite-shm -o -name om.sqlite-wal -o -name runner.boot.marker -o -name .om-runner.lock \) \
    -exec rm -f {} + || {
      echo "clone_home: failed to remove copied account runtime artifacts under $dest/accounts" >&2
      return 1
    }
  echo "clone_home: $dest ready in $((SECONDS-t0))s"

  # T246: the clone retains Nicholas's real credentials, so both chat planes must
  # point at the loopback guard before any clone daemon or CLI is allowed to boot.
  local guard_port
  guard_port="$(_clone_guard_port "$dest")" || return 1
  _write_clone_guard_env "$dest" "$guard_port" || return 1
  echo "clone_home: start_clone_guard '$dest'"
  echo "clone_home: source '$dest/clone-guard.env' before booting the clone"
}

# base_dist <commit>
# Path to a SHARED base bundle for <commit>, built at most once across the whole batch.
# A build is a deterministic function of a commit, so N tasks pinned to one base need
# one build, not N. Prints the dist path on stdout; everything else goes to stderr.
base_dist() {
  OMBL_CHAT="$OMBL_CHAT" OMBL_BASE_CACHE="$OMBL_BASE_CACHE" OMBL_SCRIPTS="$OMBL_SCRIPTS" \
    bash "$OMBL_SCRIPTS/arm-build.sh" base-dist "$1"
}

# overlay_node_modules <wt> <commit>
overlay_node_modules() {
  OMBL_CHAT="$OMBL_CHAT" OMBL_BASE_CACHE="$OMBL_BASE_CACHE" OMBL_SCRIPTS="$OMBL_SCRIPTS" \
    bash "$OMBL_SCRIPTS/arm-build.sh" overlay "$1" "$2"
}

# assert_arm_build <wt> <commit> [--json <out>]
assert_arm_build() {
  OMBL_CHAT="$OMBL_CHAT" OMBL_BASE_CACHE="$OMBL_BASE_CACHE" OMBL_SCRIPTS="$OMBL_SCRIPTS" \
    bash "$OMBL_SCRIPTS/arm-build.sh" assert "$@"
}

# base_dist_gc — drop only eligible cached base builds older than 2 days.
base_dist_gc() {
  OMBL_CHAT="$OMBL_CHAT" OMBL_BASE_CACHE="$OMBL_BASE_CACHE" OMBL_SCRIPTS="$OMBL_SCRIPTS" \
    bash "$OMBL_SCRIPTS/arm-build.sh" gc
}

# _write_clone_guard_env <dest> <port>
# Keep all clone entry points on the same guarded REST, WS, and library paths.
_write_clone_guard_env() {
  local dest="$1"
  local port="$2"
  [ -n "$dest" ] && [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || {
    echo "clone-guard: need a clone destination and valid port" >&2
    return 2
  }

  local env_file="$dest/clone-guard.env"
  local temp_file="$env_file.tmp.$$"
  (
    umask 077
    {
      echo "# Generated by clone_home. Source before booting anything against this clone."
      printf 'export OM_ROOM_CHAT_API_URL=%q\n' "http://127.0.0.1:$port/chat"
      printf 'export OM_ROOMS_WS_URL=%q\n' "ws://127.0.0.1:$port/ws/rooms"
      printf 'export OM_LIBRARY_DIR=%q\n' "$dest/library/home"
    } >"$temp_file" || { rm -f "$temp_file"; exit 1; }
    mv "$temp_file" "$env_file"
  )
}

# start_clone_guard <dest> [port] [--allow-writes]
# T246's negative-control switch is accepted only explicitly; normal starts are read-only.
start_clone_guard() {
  local dest="$1"
  local requested_port="${2:-}"
  local mode="${3:-}"
  local port
  if [ -n "${OMBL_CLONE_GUARD_PORT:-}" ]; then
    port="$(_clone_guard_port "$dest")" || return 1
  elif [ -n "$requested_port" ]; then
    port="$requested_port"
  else
    port="$(_clone_guard_port "$dest")" || return 1
  fi
  [ -n "$dest" ] && [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || {
    echo "start_clone_guard: need <dest> [port] [--allow-writes]" >&2
    return 2
  }
  [ -z "$mode" ] || [ "$mode" = "--allow-writes" ] || {
    echo "start_clone_guard: unknown option '$mode'" >&2
    return 2
  }
  [ "$#" -le 3 ] || { echo "start_clone_guard: too many arguments" >&2; return 2; }

  mkdir -p "$dest" || return 1
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep -q .; then
    echo "start_clone_guard: port $port is already in use; guard NOT started" >&2
    return 1
  fi

  local pid_file="$dest/clone-guard.pid"
  if [ -s "$pid_file" ]; then
    local old_pid
    old_pid="$(tr -cd '0-9' <"$pid_file")"
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      echo "start_clone_guard: recorded pid $old_pid is still running" >&2
      return 1
    fi
  fi

  local upstream="${OMBL_CLONE_GUARD_UPSTREAM:-https://chat.openmarket.xyz}"
  local stdout_log="$dest/clone-guard.stdout.log"
  local decision_log="$dest/clone-guard.log"
  local -a command=(bun "$OMBL_SCRIPTS/clone-guard.ts" --port "$port" --home "$dest" --upstream "$upstream" --log "$decision_log")
  [ -z "$mode" ] || command+=("$mode")
  "${command[@]}" >"$stdout_log" 2>&1 &
  local guard_pid=$!
  printf '%s\n' "$guard_pid" >"$pid_file"

  local expected_mode="read-only"
  [ -z "$mode" ] || expected_mode="allow-writes"
  local health=""
  local attempt=0
  while [ "$attempt" -lt 50 ]; do
    health="$(curl -fsS --max-time 1 "http://127.0.0.1:$port/__guard/health" 2>/dev/null || true)"
    if [[ "$health" == *"\"mode\":\"$expected_mode\""* ]]; then
      if ! _write_clone_guard_env "$dest" "$port"; then
        echo "start_clone_guard: could not write $dest/clone-guard.env" >&2
        kill "$guard_pid" 2>/dev/null || true
        wait "$guard_pid" 2>/dev/null || true
        rm -f "$pid_file"
        return 1
      fi
      echo "start_clone_guard: pid $guard_pid listening on 127.0.0.1:$port ($expected_mode)"
      return 0
    fi
    if ! kill -0 "$guard_pid" 2>/dev/null; then
      echo "start_clone_guard: guard exited before becoming healthy; see $stdout_log" >&2
      rm -f "$pid_file"
      return 1
    fi
    sleep 0.1
    attempt=$((attempt + 1))
  done

  echo "start_clone_guard: timed out waiting for guard health; see $stdout_log" >&2
  kill "$guard_pid" 2>/dev/null || true
  wait "$guard_pid" 2>/dev/null || true
  rm -f "$pid_file"
  return 1
}

# stop_clone_guard <dest>
# A stale pid may belong to an unrelated process, so refuse unless it still names clone-guard.ts.
stop_clone_guard() {
  local dest="$1"
  [ -n "$dest" ] || { echo "stop_clone_guard: need a clone destination" >&2; return 2; }
  local pid_file="$dest/clone-guard.pid"
  [ -s "$pid_file" ] || { echo "stop_clone_guard: no recorded pid at $pid_file" >&2; return 1; }

  local guard_pid
  guard_pid="$(tr -cd '0-9' <"$pid_file")"
  [[ "$guard_pid" =~ ^[0-9]+$ ]] || { echo "stop_clone_guard: invalid recorded pid" >&2; return 1; }
  if ! kill -0 "$guard_pid" 2>/dev/null; then
    echo "stop_clone_guard: recorded pid $guard_pid is not running" >&2
    rm -f "$pid_file"
    return 1
  fi
  local command
  command="$(ps -p "$guard_pid" -o command= 2>/dev/null || true)"
  [[ "$command" == *"clone-guard.ts"* ]] || {
    echo "stop_clone_guard: pid $guard_pid is not clone-guard.ts; refusing to signal it" >&2
    return 1
  }

  kill "$guard_pid"
  wait "$guard_pid" 2>/dev/null || true
  rm -f "$pid_file"
  echo "stop_clone_guard: stopped pid $guard_pid"
}

# assert_clone_inert <daemon-pid> <dest>
# Read-only tripwire: inspect declared guard configuration and the daemon's sockets, never fix them.
# The process environment is NOT readable on macOS: measured
# `env OM_ROOM_CHAT_API_URL=http://127.0.0.1:31946/chat sleep 8 &; ps eww -p $! -o command=`
# prints only `sleep 8`, so do not replace the socket proof with a process-environment check.
_clone_inert_verdict_fail() {
  local rc="$1"
  local reason="$2"
  printf 'assert_clone_inert: FAIL rc=%s — clone is NOT inert: %s\n' "$rc" "$reason"
  return "$rc"
}

assert_clone_inert() {
  if [ -p /dev/stdout ] && ! [[ -o pipefail ]]; then
    echo "assert_clone_inert: stdout is a pipe and pipefail is off; the exit status would be the pipe's, not the tripwire's; run it unpiped, redirect to a file and read that, or set -o pipefail first; command substitution \$(...) counts as a pipe" >&2
    _clone_inert_verdict_fail 2 "NOT RUN: stdout is a pipe and pipefail is off"
    return
  fi

  local daemon_pid="$1"
  local dest="$2"
  [[ "$daemon_pid" =~ ^[0-9]+$ ]] && [ -n "$dest" ] || {
    echo "assert_clone_inert: need <daemon-pid> <dest>" >&2
    _clone_inert_verdict_fail 2 "need <daemon-pid> <dest>"
    return
  }

  local selftest_output=""
  if ! selftest_output="$(bun "$OMBL_SCRIPTS/clone-guard.ts" --selftest 2>&1)"; then
    [ -z "$selftest_output" ] || printf '%s\n' "$selftest_output" >&2
    echo "assert_clone_inert: clone-guard forwarding self-test failed" >&2
    _clone_inert_verdict_fail 1 "clone-guard forwarding self-test failed"
    return
  fi
  echo "assert_clone_inert: checked clone-guard selftest: forwarding confirmed"

  local expected_home
  expected_home="$(cd -P -- "$dest" >/dev/null 2>&1 && pwd -P)" || {
    echo "assert_clone_inert: cannot resolve requested clone home '$dest'" >&2
    _clone_inert_verdict_fail 1 "cannot resolve requested clone home '$dest'"
    return
  }
  if ! _assert_clone_settings_paths "$expected_home"; then
    _clone_inert_verdict_fail 1 "clone settings path validation failed for '$expected_home'"
    return
  fi

  local env_file="$dest/clone-guard.env"
  if [ ! -f "$env_file" ]; then
    echo "assert_clone_inert: checked $env_file: missing" >&2
    _clone_inert_verdict_fail 1 "checked $env_file: missing"
    return
  fi

  local rest_line="" ws_line="" line=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "export OM_ROOM_CHAT_API_URL="*)
        if [ -n "$rest_line" ]; then
          echo "assert_clone_inert: checked $env_file: duplicate OM_ROOM_CHAT_API_URL entries" >&2
          _clone_inert_verdict_fail 1 "checked $env_file: duplicate OM_ROOM_CHAT_API_URL entries"
          return
        fi
        rest_line="$line"
        ;;
      "export OM_ROOMS_WS_URL="*)
        if [ -n "$ws_line" ]; then
          echo "assert_clone_inert: checked $env_file: duplicate OM_ROOMS_WS_URL entries" >&2
          _clone_inert_verdict_fail 1 "checked $env_file: duplicate OM_ROOMS_WS_URL entries"
          return
        fi
        ws_line="$line"
        ;;
    esac
  done <"$env_file"

  local port rest_value ws_value
  rest_value="${rest_line#export OM_ROOM_CHAT_API_URL=}"
  case "$rest_value" in
    "http://127.0.0.1:"*"/chat")
      port="${rest_value#http://127.0.0.1:}"
      port="${port%/chat}"
      ;;
    *) port="" ;;
  esac
  case "$port" in
    ""|*[!0-9]*)
      echo "assert_clone_inert: checked $env_file: OM_ROOM_CHAT_API_URL is not loopback /chat (found: ${rest_line:-missing})" >&2
      _clone_inert_verdict_fail 1 "checked $env_file: OM_ROOM_CHAT_API_URL is not loopback /chat (found: ${rest_line:-missing})"
      return
      ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "assert_clone_inert: checked $env_file: guard port $port is outside 1-65535" >&2
    _clone_inert_verdict_fail 1 "checked $env_file: guard port $port is outside 1-65535"
    return
  fi
  ws_value="${ws_line#export OM_ROOMS_WS_URL=}"
  if [ "$ws_value" != "ws://127.0.0.1:$port/ws/rooms" ]; then
    echo "assert_clone_inert: checked $env_file: OM_ROOMS_WS_URL does not use loopback guard port $port (found: ${ws_line:-missing})" >&2
    _clone_inert_verdict_fail 1 "checked $env_file: OM_ROOMS_WS_URL does not use loopback guard port $port (found: ${ws_line:-missing})"
    return
  fi
  echo "assert_clone_inert: checked $env_file: REST and WS use loopback guard port $port"

  local health health_mode="unknown"
  health="$(curl -fsS --max-time 2 "http://127.0.0.1:$port/__guard/health" 2>/dev/null)" || {
    echo "assert_clone_inert: checked http://127.0.0.1:$port/__guard/health: no healthy response" >&2
    _clone_inert_verdict_fail 1 "checked http://127.0.0.1:$port/__guard/health: no healthy response"
    return
  }
  case "$health" in
    *'"mode":"read-only"'*) health_mode="read-only" ;;
    *'"mode":"allow-writes"'*) health_mode="allow-writes" ;;
  esac
  echo "assert_clone_inert: checked http://127.0.0.1:$port/__guard/health: mode=$health_mode"
  [ "$health_mode" = "read-only" ] || {
    echo "assert_clone_inert: guard on port $port is not in read-only mode (mode=$health_mode)" >&2
    _clone_inert_verdict_fail 1 "guard on port $port is not in read-only mode (mode=$health_mode)"
    return
  }

  local health_home resolved_health_home
  if ! health_home="$(
    CLONE_GUARD_HEALTH="$health" bun -e '
      const health = JSON.parse(process.env.CLONE_GUARD_HEALTH ?? "");
      if (typeof health.home !== "string" || health.home.length === 0) process.exit(1);
      process.stdout.write(health.home);
    ' 2>/dev/null
  )"; then
    echo "assert_clone_inert: guard on port $port did not report a valid home identity" >&2
    _clone_inert_verdict_fail 1 "guard on port $port did not report a valid home identity"
    return
  fi
  resolved_health_home="$(cd -P -- "$health_home" >/dev/null 2>&1 && pwd -P)" || {
    echo "assert_clone_inert: guard on port $port reported unresolvable home '$health_home'" >&2
    _clone_inert_verdict_fail 1 "guard on port $port reported unresolvable home '$health_home'"
    return
  }
  if [ "$resolved_health_home" != "$expected_home" ]; then
    echo "assert_clone_inert: guard on port $port belongs to '$resolved_health_home', not requested clone '$expected_home'" >&2
    _clone_inert_verdict_fail 1 "guard on port $port belongs to '$resolved_health_home', not requested clone '$expected_home'"
    return
  fi
  echo "assert_clone_inert: guard on port $port identity matches '$expected_home'"

  if ! command -v lsof >/dev/null 2>&1; then
    echo "assert_clone_inert: cannot obtain TCP socket list for daemon pid $daemon_pid: lsof is unavailable" >&2
    _clone_inert_verdict_fail 1 "cannot obtain TCP socket list for daemon pid $daemon_pid: lsof is unavailable"
    return
  fi

  local socket_lines
  if ! socket_lines="$(lsof -nP -a -p "$daemon_pid" -iTCP 2>&1)"; then
    echo "assert_clone_inert: cannot obtain TCP socket list for daemon pid $daemon_pid: ${socket_lines:-lsof returned no sockets}" >&2
    _clone_inert_verdict_fail 1 "cannot obtain TCP socket list for daemon pid $daemon_pid: ${socket_lines:-lsof returned no sockets}"
    return
  fi

  local socket_line remote guard_peer="" offending_peer="" socket_count=0
  while IFS= read -r socket_line; do
    [ -n "$socket_line" ] || continue
    [[ "$socket_line" == COMMAND* ]] && continue
    socket_count=$((socket_count + 1))
    [[ "$socket_line" == *"->"* ]] || continue
    remote="${socket_line#*->}"
    remote="${remote%% *}"
    case "$remote" in
      "127.0.0.1:$port"|"[::1]:$port"|"::1:$port"|"[::ffff:127.0.0.1]:$port"|"::ffff:127.0.0.1:$port") guard_peer="$remote" ;;
    esac
    [[ "$remote" == *":443" ]] || continue
    case "$remote" in
      127.*:443|'[::1]':443|::1:443|'[::ffff:127.'*:443|::ffff:127.*:443) ;;
      *) [ -n "$offending_peer" ] || offending_peer="$remote" ;;
    esac
  done <<<"$socket_lines"

  if [ "$socket_count" -eq 0 ]; then
    echo "assert_clone_inert: checked lsof for daemon pid $daemon_pid: no TCP sockets were returned" >&2
    _clone_inert_verdict_fail 1 "checked lsof for daemon pid $daemon_pid: no TCP sockets were returned"
    return
  fi
  echo "assert_clone_inert: checked lsof for daemon pid $daemon_pid: $socket_count TCP socket(s)"
  if [ -n "$guard_peer" ]; then
    echo "assert_clone_inert: daemon pid $daemon_pid is connected to loopback guard $guard_peer"
  else
    echo "assert_clone_inert: daemon pid $daemon_pid has no connection to loopback guard port $port" >&2
  fi
  if [ -n "$offending_peer" ]; then
    echo "assert_clone_inert: daemon pid $daemon_pid has non-loopback TCP/443 connection: $offending_peer" >&2
    _clone_inert_verdict_fail 1 "daemon pid $daemon_pid has non-loopback TCP/443 connection: $offending_peer"
    return
  fi
  if [ -z "$guard_peer" ]; then
    _clone_inert_verdict_fail 1 "daemon pid $daemon_pid has no connection to loopback guard port $port"
    return
  fi
  echo "assert_clone_inert: daemon pid $daemon_pid has no non-loopback TCP/443 connection"
  echo "assert_clone_inert: PASS (forwarding confirmed; upstream liveness not checked; $dest)"
}
