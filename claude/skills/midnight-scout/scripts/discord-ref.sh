#!/bin/bash
# Capture a Discord reference screenshot — or fail loudly.
#
# Environment facts this encodes, all measured 2026-09-09/10 on this laptop:
#  - Screen Recording IS granted; `screencapture` works.
#  - Accessibility is NOT granted: osascript gets "-1728 not allowed assistive
#    access", so System Events cannot enumerate, front, or un-minimise windows.
#  - `lsappinfo` returns NULL for every window-count key, so it cannot answer
#    "does Discord have a window" either.
#  - CoreGraphics via `swift` CAN enumerate windows, and is what this uses.
#  - A window can be listed AND capturable AND still be un-painted. That case
#    produces a valid PNG of the right size in a flat colour, which no
#    file-size guard can distinguish from a real capture. It degraded every
#    reference for six consecutive nights (2026-09-06..11) while this script
#    reported success, so blankcheck.swift now looks at the pixels.
#
# THE RULE THIS SCRIPT EXISTS TO ENFORCE: never fall back to a full-screen
# capture. An earlier version did, and when Discord had no restored window it
# silently wrote a picture of the desktop wallpaper and reported success — a
# useless reference that looked like a real one. A missing reference must be
# visibly missing so the card falls back to a written reference and a
# `reference wanted` line.
#
# Privacy: capturing ONE window (never the screen) is also what keeps other
# apps and any DM list out of the frame.
set -uo pipefail

OUT="${1:?usage: discord-ref.sh <out.png>}"
APP="${SCOUT_DISCORD_APP:-/Applications/Discord.app}"
NAME="${SCOUT_DISCORD_PROC:-Discord}"
HERE="$(cd "$(dirname "$0")" && pwd)"

[[ -d "$APP" ]] || { echo "discord-ref: $APP not installed" >&2; exit 2; }
command -v swift >/dev/null 2>&1 || { echo "discord-ref: swift not available; cannot enumerate windows" >&2; exit 5; }

open -a "$APP" 2>/dev/null || { echo "discord-ref: could not front $APP" >&2; exit 3; }
sleep 3   # the window manager needs a beat before a restored window is on screen

WID="$(swift "$HERE/winlist.swift" "$NAME" 2>/dev/null | head -1 | cut -f1)"
if [[ -z "${WID:-}" ]]; then
  echo "discord-ref: $NAME has no on-screen window — cannot capture a reference." >&2
  echo "discord-ref: restore its window by hand, or file the finding with a written reference and a 'reference wanted' line." >&2
  exit 6
fi

TMP="$(mktemp -t discordref).png"
if ! screencapture -x -o -l "$WID" "$TMP" 2>/dev/null || [[ ! -s "$TMP" ]]; then
  rm -f "$TMP"
  echo "discord-ref: window $WID is listed but not capturable (minimised, or on another Space)." >&2
  echo "discord-ref: NOT falling back to a screen capture — that yields a picture of the desktop that looks like a real reference." >&2
  exit 7
fi

# The window exists and captured cleanly — but is anything actually DRAWN on
# it? A restored-but-unpainted window yields a flat image that passes every
# check above. This is the guard whose absence made six nights of references
# silently worthless.
VERDICT="$(swift "$HERE/blankcheck.swift" "$TMP" 2>&1)"
RC=$?
if [[ $RC -eq 8 ]]; then
  rm -f "$TMP"
  echo "discord-ref: window $WID captured but is UN-PAINTED ($VERDICT)." >&2
  echo "discord-ref: Discord is probably still loading, or the window is offscreen-composited." >&2
  echo "discord-ref: NOT writing it — a flat image looks like a real reference and is not one." >&2
  echo "discord-ref: give Discord longer to paint, or file with a written reference and a 'reference wanted' line." >&2
  exit 8
elif [[ $RC -ne 0 ]]; then
  rm -f "$TMP"
  echo "discord-ref: could not verify the capture is painted ($VERDICT)." >&2
  echo "discord-ref: refusing rather than writing an unverified reference." >&2
  exit 9
fi

mkdir -p "$(dirname "$OUT")"
mv "$TMP" "$OUT"
echo "$OUT  ($VERDICT)"
