#!/bin/bash
# Bring the OM Rooms fuzz world up, or repair it, and prove it is usable.
#
# The routines cannot assume this world exists: mongod and redis are launchd
# jobs (they come back on their own), but the three node services and the
# daemon-pair are plain processes that die on reboot, on sleep, or when a
# terminal that started them closes. A scheduled fuzz run against a missing
# world produces a "0 crashes, clean" that means nothing — so this script is
# the precondition, and it FAILS LOUDLY rather than letting a run proceed.
#
# It is idempotent: safe to run when everything is already up.
#
# Exit 0 = world ready (GUI serving).  Exit 1 = could not build the world.
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPOS="$HOME/repos"
OM="$REPOS/openmarket"
CHAT="$REPOS/openmarket-chat"
STATE="$HOME/.local/state/routines"
LOG="$STATE/stack.log"
GUI="http://127.0.0.1:31398/rooms/"
mkdir -p "$STATE"

say() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG"; }
listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }

wait_http() { # url, seconds
  local url="$1" deadline=$(( $(date +%s) + ${2:-60} ))
  while (( $(date +%s) < deadline )); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url")" == "200" ]] && return 0
    sleep 3
  done
  return 1
}

# --- 1. Datastores (launchd-managed; nudge them if launchd has not) ---------
if [[ -z "$(listening 27027)" ]]; then
  say "mongod not listening — loading launchd job"
  launchctl load "$HOME/Library/LaunchAgents/xyz.openmarket.rooms-mongo.plist" 2>/dev/null
  # WiredTiger recovery after an unclean stop takes ~30s; do not call it dead early.
  for _ in $(seq 1 20); do [[ -n "$(listening 27027)" ]] && break; sleep 3; done
fi
[[ -n "$(listening 27027)" ]] || { say "FATAL: mongod (27027) will not start"; exit 1; }

if ! redis-cli ping >/dev/null 2>&1; then
  say "redis not answering — starting"
  brew services start redis >/dev/null 2>&1
  for _ in $(seq 1 10); do redis-cli ping >/dev/null 2>&1 && break; sleep 2; done
fi
# The relay needs redis for rate-limit + presence. Without it the GUI hangs on
# its boot skeleton with every HTTP call returning 200 and no console error —
# an hour of debugging that should never be repeated.
redis-cli ping >/dev/null 2>&1 || { say "FATAL: redis (6379) will not start"; exit 1; }

# --- 2. The three services --------------------------------------------------
if [[ -z "$(listening 4011)" || -z "$(listening 5011)" || -z "$(listening 3002)" ]]; then
  say "rooms stack incomplete — restarting it"
  # stack-up skips a dead service whose stale pidfile is still on disk, then
  # prints its OLD log tail, which reads exactly like a fresh failure. Always
  # down before up.
  ( cd "$OM" && \
    OM_STACK_AUTH_REPO="$REPOS/auth-service-backend" \
    OM_STACK_THARAMINE_REPO="$REPOS/tharamine-user-service" \
    OM_STACK_CHAT_REPO="$REPOS/kiyotaka-chat-service" \
    bash tools/rooms-stack/stack-down.sh >>"$LOG" 2>&1 )
  ( cd "$OM" && \
    OM_STACK_MONGO_URI=mongodb://127.0.0.1:27027 \
    OM_STACK_AUTH_REPO="$REPOS/auth-service-backend" \
    OM_STACK_THARAMINE_REPO="$REPOS/tharamine-user-service" \
    OM_STACK_CHAT_REPO="$REPOS/kiyotaka-chat-service" \
    bash tools/rooms-stack/stack-up.sh >>"$LOG" 2>&1 )
fi
wait_http "http://localhost:4011/api/v2/health" 90 || { say "FATAL: auth (4011) unhealthy"; exit 1; }
wait_http "http://localhost:5011/api/v2/health" 90 || { say "FATAL: tharamine (5011) unhealthy"; exit 1; }
wait_http "http://localhost:3002/health" 90       || { say "FATAL: relay (3002) unhealthy"; exit 1; }

# --- 3. The GUI + zero-login pair -------------------------------------------
if ! wait_http "$GUI" 5; then
  say "daemon-pair not serving — rebuilding bundle and booting it"
  # The daemon caches dist/ at boot, so a stale bundle is served silently;
  # daemon-pair itself refuses to start on a stale stamp, hence the rebuild.
  # Install before building. node_modules drifts from the lockfile whenever the
  # checkout moves, and vite then dies on a subpath the installed version does
  # not export yet. That failed for seven straight days, and reported itself only
  # as "GUI never served" — the actual cause never left this log.
  ( cd "$CHAT" && bun install --frozen-lockfile >>"$LOG" 2>&1 ) \
    || say "warn: bun install failed — build may fail on stale deps, see $LOG"
  ( cd "$CHAT" && bun run build >>"$LOG" 2>&1 ) \
    || { say "FATAL: bundle build failed — see $LOG"; exit 1; }
  ( cd "$CHAT" && OM_PAIR_AUTH_URL=http://localhost:4011 nohup bun tools/daemon-pair.ts >>"$LOG" 2>&1 & )
  wait_http "$GUI" 150 || { say "FATAL: GUI (31398) never served"; exit 1; }
fi

say "world ready: mongo+redis+auth+tharamine+relay+daemon-pair, GUI at $GUI"
exit 0
