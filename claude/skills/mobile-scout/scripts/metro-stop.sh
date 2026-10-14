#!/bin/bash
# Stop the Metro this routine started, by the PID preflight recorded — never by
# pattern. Other owners run their own Metro on :8081 for the Android emulator,
# and a `pkill -f expo` here would take theirs down mid-measurement.
set -uo pipefail
PIDFILE="$HOME/.local/state/routines/mobile-scout/metro.pid"
[[ -s "$PIDFILE" ]] || { echo "metro-stop: no pid file, nothing to stop"; exit 0; }
PID="$(cat "$PIDFILE")"
if kill -0 "$PID" 2>/dev/null; then
  # expo start forks the Metro server; take the whole group preflight created.
  kill -TERM -- "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null
  sleep 2
  kill -KILL -- "-$PID" 2>/dev/null || true
  echo "metro-stop: stopped $PID"
else
  echo "metro-stop: $PID already gone"
fi
rm -f "$PIDFILE"
