#!/bin/bash
# Reopens either Claude desktop copy — the main one (data folder Claude) or
# "Claude Work" (data folder Claude-Work) — after it quits to install an update,
# and leaves it closed after a normal quit.
#
# Why: both copies run the same /Applications/Claude.app. When a copy is idle in
# the background with an update staged, it quits to install it, but the install
# cannot replace the bundle while the other copy is running, so the copy that
# quit never comes back. This hits whichever copy quits first: at first only the
# work copy was covered, then on 2026-10-28 the main copy quit for 4.29.0 and
# stayed closed, and clicking Claude.app only focused the work copy.
#
# How it tells the two quits apart: right before any update quit (idle "stealth"
# update or "Restart to update"), Claude writes <data folder>/update-attempt, and
# deletes it on its next launch. A plain Cmd+Q writes nothing. launchd runs this
# script whenever either copy's file changes (WatchPaths), so nothing polls while
# idle. Each run checks both markers, since launchd won't start a second run
# while one is still waiting.

APP="/Applications/Claude.app"
BIN="$APP/Contents/MacOS/Claude"
MAIN_DATA="$HOME/Library/Application Support/Claude"
WORK_DATA="$HOME/Library/Application Support/Claude-Work"
LOG="$HOME/Library/Logs/claude-work-watchdog.log"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# Patterns are anchored on the binary path so they only match a copy's main
# process, never this script or the helpers. The main copy runs with no
# arguments; the work copy runs with --user-data-dir.
proc_pattern() {
  case "$1" in
    main) echo "^$BIN\$" ;;
    work) echo "^$BIN --user-data-dir=$WORK_DATA" ;;
  esac
}
running() { pgrep -f "$(proc_pattern "$1")" > /dev/null; }

reopen() {
  # -n because the other copy is usually running: without it macOS just focuses
  # that one instead of starting a new instance.
  case "$1" in
    main) open -n -a "$APP" ;;
    work) open -n -a "$APP" --args --user-data-dir="$WORK_DATA" ;;
  esac
}

handle() {
  local copy=$1 marker="$2/update-attempt"

  # launchd also fires when the relaunched app deletes the marker.
  [ -f "$marker" ] || return

  # Ignore a marker left over from an older attempt (e.g. one we already handled).
  local age=$(( $(date +%s) - $(stat -f %m "$marker") ))
  [ "$age" -gt 600 ] && return
  log "$copy copy: update quit marker seen ($(cat "$marker" 2>/dev/null))"

  # Wait for the copy to finish quitting (cleanup takes about a second).
  for _ in $(seq 1 90); do running "$copy" || break; sleep 2; done
  if running "$copy"; then
    log "$copy copy still running after 3 min; not touching it"
    return
  fi

  # No wait on Claude's installer (ShipIt): it stays alive until the other copy
  # quits too, and it does not replace the bundle while any copy is running.

  # Give Claude's own relaunch a chance first, so we never start a second one.
  sleep 15
  if running "$copy"; then
    log "$copy copy came back on its own"
    return
  fi

  reopen "$copy"
  log "reopened the $copy copy"
}

handle main "$MAIN_DATA"
handle work "$WORK_DATA"
