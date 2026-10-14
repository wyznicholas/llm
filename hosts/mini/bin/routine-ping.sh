#!/bin/bash
# Post a routine's daily report to #om-agent-test as @om-agent.
#
# The badge that can post as @om-agent lives only on oms-mac-mini (om-agent's
# own .env); the `om` CLI is not installed there, so delivery is:
#   this Mac  --ssh(ombot,key-only)-->  mini  -->  bun routine-say.ts  --> relay
#
# Message body comes from stdin (preferred, multi-line) or from the arguments.
# Never fails the caller: a routine that found real bugs must not be marked
# failed because chat was unreachable. The report is echoed to stdout (and so
# into the routine log) before sending, so the finding survives a delivery loss.
#
# Usage:  routine-ping.sh "text"   |   printf '%s' "$report" | routine-ping.sh
#         ROUTINE_PING_ROOM=<id> to target another room.
set -uo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ROOM="${ROUTINE_PING_ROOM:-860c25cf02b5}"
HOST="${ROUTINE_PING_HOST:-oms-mac-mini}"
REMOTE_DIR="/Users/ombot/.local/share/om-routines"
FALLBACK_DIR="$HOME/.local/state/routines/undelivered"

if [[ $# -gt 0 ]]; then
  BODY="$*"
else
  BODY="$(cat)"
fi

if [[ -z "${BODY// }" ]]; then
  echo "routine-ping: empty message, nothing to send" >&2
  exit 0
fi

# Mirror the report where routine-run.sh can see it. This is the one place every
# routine's output funnels through, so it is the honest place to record that the
# run produced something — including a "nothing worth doing" report.
if [[ -n "${ROUTINE_REPORT_FILE:-}" ]]; then
  printf '%s\n' "$BODY" >> "$ROUTINE_REPORT_FILE" 2>/dev/null || true
fi

echo "--- routine-ping → #$ROOM ---"
printf '%s\n' "$BODY"
echo "--- end report ---"

# On the badge box itself there is no hop to make: ssh-to-self fails host-key
# verification, and routine-say.ts reads OM_AGENT_API_KEY from om-agent/.env
# right here. Anywhere else, keep the ssh delivery.
LOCAL_DIR="$HOME/.local/share/om-routines"
if [[ "$HOST" == local || "$HOST" == localhost || "$(hostname -s)" == "OMs-Mac-mini" ]]; then
  if printf '%s' "$BODY" | ( cd "$LOCAL_DIR" && bun routine-say.ts "$ROOM" ) 2>&1; then
    exit 0
  fi
elif printf '%s' "$BODY" | ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" \
     "zsh -lc 'cd $REMOTE_DIR && bun routine-say.ts $ROOM'" 2>&1; then
  exit 0
fi

# Delivery failed. Keep the report so the next run can carry it forward rather
# than losing a day of findings to an ssh hiccup.
mkdir -p "$FALLBACK_DIR"
UNDELIVERED="$FALLBACK_DIR/$(date +%Y-%m-%dT%H%M%S).md"
printf '%s\n' "$BODY" > "$UNDELIVERED"
echo "routine-ping: delivery failed, report saved to $UNDELIVERED" >&2
exit 0
