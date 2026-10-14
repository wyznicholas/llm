#!/bin/bash
# Phase 2 script tests. Pure shell, no vault access, no chat posts.
set -uo pipefail
SKILL="$HOME/.local/share/midnight-scout/workspace/.claude/skills/midnight-scout"
export PATH="$HOME/.local/bin:$PATH"
FAILED=0
ok()   { echo "  ok   — $1"; }
fail() { echo "  FAIL — $1"; FAILED=1; }
eq()   { if [[ "$2" == "$3" ]]; then ok "$1"; else fail "$1 (got '$2', want '$3')"; fi; }

# Sections for refs.sh (ref allocation) and arcs.sh (the 4-arc throttle) were
# removed on 2026-09-11 with the scripts themselves. midnight-scout no longer
# allocates refs or spawns om-task: om-play-around files raw cards and the
# om-bug-loop watcher consumes them, so `kanban.ts next-ref` is the single
# allocator. That is what ended the T67/T68 double-assignment, and a test for a
# second allocator would be a test for the bug.

echo "3. the audit mark is defined exactly once"
. "$SKILL/scripts/audit-mark.sh"
eq "AUDIT_MARK value" "$AUDIT_MARK" '**Audited** '
grep -q 'audit-mark.sh' "$SKILL/scripts/stamp.sh"        && ok "stamp.sh sources the mark"        || fail "stamp.sh hardcodes the mark"
grep -q 'audit-mark.sh' "$SKILL/scripts/slice-filter.sh" && ok "slice-filter.sh sources the mark" || fail "slice-filter.sh hardcodes the mark"

echo "4. stamp.sh emits a line the filter recognises"
STAMP="$("$SKILL/scripts/stamp.sh" 2026-09-10 v=abc123 deadbee "[[note]]" 3)"
case "$STAMP" in *"$AUDIT_MARK"*) ok "stamp contains the mark" ;; *) fail "stamp missing the mark" ;; esac
case "$STAMP" in *2026-09-10*)    ok "stamp carries the date" ;; *) fail "stamp missing date" ;; esac
case "$STAMP" in *v=abc123*)      ok "stamp carries the bundle" ;; *) fail "stamp missing bundle" ;; esac

echo "5. slice-filter drops stamped files and keeps unstamped ones"
REAL='**Audited** 2026-09-09 by midnight-scout (Phase 1 hand-run night) — bundle `v=f7022243b5e7`'
OUT=$(printf 'composer-autocomplete.md\t%s\ncomposer-drafts.md\t\ndoc-pane.md\t\n' "$REAL" | "$SKILL/scripts/slice-filter.sh")
eq "stamped dropped" "$(echo "$OUT" | grep -c 'composer-autocomplete')" "0"
eq "unstamped kept"  "$(echo "$OUT" | grep -c '\.md')"                  "2"

echo "6. the Phase 0 regression, end to end through the real scripts"
MADE="$("$SKILL/scripts/stamp.sh" 2026-09-10 v=abc123 deadbee "[[note]]" 2 | tr -d '\n')"
LEFT=$(printf 'x.md\t%s\n' "$MADE" | "$SKILL/scripts/slice-filter.sh" | wc -l | tr -d ' ')
eq "stamp.sh output is recognised by slice-filter.sh" "$LEFT" "0"
LEFT2=$(printf 'y.md\t%s\n' "$REAL" | "$SKILL/scripts/slice-filter.sh" | wc -l | tr -d ' ')
eq "Phase 1's real stamp is recognised too" "$LEFT2" "0"

echo "11. discord-ref.sh fails loudly rather than writing a bogus file"
BOGUS="$(mktemp -d)/shot.png"
SCOUT_DISCORD_APP="/Applications/NoSuchApp.app" "$SKILL/scripts/discord-ref.sh" "$BOGUS" >/dev/null 2>&1 \
  && fail "missing app still reported success" || ok "missing app rejected"
[[ -s "$BOGUS" ]] && fail "wrote a file despite failing" || ok "no bogus file written"

echo "11b. blankcheck tells a painted window from an un-painted one"
FIXDIR="$(mktemp -d)"
python3 - "$FIXDIR" <<'PYEOF'
import struct, sys, zlib
d = sys.argv[1]
def png(path, rows, w, h):
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    def chunk(t, data):
        c = t + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
w = h = 64
png(f"{d}/blank.png", [[40, 42, 54] * w for _ in range(h)], w, h)
png(f"{d}/painted.png",
    [[v for x in range(w) for v in ((x * 4 + y) % 256, (y * 7) % 256, (x * x + y) % 256)]
     for y in range(h)], w, h)
PYEOF
swift "$SKILL/scripts/blankcheck.swift" "$FIXDIR/blank.png" >/dev/null 2>&1
eq "a flat window is called BLANK" "$?" "8"
swift "$SKILL/scripts/blankcheck.swift" "$FIXDIR/painted.png" >/dev/null 2>&1
eq "a drawn window is called painted" "$?" "0"
swift "$SKILL/scripts/blankcheck.swift" "$FIXDIR/absent.png" >/dev/null 2>&1
eq "an unreadable file is refused, not passed" "$?" "9"
rm -rf "$FIXDIR"

echo "12. an app with no capturable window never yields a desktop screenshot"
# The defect this pins: an earlier version fell back to a full-screen capture,
# silently writing a picture of the wallpaper that looked like a real reference.
NOWIN="$(mktemp -d)/nowin.png"
SCOUT_DISCORD_PROC="NoSuchProcessXYZ" "$SKILL/scripts/discord-ref.sh" "$NOWIN" >/dev/null 2>&1 \
  && fail "no-window case reported success" || ok "no-window case rejected"
[[ -e "$NOWIN" ]] && fail "wrote a screenshot despite having no window to capture" || ok "wrote nothing rather than the desktop"

echo "13. the window enumerator works and is honest about absence"
command -v swift >/dev/null 2>&1 && ok "swift available for window enumeration" || fail "swift missing"
eq "unknown app yields no windows" "$(swift "$SKILL/scripts/winlist.swift" NoSuchProcessXYZ 2>/dev/null | wc -l | tr -d ' ')" "0"

echo "14. the unattended night refuses the known-destructive git verbs"
grep -q 'disallowedTools' "$HOME/.local/bin/midnight-run.sh" \
  && ok "midnight-run.sh carries a deny list" || fail "no deny list — an 8h unattended agent can git stash / git add -A"
grep -q 'git stash' "$HOME/.local/bin/midnight-run.sh" \
  && ok "git stash denied (shared refs/stash across worktrees)" || fail "git stash not denied"
grep -q 'git add -A' "$HOME/.local/bin/midnight-run.sh" \
  && ok "git add -A denied (node_modules symlink breaks CI)" || fail "git add -A not denied"

exit "$FAILED"
