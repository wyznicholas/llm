#!/bin/bash
# Daily #mobile status into OM Chat → #chat, topic "mobile" (ac8e7b09).
#
# Nicholas asked for this on 2026-09-18 so the room can see what the mobile lane
# is doing without reading the board.
#
# Two deliberate constraints:
#
#   1. It reads ONLY ~/.claude/om-bug-loop/. Nothing under ~/Documents, ever.
#      Under launchd this host's TCC prompt makes any ~/Documents read HANG
#      rather than fail (measured 2026-09-17: python3, node AND claude all hung
#      on the vault), so a status job that touched the board would wedge every
#      hour instead of reporting. tasks.json carries everything this needs.
#   2. It posts every day, and says so plainly when nothing moved. Daily is a
#      rhythm people read; the earlier hourly version was not, and a quiet day
#      repeated verbatim is what teaches a room to skip a channel. So the digest
#      is still compared — it just changes the WORDING rather than suppressing
#      the post. Delete last-digest.txt to force a full report.
set -uo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

ROOM="${MOBILE_STATUS_ROOM:-82eae63a1bd3}"
TOPIC="${MOBILE_STATUS_TOPIC:-ac8e7b09}"
STATE_DIR="$HOME/.local/state/mobile-status"
LAST="$STATE_DIR/last-digest.txt"
LOG="$STATE_DIR/$(date +%Y-%m).log"
mkdir -p "$STATE_DIR"

BODY="$(/opt/homebrew/bin/python3 "$HOME/.local/bin/mobile-status.py" 2>>"$LOG")"
RC=$?
if [[ $RC -ne 0 || -z "${BODY// }" ]]; then
  echo "$(date '+%F %T') compose failed (rc=$RC)" >> "$LOG"
  exit 1
fi

# The digest is the body minus its timestamp line, so "nothing changed" is not
# defeated by the clock moving.
DIGEST="$(printf '%s' "$BODY" | grep -v '^_' | shasum | cut -d' ' -f1)"
if [[ -f "$LAST" && "$(cat "$LAST")" == "$DIGEST" ]]; then
  # Same state as yesterday. Still report — a daily that goes silent is
  # indistinguishable from a daily that broke — but say so in one line so
  # nobody re-reads a table they have already read.
  BODY="**#mobile — OpenFloor**

_No change since the last report._

${BODY#*$'\n'}"
  echo "$(date '+%F %T') unchanged ($DIGEST) — posting the no-change form" >> "$LOG"
fi

if om room say "$ROOM" --topic "$TOPIC" "$BODY" >> "$LOG" 2>&1; then
  printf '%s' "$DIGEST" > "$LAST"
  echo "$(date '+%F %T') posted ($DIGEST)" >> "$LOG"
  exit 0
fi

# A failed send must not record the digest, or the next hour reads as unchanged
# and the room silently loses the update.
echo "$(date '+%F %T') SEND FAILED — digest not recorded, will retry next hour" >> "$LOG"
exit 6
