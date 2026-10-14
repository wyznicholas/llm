#!/bin/bash
# Rails smoke test. Proves what midnight-run.sh exists to guarantee, without
# spending a single Claude token: the wall-clock cap kills the whole process
# group, a second run refuses to double up, a crashed lock is reclaimed rather
# than disabling the routine forever, and exit 0 without a report is not a
# clean day.
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"

# The seed defaults WORKSPACE to $HOME/repos, which exists on the mini and NOT
# here — leaving it unset makes `cd "$WORKSPACE"` fail and every check below
# exit 1 for the wrong reason.
export ROUTINE_WORKSPACE="$HOME/.local/share/midnight-scout/workspace"
# Check 4 deliberately provokes the "exited 0 without a report" warning, which
# posts. Send the whole suite to the scouting server so running the tests never
# pages the real #om-agent-test.
export SCOUT_REPORT_ROOM="2c9c5d214e3a"

SKILL="rails-selftest"
STATE="$HOME/.local/state/routines/$SKILL"
FAILED=0

ok()   { echo "  ok   — $1"; }
fail() { echo "  FAIL — $1"; FAILED=1; }

rm -rf "$STATE"

echo "1. wall-clock cap reaps the process group"
# A child that outlives its parent is the leak that matters: signalling only the
# parent leaves chromium and dev servers running. Spawn a grandchild and assert
# the cap kills it too.
MARKER="$(mktemp -t railsmarker)"
ROUTINE_TIME_LIMIT=3 ROUTINE_KILL_GRACE=1 \
ROUTINE_TEST_CMD="( sleep 30; echo leaked >> '$MARKER' ) & sleep 30" \
  midnight-run.sh "$SKILL" >/dev/null 2>&1
sleep 6
if [[ -s "$MARKER" ]]; then fail "grandchild survived the cap"; else ok "grandchild reaped"; fi
rm -f "$MARKER"

echo "2. a second run does not double up"
rm -rf "$STATE"; mkdir -p "$STATE/run.lock"
ROUTINE_TIME_LIMIT=5 ROUTINE_TEST_CMD="echo should-not-run" midnight-run.sh "$SKILL" >/dev/null 2>&1
RC=$?
if [[ "$RC" -eq 0 ]] && grep -q "already running" "$STATE"/*.log 2>/dev/null; then
  ok "second run stood down"
else
  fail "second run did not stand down cleanly (rc=$RC)"
fi

echo "3. a stale lock is reclaimed"
# Backdate the lock past LIMIT+300 so it cannot belong to a live run.
touch -t "$(date -v-2H '+%Y%m%d%H%M')" "$STATE/run.lock"
ROUTINE_TIME_LIMIT=5 ROUTINE_TEST_CMD="echo reclaimed-run" midnight-run.sh "$SKILL" >/dev/null 2>&1
if grep -q "reclaiming" "$STATE"/*.log 2>/dev/null; then ok "stale lock reclaimed"; else fail "stale lock not reclaimed"; fi

echo "4. exit 0 with no report is not a clean day"
rm -rf "$STATE"
ROUTINE_TIME_LIMIT=5 ROUTINE_TEST_CMD="true" midnight-run.sh "$SKILL" >/dev/null 2>&1
RC=$?
if [[ "$RC" -eq 4 ]]; then ok "no-report run exited 4"; else fail "no-report run exited $RC, expected 4"; fi

echo "5. budget exhausted before the first phase exits 5"
# LIMIT=0 puts the deadline in the past before the loop's very first REMAIN
# check, so no phase (and no ROUTINE_TEST_CMD) ever runs -- this proves the
# budget-exhaustion branch's STATUS=5 survives to the real exit code. It used
# to lose: line 234's post-loop `STATUS=$FINAL_STATUS` clobbered it back to 0
# because FINAL_STATUS only moves on a failed phase, never on budget
# exhaustion -- a dead night exiting 0 and looking like a quiet one.
rm -rf "$STATE"
ROUTINE_TIME_LIMIT=0 midnight-run.sh "$SKILL" >/dev/null 2>&1
RC=$?
if [[ "$RC" -eq 5 ]]; then ok "budget-exhausted run exited 5"; else fail "budget-exhausted run exited $RC, expected 5"; fi

echo "6. a failing preflight aborts the night"
PFDIR="$HOME/.local/share/midnight-scout/workspace/.claude/skills/$SKILL"
mkdir -p "$PFDIR"
printf '#!/bin/bash\nexit 3\n' > "$PFDIR/preflight"; chmod +x "$PFDIR/preflight"
rm -rf "$STATE"
ROUTINE_TIME_LIMIT=5 ROUTINE_TEST_CMD="echo must-not-run" midnight-run.sh "$SKILL" >/dev/null 2>&1
RC=$?
if [[ "$RC" -ne 0 ]] && ! grep -q "must-not-run" "$STATE"/*.log 2>/dev/null; then
  ok "failing preflight aborted before the work ran"
else
  fail "failing preflight did not abort (rc=$RC)"
fi

echo "7. a passing preflight lets the night run"
printf '#!/bin/bash\nexit 0\n' > "$PFDIR/preflight"; chmod +x "$PFDIR/preflight"
rm -rf "$STATE"
ROUTINE_TIME_LIMIT=5 ROUTINE_TEST_CMD="scout-report.sh 'preflight-ok'" midnight-run.sh "$SKILL" >/dev/null 2>&1
if grep -q "preflight-ok" "$STATE"/*.log 2>/dev/null; then ok "passing preflight ran the work"; else fail "passing preflight blocked the work"; fi
rm -rf "$PFDIR"

echo "8. the scout preflight passes against the live daemon"
SCOUT_PF="$HOME/.local/share/midnight-scout/workspace/.claude/skills/midnight-scout/preflight"
if [[ -x "$SCOUT_PF" ]]; then
  ROUTINE_WORK="$(mktemp -d)" "$SCOUT_PF" >/dev/null 2>&1 \
    && ok "scout preflight passed" || fail "scout preflight failed against the live daemon"
else
  fail "scout preflight missing or not executable"
fi

echo "9. midnight-run.sh actually writes bundle-stamp.txt through the real preflight"
# Checks 6-8 proved the gate aborts/passes and that the preflight script itself
# works — but check 8 calls the preflight directly, bypassing midnight-run.sh
# entirely. The real bug (ROUTINE_WORK exported at line ~130, preflight invoked
# at line ~70) only shows up on the real integration path: run it THROUGH
# midnight-run.sh, with no `phases` file so this stays single-shot and never
# spins up the real 10-phase midnight-scout skill, and assert the stamp file
# midnight-run.sh's own ROUTINE_WORK points at actually exists and is non-empty.
STAMP_SKILL="rails-selftest-stamp"
STAMP_PFDIR="$HOME/.local/share/midnight-scout/workspace/.claude/skills/$STAMP_SKILL"
STAMP_STATE="$HOME/.local/state/routines/$STAMP_SKILL"
mkdir -p "$STAMP_PFDIR"
cp "$HOME/.local/share/midnight-scout/workspace/.claude/skills/midnight-scout/preflight" "$STAMP_PFDIR/preflight"
chmod +x "$STAMP_PFDIR/preflight"
rm -rf "$STAMP_STATE"
ROUTINE_TIME_LIMIT=5 ROUTINE_TEST_CMD="echo stamp-check-ran" midnight-run.sh "$STAMP_SKILL" >/dev/null 2>&1
STAMP_FILE="$STAMP_STATE/$(date +%Y-%m-%d).work/bundle-stamp.txt"
if [[ -s "$STAMP_FILE" ]]; then
  ok "bundle-stamp.txt written through midnight-run.sh ($(cat "$STAMP_FILE"))"
else
  fail "bundle-stamp.txt missing or empty after a real midnight-run.sh run — preflight ran before ROUTINE_WORK existed"
fi
rm -rf "$STAMP_PFDIR" "$STAMP_STATE"

# --- checks 10-17: the four endings that used to look like a quiet night -----
# Every check below was run against the UNFIXED scripts first; each one failed
# there. A check that passes either way proves nothing.

echo "10. a report that never reached chat is not a clean night"
# Critical 1: scout-report.sh mirrors the body into $ROUTINE_REPORT_FILE BEFORE
# it sends and returns 0 either way (deliberately — a night that found real bugs
# is not a failed night because chat was down). So a delivery failure used to
# leave a non-empty report file and exit 0: findings sat unread in
# ~/.local/state/routines/undelivered/ while the run reported a clean day.
#
# Delivery is broken by giving the run a HOME whose .local/bin has the two
# scripts but no `om` (it exists nowhere else on PATH). That is also why this
# check cannot post anywhere: nothing can reach chat at all. State, the mirror
# and the fallback dir all land under the temp HOME, so the real ones are
# untouched.
TMPHOME="$(mktemp -d)"
mkdir -p "$TMPHOME/.local/bin"
ln -s "$(command -v midnight-run.sh)" "$TMPHOME/.local/bin/midnight-run.sh"
ln -s "$(command -v scout-report.sh)" "$TMPHOME/.local/bin/scout-report.sh"
HOME="$TMPHOME" ROUTINE_TIME_LIMIT=20 \
ROUTINE_TEST_CMD='scout-report.sh "rails-selftest: pretend finding"' \
  "$TMPHOME/.local/bin/midnight-run.sh" "$SKILL" >/dev/null 2>&1
RC=$?
TH_STATE="$TMPHOME/.local/state/routines/$SKILL"
if [[ "$RC" -eq 6 ]] \
   && grep -q "pretend finding" "$TH_STATE/$(date +%Y-%m-%d).report.md" 2>/dev/null \
   && ls "$TMPHOME/.local/state/routines/undelivered/"*.md >/dev/null 2>&1; then
  ok "undelivered report exited 6, finding text survived in the mirror"
else
  fail "undelivered report exited $RC (expected 6) or lost its text"
fi
rm -rf "$TMPHOME"

echo "11. a phases file that exists but cannot be read is fatal"
# Critical 4: `[[ -r ]]` is false for "absent" AND for "present but unreadable"
# (a chmod, or a Full Disk Access denial on ~/Documents). Unreadable used to
# fall through to PHASES=(""), which is ONE unphased session — no phase logs, no
# budget floor, no digest guarantee — reporting as a healthy night. Unfixed this
# ran the work and exited 4; fixed it refuses to start.
PHDIR="$HOME/.local/share/midnight-scout/workspace/.claude/skills/$SKILL"
mkdir -p "$PHDIR"; printf 'p1\np2\n' > "$PHDIR/phases"; chmod 000 "$PHDIR/phases"
rm -rf "$STATE"
ROUTINE_TIME_LIMIT=5 ROUTINE_TEST_CMD='echo "must-not-run:$ROUTINE_PHASE"' \
  midnight-run.sh "$SKILL" >/dev/null 2>&1
RC=$?
if [[ "$RC" -eq 1 ]] && grep -q "phases file exists but is unreadable" "$STATE"/*.log 2>/dev/null \
   && ! grep -q "must-not-run" "$STATE"/*.log 2>/dev/null; then
  ok "unreadable phases file aborted the night instead of degrading it"
else
  fail "unreadable phases file did not abort (rc=$RC, expected 1)"
fi
chmod 644 "$PHDIR/phases"; rm -rf "$PHDIR"

echo "12. standing down on a live lock pages the room"
# Critical 2: with an 8h budget a stale lock is not reclaimable until LIMIT+300
# (08:05), so a hung night made the NEXT night stand down in total silence —
# indistinguishable from a sleeping machine. Exit 0 is still right here (the
# lock's owner owns tonight's report); the page is the fix. Check 2 above still
# guards the exit code and the log line.
rm -rf "$STATE"; mkdir -p "$STATE/run.lock"
ROUTINE_TIME_LIMIT=5 ROUTINE_TEST_CMD="echo should-not-run" midnight-run.sh "$SKILL" >/dev/null 2>&1
RC=$?
if [[ "$RC" -eq 0 ]] && grep -q "stood down" "$STATE"/*.log 2>/dev/null; then
  ok "stand-down paged before exiting 0"
else
  fail "stand-down did not page (rc=$RC)"
fi
rm -rf "$STATE"

echo "13. an unreachable workspace pages before dying"
# Critical 3: the observed failure class on this machine is a TCC (Full Disk
# Access) denial on ~/Documents. `cd` failed, the run exited 1, and not one word
# reached chat.
rm -rf "$STATE"
ROUTINE_WORKSPACE="/nonexistent/midnight-scout-workspace" ROUTINE_TIME_LIMIT=5 \
ROUTINE_TEST_CMD="echo should-not-run" midnight-run.sh "$SKILL" >/dev/null 2>&1
RC=$?
if [[ "$RC" -eq 1 ]] && grep -q "cannot enter its workspace" "$STATE"/*.log 2>/dev/null; then
  ok "unreachable workspace paged before exiting 1"
else
  fail "unreachable workspace did not page (rc=$RC)"
fi
rm -rf "$STATE"

echo "14. budget exhaustion skips normal phases but still runs '!' phases"
# Important 6a: the REMAIN<=0 branch used `break`, which leaves the loop and
# takes the always-run phases with it — teardown AND the guaranteed `!digest`.
# LIMIT=0 puts the deadline in the past before the first phase, so p1 never
# starts and only the `!` phase (which gets its own 120s floor) may run.
PHDIR="$HOME/.local/share/midnight-scout/workspace/.claude/skills/$SKILL"
mkdir -p "$PHDIR"; printf 'p1\n!teardown\n' > "$PHDIR/phases"
rm -rf "$STATE"
ROUTINE_TIME_LIMIT=0 ROUTINE_TEST_CMD='echo "phase-ran:$ROUTINE_PHASE"' \
  midnight-run.sh "$SKILL" >/dev/null 2>&1
RC=$?
if [[ "$RC" -eq 5 ]] && grep -q "phase-ran:teardown" "$STATE"/*.log 2>/dev/null \
   && ! grep -q "phase-ran:p1" "$STATE"/*.log 2>/dev/null; then
  ok "'!' phase ran after the budget was gone, normal phase did not"
elif ! grep -q "phase-ran:teardown" "$STATE"/*.log 2>/dev/null; then
  fail "budget exhaustion skipped the '!' phase entirely (rc=$RC) -- a bare break took teardown with it"
else
  fail "budget exhaustion mishandled the phases (rc=$RC, expected 5)"
fi
rm -rf "$PHDIR" "$STATE"

echo "15. a night whose digest never reported is not a clean night"
# Important 6b: the exit-4 sentinel measured "somebody called scout-report.sh",
# not "the digest ran". Once any phase can page, a night whose digest died still
# leaves a non-empty report file — a mid-night note standing in for the night's
# verdict. Here p1 reports and `digest` does not.
PHDIR="$HOME/.local/share/midnight-scout/workspace/.claude/skills/$SKILL"
mkdir -p "$PHDIR"; printf 'p1\n!digest\n' > "$PHDIR/phases"
rm -rf "$STATE"
ROUTINE_TIME_LIMIT=60 \
ROUTINE_TEST_CMD='[ "$ROUTINE_PHASE" = digest ] || scout-report.sh "rails-selftest: mid-night note, not a digest (ignore)"' \
  midnight-run.sh "$SKILL" >/dev/null 2>&1
RC=$?
if [[ "$RC" -eq 4 ]] && grep -q "the digest never reported" "$STATE"/*.log 2>/dev/null; then
  ok "missing digest exited 4 despite a non-empty report file"
else
  fail "missing digest exited $RC, expected 4"
fi
# Control: the same shape with a digest that DOES report must still be a clean
# night. Without this the check above would pass just as happily if the digest
# marker were never written by anybody, which would fail every phased night.
rm -rf "$STATE"
ROUTINE_TIME_LIMIT=60 \
ROUTINE_TEST_CMD='scout-report.sh "rails-selftest: $ROUTINE_PHASE report (ignore)"' \
  midnight-run.sh "$SKILL" >/dev/null 2>&1
RC=$?
if [[ "$RC" -eq 0 ]]; then
  ok "a night whose digest did report exits 0"
else
  fail "a night with a reporting digest exited $RC, expected 0"
fi
rm -rf "$PHDIR" "$STATE"

echo "16. a quoted rate-limit string cannot defer a real failure"
# Important 5: the deferral branch grepped the whole CUMULATIVE day log for
# "hit your .* limit" and exited 0. That log carries the routine's own
# transcript, and this routine reads chat UI text for a living — so quoting a
# rate-limit banner in a finding, or one earlier run in the same day hitting a
# real limit, converted every later genuine failure into "deferred, exit 0".
# Two runs share one day log here: the first quotes the string, the second fails
# for real (and quotes it again, early, with filler after it so it falls outside
# the run's tail).
rm -rf "$STATE"
ROUTINE_TIME_LIMIT=30 \
ROUTINE_TEST_CMD='echo "finding: the banner reads You have hit your usage limit, resets 3pm"; scout-report.sh "rails-selftest: quoted-limit run 1 (ignore)"' \
  midnight-run.sh "$SKILL" >/dev/null 2>&1
ROUTINE_TIME_LIMIT=30 \
ROUTINE_TEST_CMD='echo "finding: the banner reads You have hit your usage limit, resets 3pm"; i=0; while [ $i -lt 30 ]; do echo "audit line $i"; i=$((i+1)); done; exit 9' \
  midnight-run.sh "$SKILL" >/dev/null 2>&1
RC=$?
if [[ "$RC" -eq 9 ]] && ! grep -q "deferred by Claude usage limit" "$STATE"/*.log 2>/dev/null; then
  ok "quoted limit text did not mask a failing phase (exit 9 preserved)"
else
  fail "quoted limit text masked a real failure (rc=$RC, expected 9)"
fi
rm -rf "$STATE"

echo "17. the watchdog does not inherit the lock-releasing EXIT trap"
# Important 7: `trap 'rmdir "$LOCK"' EXIT` is set in the parent, and the cap
# watchdog is a `( ... ) &` subshell. Where a shell runs the parent's EXIT trap
# on a subshell's normal exit, the watchdog releases a LIVE lock mid-night once
# it has fired the cap and slept out ROUTINE_KILL_GRACE. bash 3.2.57 here does
# NOT do that (probed directly: a background subshell exiting normally left the
# lock in place), so no behavioural check can distinguish the two versions on
# this machine — this asserts the source instead, which is honest about being a
# structural check rather than pretending to be a live one.
MRUN="$(command -v midnight-run.sh)"
if grep -B8 'sleep "\$REMAIN"' "$MRUN" | grep -q '^ *trap - EXIT'; then
  ok "watchdog subshell clears the EXIT trap before it can fire"
else
  fail "watchdog subshell still inherits the parent's lock-releasing EXIT trap"
fi

rm -rf "$STATE"
exit "$FAILED"
