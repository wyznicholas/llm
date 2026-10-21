#!/usr/bin/env bash
# Serve an openmarket-chat worktree's built dist/ through a SOURCE om daemon
# signed in as @nicholas_trontal, and screenshot it. See ENV.md beside this.
#
#   gui.sh start <worktree> <port>      # port 31470-31479; builds nothing
#   gui.sh shot  <port> <out-prefix> [hash] [wait-ms]
#                                       # writes <out-prefix>-desktop.png (1440x900)
#                                       # and <out-prefix>-mobile.png (390x844)
#                                       # hash defaults to #/82eae63a1bd3 (#chat)
#   gui.sh stop  <port>
#   gui.sh status
#
# Each port gets its own OM_HOME (~/.openmarket-chatdev-<port>), cloned on
# first use from the template ~/.openmarket-chatdev (a copy of the signed-in
# ~/.openmarket with the librarian and library mirror switched off). Two
# daemons must never share one OM_HOME (one SQLite db, one runner token).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/run"
OM_REPO="${OM_REPO:-$HOME/repos/openmarket}"
BUN_DIR="$HOME/.local/opt/bun-1.4.3"   # the monorepo pins 1.4.3; /usr/local/bin/bun is 1.3.14
TEMPLATE="$HOME/.openmarket-chatdev"
mkdir -p "$RUN"

die() { echo "gui.sh: $*" >&2; exit 1; }

port_pid() { ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }

cmd_start() {
  local wt="${1:?worktree path}" port="${2:?port}"
  wt="$(cd "$wt" && pwd)"
  [[ -f "$wt/dist/assets/rooms.js" ]] || die "$wt/dist/assets/rooms.js missing; run 'bun run build' in $wt first"
  [[ "$port" == 31337 || "$port" == 8097 || "$port" == 31417 ]] && die "port $port is reserved; use 31470-31479"
  [[ -n "$(port_pid "$port")" ]] && die "port $port already in use (pid $(port_pid "$port")); 'gui.sh stop $port' or pick another"
  local home="$HOME/.openmarket-chatdev-$port"
  if [[ ! -d "$home" ]]; then
    [[ -d "$TEMPLATE" ]] || die "template $TEMPLATE missing (see ENV.md 'one-time setup')"
    mkdir -m 700 "$home"
    cp -a "$TEMPLATE/." "$home/"
    rm -rf "$home/library"
  fi
  chmod 700 "$home"
  local log="$RUN/daemon-$port.log"
  # No OM_LIBRARY_DIR on purpose: on a non-default OM_HOME the library mirror
  # stays off unless that variable is set.
  ( cd "$OM_REPO" && \
    PATH="$BUN_DIR:$PATH" OM_HOME="$home" OM_BIND="127.0.0.1:$port" \
    OM_ROOMS_GUI_DIR="$wt/dist" OM_NO_BROWSER=1 OM_NO_UPDATE_CHECK=1 \
    setsid nohup "$BUN_DIR/bun" packages/cli/src/bootstrap.ts run >"$log" 2>&1 </dev/null & )
  for _ in $(seq 1 60); do
    if [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/rooms/" || true)" == 200 ]]; then
      local pid; pid="$(port_pid "$port")"
      echo "$pid" >"$RUN/daemon-$port.pid"
      echo "$wt" >"$RUN/daemon-$port.worktree"
      echo "up: http://127.0.0.1:$port/rooms/#/82eae63a1bd3  pid=$pid  dist=$wt/dist  log=$log"
      return 0
    fi
    sleep 1
  done
  tail -20 "$log" >&2
  die "daemon did not answer on :$port within 60s"
}

cmd_stop() {
  local port="${1:?port}" pid
  pid="$(port_pid "$port")"
  [[ -z "$pid" && -f "$RUN/daemon-$port.pid" ]] && pid="$(cat "$RUN/daemon-$port.pid")"
  if [[ -n "$pid" ]] && kill "$pid" 2>/dev/null; then
    for _ in $(seq 1 20); do [[ -z "$(port_pid "$port")" ]] && break; sleep 0.5; done
    [[ -n "$(port_pid "$port")" ]] && kill -9 "$pid" 2>/dev/null || true
    echo "stopped :$port (pid $pid)"
  else
    echo "nothing listening on :$port"
  fi
  rm -f "$RUN/daemon-$port.pid" "$RUN/daemon-$port.worktree"
}

cmd_status() {
  local any=0
  for f in "$RUN"/daemon-*.pid; do
    [[ -e "$f" ]] || continue
    local port; port="$(basename "$f" .pid)"; port="${port#daemon-}"
    echo ":$port pid=$(cat "$f") alive=$([[ -n "$(port_pid "$port")" ]] && echo yes || echo no) dist=$(cat "$RUN/daemon-$port.worktree" 2>/dev/null)/dist"
    any=1
  done
  [[ $any == 1 ]] || echo "no daemons started by gui.sh"
}

cmd_shot() {
  local port="${1:?port}" out="${2:?out prefix}" hash="${3:-#/82eae63a1bd3}" wait="${4:-6000}"
  [[ "$hash" == \#* ]] || die "3rd arg is the route hash (e.g. '#/82eae63a1bd3'), got '$hash'; wait-ms is the 4th"
  out="$(realpath -m "$out")"
  node "$HERE/shot.mjs" "http://127.0.0.1:$port/rooms/$hash" "$out" "$wait"
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  status) cmd_status ;;
  shot) shift; cmd_shot "$@" ;;
  *) sed -n 2,20p "$0"; exit 2 ;;
esac
