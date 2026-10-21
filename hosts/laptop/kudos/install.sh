#!/bin/bash
# Install the kudos routine on the operator's Mac (not oms-mac-mini: ore's Loki
# and Prometheus only answer from this network).
#
# Copies the routine OUT of ~/Documents on purpose: launchd's TCC grant is per
# binary and ~/Documents is protected, so a job reading the repo checkout in
# place can see empty files. ~/.local is not protected.
#
# Usage: tools/kudos/install.sh [--load]
#   --load  also (re)load the launchd job; without it the job is only written
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/kudos"
STATE="$HOME/.local/state/kudos"
BIN="$HOME/.local/bin/om-kudos"
LABEL="com.nicholas.om-kudos"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$DEST" "$STATE/logs" "$HOME/.local/bin"
cp "$SRC"/*.ts "$SRC/PROMPT.md" "$SRC/people.json" "$DEST/"

cat > "$BIN" <<EOF
#!/bin/bash
# Installed by om-agent tools/kudos/install.sh — edit the repo, then re-install.
# Kill switch: touch $STATE/PAUSED
set -euo pipefail
export PATH="\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [[ -e "$STATE/PAUSED" && " \$* " != *" --dry-run "* ]]; then
  echo "paused ($STATE/PAUSED exists)"; exit 0
fi
cd "$DEST"
exec "$(command -v bun)" "$DEST/run.ts" "\$@"
EOF
chmod +x "$BIN"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <!-- Daily: the launch check runs every day; run.ts itself only does the
       weekly pick on Mon/Wed/Fri. 10:15 sits after the 08:47 workflow review.
       12:15 / 15:15 / 18:15 are fallbacks for a 10:15 run lost to sleep or a
       network failure (2026-10-19, 2026-10-21); after a success they no-op. -->
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>15</integer></dict>
    <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>15</integer></dict>
    <dict><key>Hour</key><integer>15</integer><key>Minute</key><integer>15</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>15</integer></dict>
  </array>
  <!-- Without a ProcessType, launchd throttles the job's CPU and I/O as
       background work: measured 2026-10-12, the GitLab read took 4.5 min
       under launchd against 1.3 min from a shell. -->
  <key>ProcessType</key><string>Standard</string>
  <key>StandardOutPath</key><string>$STATE/logs/launchd.out</string>
  <key>StandardErrorPath</key><string>$STATE/logs/launchd.err</string>
</dict>
</plist>
EOF

echo "installed $DEST, $BIN, $PLIST"
if [[ "${1:-}" == "--load" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "loaded $LABEL"
fi
