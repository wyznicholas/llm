#!/bin/bash
# Reopens the second Claude desktop copy ("Claude Work", data folder Claude-Work)
# after it quits to install an update, and leaves it closed after a normal quit.
#
# Why: both copies run the same /Applications/Claude.app. When the work copy is
# idle in the background with an update staged, it quits to install it, but the
# install cannot replace the bundle while the main copy is running, so the work
# copy never comes back.
#
# How it tells the two quits apart: right before any update quit (idle "stealth"
# update or "Restart to update"), Claude writes <data folder>/update-attempt, and
# deletes it on its next launch. A plain Cmd+Q writes nothing. launchd runs this
# script whenever that file changes (WatchPaths), so nothing polls while idle.

DATA="$HOME/Library/Application Support/Claude-Work"
MARKER="$DATA/update-attempt"
APP="/Applications/Claude.app"
# Anchored on the binary path so it only matches the work copy's main process,
# never this script or the main Claude (which runs without --user-data-dir).
WORK_PROC="^$APP/Contents/MacOS/Claude --user-data-dir=$DATA"
LOG="$HOME/Library/Logs/claude-work-watchdog.log"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
work_running() { pgrep -f "$WORK_PROC" > /dev/null; }

# launchd also fires when the relaunched app deletes the marker.
[ -f "$MARKER" ] || exit 0

# Ignore a marker left over from an older attempt (e.g. one we already handled).
age=$(( $(date +%s) - $(stat -f %m "$MARKER") ))
if [ "$age" -gt 600 ]; then
  exit 0
fi
log "update quit marker seen ($(cat "$MARKER" 2>/dev/null))"

# Wait for the work copy to finish quitting (cleanup takes about a second).
for _ in $(seq 1 90); do work_running || break; sleep 2; done
if work_running; then
  log "work copy still running after 3 min; not touching it"
  exit 0
fi

# No wait on Claude's installer (ShipIt): it stays alive until the main copy
# quits too, and it does not replace the bundle while any copy is running.

# Give Claude's own relaunch a chance first, so we never start a second one.
sleep 15
if work_running; then
  log "work copy came back on its own"
  exit 0
fi

open -n -a "$APP" --args --user-data-dir="$DATA"
log "reopened the work copy"
