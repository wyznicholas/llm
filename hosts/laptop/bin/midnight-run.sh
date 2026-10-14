#!/bin/bash
# Run one daily code-health routine headlessly under launchd.
#
# Usage: midnight-run.sh <skill-name>   e.g. midnight-run.sh routine-crash-fuzz-chrome
# Laptop-local: runs entirely on this machine, no other host involvement.
#
# macOS ships no `timeout(1)`, so the wall-clock cap is enforced here with a
# watchdog against the job's own process group (`set -m` puts the job in its
# own pgid, so killing -PGID reaps claude's whole subprocess tree — dev servers,
# daemon pairs and headless chromium included, which is the part that actually
# leaks if you only signal the parent).
#
# Exit codes. The whole point of this runner is that a QUIET night and a DEAD
# night must never look the same, so every ending gets its own code and every
# early ending pages chat before it goes:
#   0  the routine ran and its report reached chat (or another run holds the
#      lock and owns tonight's report -- see the stand-down below)
#   1  fatal environment/config error before any work: workspace unreachable,
#      preflight failed, phases file unreadable
#   4  exit 0 but nothing was reported -- no digest (phased skills) or no report
#      at all (single-shot skills). Exit 0 is not proof of work.
#   5  the wall-clock budget ran out
#   6  a report was produced but never reached chat. scout-report.sh keeps
#      returning 0 on a delivery failure by design; this is how the RUN says so.
#   7  a stale lock could not be reclaimed, so nothing ran at all
#   *  otherwise, the failing phase's own exit status
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"


SKILL="${1:?usage: midnight-run.sh <skill-name>}"
LIMIT="${ROUTINE_TIME_LIMIT:-3600}"     # hard cap, seconds
GRACE="${ROUTINE_KILL_GRACE:-30}"       # SIGTERM → SIGKILL grace
WORKSPACE="${ROUTINE_WORKSPACE:-$HOME/.local/share/midnight-scout/workspace}"
STATE="$HOME/.local/state/routines/$SKILL"
TODAY="$(date +%Y-%m-%d)"
LOG="$STATE/$TODAY.log"

mkdir -p "$STATE"
{
  echo "=== $SKILL run $(date '+%Y-%m-%d %H:%M:%S %Z') on $(hostname -s) ==="
  echo "workspace=$WORKSPACE limit=${LIMIT}s"
} >> "$LOG"

# Where this run's own output starts. $LOG is per-DAY, not per-run: a retry, a
# manual run and the scheduled run all append to it. Any "did this process print
# X" question must therefore be asked of this run's lines only -- see the
# usage-limit check at the end, which used to scan the whole day.
LOG_MARK=$(wc -l < "$LOG" | tr -d ' ')

# Every early exit below is a night that produced nothing, and an operator
# glancing at chat must be able to tell that from a night that found nothing.
# So: page first, exit second -- and if the page itself never reached chat,
# leave with 6 rather than the code we meant, because at that point the log is
# the only surviving record and the exit status is all the operator has.
# The marker is PID-scoped, not the run's $ROUTINE_UNDELIVERED_FILE: on the
# stand-down path a live run owns that file and this process must not touch it.
page_and_exit() {
  local _rc="$1"; shift
  local _mark="$STATE/.page.$$"
  rm -f "$_mark"
  ROUTINE_UNDELIVERED_FILE="$_mark" scout-report.sh "$@" >> "$LOG" 2>&1 || true
  if [[ -s "$_mark" ]]; then
    echo "midnight-run: that page never reached chat ($(cat "$_mark")) -- exiting 6, not $_rc" >> "$LOG"
    rm -f "$_mark"
    exit 6
  fi
  rm -f "$_mark"
  exit "$_rc"
}

# A run already in flight (previous day overran, or a manual run is going)
# must not be doubled up: two fuzzers fight over the same strict ports.
LOCK="$STATE/run.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  # A lock older than the cap cannot belong to a live run — it is debris from a
  # crash, a power loss, or a SIGKILL. Without this, one hard crash silently
  # disables the routine forever, which is the worst failure a daily bot has:
  # it looks like "no findings" rather than "not running".
  LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || date +%s) ))
  if (( LOCK_AGE > LIMIT + 300 )); then
    echo "midnight-run: stale lock (${LOCK_AGE}s old, cap ${LIMIT}s) — reclaiming" >> "$LOG"
    rmdir "$LOCK" 2>/dev/null || rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || {
      # The lock was already judged debris, and clearing it still failed: a
      # permissions problem or a damaged state dir. Nobody holds it, so nobody
      # will report tonight either -- this is the runner failing, not a
      # stand-down, and it exits non-zero.
      echo "midnight-run: could not reclaim lock, skipping" >> "$LOG"
      page_and_exit 7 "⚠️ **$SKILL** could not start on $(hostname -s) ($TODAY) — the stale lock \`$LOCK\` could not be reclaimed, so no audit ran at all. Log: \`$LOG\`"
    }
  else
    # Standing down was silent until now, and silence is the one thing this
    # runner may not do: with an 8h cap a stale lock is not reclaimable until
    # LIMIT+300, so a hung night makes the NEXT night stand down -- and a night
    # that never ran looked exactly like a sleeping machine.
    #
    # Exit 0 stays right HERE, unlike the reclaim failure above: the lock is
    # young enough to belong to a live run, that run owns tonight's report, and
    # failing this invocation would blame it for someone else's night. The page
    # is the fix; the exit code is not.
    echo "midnight-run: $SKILL already running (lock $LOCK, ${LOCK_AGE}s old), skipping" >> "$LOG"
    page_and_exit 0 "⏭ **$SKILL** stood down on $(hostname -s) ($TODAY) — another run has held the lock \`$LOCK\` for ${LOCK_AGE}s, so tonight's run did not start. If no report follows from that run, it is hung. Log: \`$LOG\`"
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# The routine runs INSIDE this lock, and a routine that inspects its own state
# directory finds the lock plus a live `claude -p /<skill>` process. On
# 2026-08-20 routine-ant-shipper read exactly that, concluded a competing run was
# already in flight, stood down without doing any work, and still exited 0.
# So say plainly whose lock it is.
export ROUTINE_RUN_PID="$$"
export ROUTINE_LOCK_HELD="$LOCK"
export ROUTINE_SKILL="$SKILL"
# scout-report.sh mirrors every delivered report here, which is what lets this
# script tell "nothing worth doing" (a report) from "did nothing" (no report).
export ROUTINE_REPORT_FILE="$STATE/$TODAY.report.md"
# ...but a mirrored body only proves a report was WRITTEN. scout-report.sh
# appends here when `om room say` fails, which is the only way this script can
# learn that the night's findings never reached a human (see exit 6).
export ROUTINE_UNDELIVERED_FILE="$STATE/$TODAY.undelivered"
# And the digest -- the one report a night is judged on -- stamps this, so the
# sentinel at the end can ask "did the DIGEST report?" instead of the much
# weaker "did anybody report?".
export ROUTINE_DIGEST_FILE="$STATE/$TODAY.digest"
rm -f "$ROUTINE_REPORT_FILE" "$ROUTINE_UNDELIVERED_FILE" "$ROUTINE_DIGEST_FILE"

# A workspace that cannot be entered is the failure class already seen on this
# machine: a macOS Full Disk Access denial on ~/Documents. It used to exit 1
# with nothing but a log line nobody reads, which is a dead night wearing a
# quiet night's face.
cd "$WORKSPACE" || {
  echo "midnight-run: cannot cd to $WORKSPACE" >> "$LOG"
  page_and_exit 1 "⚠️ **$SKILL** could not start on $(hostname -s) ($TODAY) — cannot enter its workspace \`$WORKSPACE\` (missing, or a Full Disk Access denial). No audit ran. Log: \`$LOG\`"
}

# --- phases -----------------------------------------------------------------
# A skill may ship a `phases` file: one phase name per line. When it does, the
# routine runs as several short sessions instead of one long one, handing state
# between them through $ROUTINE_HANDOFF.
#
# Why: a session re-sends its whole conversation every turn, so cost is roughly
# turns x (baseline + handoff) + work/sessions -- quadratic in session length.
# Measured on logic-simplifier 2026-08-27: one 350-turn session cost 53.5M
# tokens to produce 222K of output, a 240:1 ratio, and 80% of that was context
# growth rather than work. Splitting the same work five ways drops it ~60%.
# Restarting itself is free: the ~30K baseline is re-read every turn regardless,
# so N restarts cost nothing extra -- only a FAT handoff does, because it too is
# re-read on every turn of every phase. Keep the handoff to decisions and small
# tables, and put paths to anything large.
#
# A skill with no `phases` file runs exactly as before: one session, unchanged.
# A skill may pin its model in a `model` file beside its `phases` file. Absent means the
# session default (Opus), which stays the default deliberately: a routine that makes a
# correctness claim -- "these two implementations are identical", "this behaviour is a bug" --
# is not somewhere to save money. Pin a cheaper model only where the proof is mechanical and
# the routine's own rules already make it check its work.
MODEL_FILE="$WORKSPACE/.claude/skills/$SKILL/model"
MODEL=""
if [[ -r "$MODEL_FILE" ]]; then
  # First non-comment line, so the file can carry the reason it was pinned. A model choice
  # without its justification is the kind of thing nobody dares change later.
  while IFS= read -r _m || [[ -n "$_m" ]]; do
    _m="${_m%%#*}"
    _m="$(echo "$_m" | tr -d '[:space:]')"
    if [[ -n "$_m" ]]; then MODEL="$_m"; break; fi
  done < "$MODEL_FILE"
fi

PHASES_FILE="$WORKSPACE/.claude/skills/$SKILL/phases"
PHASES=()
HAS_DIGEST=0
# `-r` alone is false for two very different things: "this skill ships no phases
# file" (legitimate -- this runner is generic and single-shot is a real mode)
# and "the phases file is there but unreadable" (a bad mode, a damaged checkout,
# a Full Disk Access denial on the workspace -- and this read happens before the
# preflight can abort). Collapsing them turned a 10-phase night into ONE
# eight-hour session with an empty $ROUTINE_PHASE, no `--- phase` lines in the
# log, no budget floor and no digest guarantee -- reporting as a healthy night.
# Absent stays legitimate. Unreadable is fatal and loud.
if [[ -e "$PHASES_FILE" && ! -r "$PHASES_FILE" ]]; then
  echo "midnight-run: FATAL phases file exists but is unreadable: $PHASES_FILE" >> "$LOG"
  page_and_exit 1 "⚠️ **$SKILL** could not start on $(hostname -s) ($TODAY) — \`$PHASES_FILE\` exists but is unreadable (permissions, or a Full Disk Access denial). Refusing to degrade to one unphased session. Log: \`$LOG\`"
fi
if [[ -r "$PHASES_FILE" ]]; then
  while IFS= read -r _p || [[ -n "$_p" ]]; do
    case "$_p" in ''|\#*) continue ;; esac
    PHASES+=("$_p")
    # Remember whether this skill promises a digest, so the end-of-run sentinel
    # knows which question to ask. `!digest` and `digest` are the same phase.
    case "${_p#!}" in digest) HAS_DIGEST=1 ;; esac
  done < "$PHASES_FILE"
fi
# Empty means single-shot. One empty-string element keeps the loop body common,
# and `set -u` will not tolerate expanding a genuinely empty array on bash 3.2.
[[ ${#PHASES[@]} -eq 0 ]] && PHASES=("")

export ROUTINE_HANDOFF="$STATE/$TODAY.handoff.md"
# Scratch is keyed to the day. The previous design reused a fixed /tmp path, so
# a phase could read the PREVIOUS run's output and never know -- a wrong answer
# rather than a crash.
export ROUTINE_WORK="$STATE/$TODAY.work"
mkdir -p "$ROUTINE_WORK"

# A skill may ship an executable `preflight` beside its SKILL.md. It runs before
# phase 1 with the run's environment, and a non-zero exit aborts the night.
# This is where a routine asserts its own fixture still exists: crash-fuzz once
# destroyed its fixture and every later run exited 0 looking clean while testing
# nothing, which is the worst failure a nightly bot has.
PREFLIGHT="$WORKSPACE/.claude/skills/$SKILL/preflight"
if [[ -x "$PREFLIGHT" ]]; then
  echo "midnight-run: preflight — $PREFLIGHT" >> "$LOG"
  if ! "$PREFLIGHT" >> "$LOG" 2>&1; then
    echo "midnight-run: FATAL preflight failed — skipping $SKILL" >> "$LOG"
    scout-report.sh "⚠️ **$SKILL** skipped $(date +%F) — preflight failed. See \`$LOG\`." || true
    exit 1
  fi
fi

# One budget for the whole run, not per phase, so slicing cannot multiply the
# cap. The stale-lock reclaim above assumes LIMIT bounds the entire run.
DEADLINE=$(( $(date +%s) + LIMIT ))
STATUS=0
FINAL_STATUS=0
PHASE_N=0
SKIP_REST=0

for PHASE in "${PHASES[@]}"; do
  # A phase named `!something` runs even after a failure or an early stop. That
  # is for teardown: the fuzz routines stop a daemon pair, drop worktrees and put
  # the primary checkout back on its branch. Skipping that on failure leaks
  # worktrees (observed) and can leave a developer staring at a detached HEAD
  # they did not create.
  ALWAYS=0
  case "$PHASE" in
    !*) ALWAYS=1; PHASE="${PHASE#!}" ;;
  esac
  if (( SKIP_REST == 1 && ALWAYS == 0 )); then
    continue
  fi
  REMAIN=$(( DEADLINE - $(date +%s) ))
  # Cleanup still needs a moment even when the budget is gone; a leaked worktree
  # outlives the run, an overrun does not.
  if (( ALWAYS == 1 && REMAIN < 120 )); then
    REMAIN=120
  fi
  # The floor guards LATER phases only: starting a phase with seconds left just
  # burns a cold start for nothing. The first phase always gets whatever budget
  # exists, or a deliberately short LIMIT (tests, a quick manual run) could
  # never start at all.
  if (( PHASE_N > 0 && ALWAYS == 0 && REMAIN <= 30 )); then
    echo "midnight-run: budget spent after $PHASE_N phase(s) -- stopping before '$PHASE'" >> "$LOG"
    SKIP_REST=1
    continue
  fi
  if (( REMAIN <= 0 )); then
    # SKIP_REST, not `break`: `break` left the loop entirely and took the `!`
    # always-run phases with it -- teardown AND the guaranteed `!digest`. It was
    # unreachable only because the REMAIN<=30 floor above catches later phases
    # first, and that floor stops applying the moment a phase is added after
    # `digest`. SKIP_REST is the mechanism that already means exactly this:
    # skip the remaining normal phases, still run the always ones (which get
    # their own 120s floor a few lines up).
    echo "midnight-run: no budget left -- skipping remaining phases ('!' phases still run)" >> "$LOG"
    STATUS=5
    # STATUS alone does not survive the loop: line 234 (STATUS=$FINAL_STATUS)
    # unconditionally overwrites it after the loop ends, and FINAL_STATUS only
    # moves on a failed phase (line 223), never on budget exhaustion. Without
    # this, a run that dies here still exits 0 -- a dead night reads as a quiet
    # one, exactly what exit 5 exists to prevent.
    FINAL_STATUS=5
    SKIP_REST=1
    continue
  fi
  PHASE_N=$(( PHASE_N + 1 ))
  export ROUTINE_PHASE="$PHASE"
  if [[ -n "$PHASE" ]]; then
    echo "--- phase '$PHASE' starting $(date '+%H:%M:%S') (${REMAIN}s of budget left${MODEL:+, model $MODEL}) ---" >> "$LOG"
  fi

  set -m   # give the job its own process group
  if [[ -n "${ROUTINE_TEST_CMD:-}" ]]; then
    # Smoke-test hook: exercise the cap/lock/reaping logic without a Claude run.
    bash -c "$ROUTINE_TEST_CMD" >> "$LOG" 2>&1 &
  else
    # No inner ceiling on background work. Print mode otherwise gives up on still-running
    # background tasks after 600s and terminates them, which is how a fuzz run that needed
    # ten minutes exited 0 having published nothing -- the work happened and was thrown away.
    # The real bound is the ${LIMIT}s cap above, enforced on this job's whole process group,
    # so waiting indefinitely here cannot outlive the routine.
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 \
    claude -p "/$SKILL" \
      ${MODEL:+--model "$MODEL"} \
      --permission-mode acceptEdits \
      --allowedTools "Bash" "Read" "Write" "Edit" "Glob" "Grep" "Workflow" "Agent" "Skill" \
      `# Deny the specific destructive Bash forms, not the Bash tool -- the night needs Bash.` \
      `# git stash: refs/stash is SHARED across every worktree under GitlabRepos, so a stash` \
      `#   here can silently pop into a concurrent session's tree.` \
      `# git add -A: node_modules is a symlink in these worktrees; -A has already killed CI with ENOTDIR.` \
      `# push --force and rm -rf /: an unattended 8h agent should not be able to reach either.` \
      --disallowedTools "Bash(git stash:*)" "Bash(git add -A:*)" "Bash(git push --force:*)" "Bash(rm -rf /*)" \
      >> "$LOG" 2>&1 &
  fi
  JOB=$!
  set +m

  (
    # Drop the parent's EXIT trap before anything else. This subshell exits
    # normally after the cap fires, and an inherited `rmdir "$LOCK"` would
    # release a LIVE lock mid-night -- the parent's `kill "$WATCHDOG"` is the
    # only thing preventing it, which is a race, not a guarantee (a small
    # ROUTINE_KILL_GRACE or a descheduled parent loses it). bash 3.2.57 on this
    # machine does not run the parent's EXIT trap in a background subshell, but
    # that is a version-specific detail to not depend on.
    trap - EXIT
    sleep "$REMAIN"
    if kill -0 "$JOB" 2>/dev/null; then
      echo "midnight-run: ${LIMIT}s cap hit, terminating $SKILL" >> "$LOG"
      kill -TERM -"$JOB" 2>/dev/null || kill -TERM "$JOB" 2>/dev/null
      sleep "$GRACE"
      kill -KILL -"$JOB" 2>/dev/null || kill -KILL "$JOB" 2>/dev/null
    fi
  ) &
  WATCHDOG=$!

  wait "$JOB"; STATUS=$?
  kill "$WATCHDOG" 2>/dev/null
  wait "$WATCHDOG" 2>/dev/null

  if [[ -n "$PHASE" ]]; then
    echo "--- phase '$PHASE' exited $STATUS at $(date '+%H:%M:%S') ---" >> "$LOG"
  fi

  # A failed phase must not hand its wreckage to the next one -- but `!` phases
  # still run, so cleanup happens. The run's exit code is the failure's, never
  # the teardown's.
  if (( STATUS != 0 )); then
    if (( ALWAYS == 0 )); then FINAL_STATUS=$STATUS; SKIP_REST=1; fi
  fi

  # A phase may legitimately end the run early -- survey finding nothing worth
  # doing is a normal outcome, not a failure, and the remaining phases have
  # nothing to act on.
  if (( ALWAYS == 0 )) && grep -qiE '^[[:space:]]*status:[[:space:]]*stop' "$ROUTINE_HANDOFF" 2>/dev/null; then
    echo "midnight-run: handoff says stop after phase '$PHASE'" >> "$LOG"
    SKIP_REST=1
  fi
done
STATUS=$FINAL_STATUS

echo "=== $SKILL exited $STATUS at $(date '+%H:%M:%S') ===" >> "$LOG"

# A usage limit is not a failure of the routine, and paging it as one trains
# the room to ignore the pages that matter. Claude prints one recognizable line
# and exits; report it as a deferral with the reset time and stop there — the
# next scheduled run picks the day's work fresh, so nothing is lost but time.
#
# Three guards, because this branch bypasses BOTH the failure page and the
# no-report sentinel, and the thing it greps is the routine's own transcript:
#   * STATUS must be non-zero. A deferral is by definition a run that could not
#     finish; a phase that completed successfully was not rate limited.
#   * only this run's lines (LOG_MARK), because $LOG is cumulative per DAY --
#     one limit notice used to defer every later run that same day, forever.
#   * only the TAIL of them. Claude prints its notice and exits, so the notice
#     is the last thing in the log; a finding that merely QUOTES a rate-limit
#     banner is followed by the rest of the session. This routine reads chat UI
#     text for a living, so quoting one is normal work, and it must not be able
#     to convert a genuine failure into "deferred, exit 0".
RUN_TAIL="$(tail -n +$(( LOG_MARK + 1 )) "$LOG" 2>/dev/null | tail -10)"
if [[ "$STATUS" -ne 0 ]] && printf '%s\n' "$RUN_TAIL" | grep -q "hit your .* limit"; then
  RESET="$(printf '%s\n' "$RUN_TAIL" | grep -o "resets [^(]*" | tail -1)"
  echo "midnight-run: deferred by Claude usage limit (${RESET:-reset time unknown})" >> "$LOG"
  page_and_exit 0 "⏸ **$SKILL** deferred ($TODAY) — Claude usage limit (${RESET:-reset time unknown}). Not a code failure; it will run as scheduled tomorrow."
fi

# A silently broken routine is worse than no routine: report the failure to the
# same room the successful runs report to. Page output goes to the log so the
# run's own record shows what was said, not just that something was.
if [[ "$STATUS" -ne 0 ]]; then
  scout-report.sh "⚠️ **$SKILL** failed on $(hostname -s) — exit $STATUS ($TODAY). Log: \`$LOG\`" >> "$LOG" 2>&1 || true
fi

# Exit 0 is not proof of work. Every routine's last act is one report through
# scout-report.sh; if none was delivered, the run produced nothing and must not
# be allowed to look like a clean day.
#
# But "somebody reported" is a weaker promise than it reads for a phased skill:
# once any phase can page, a night whose digest died still leaves a non-empty
# report file behind — a mid-night note standing in for the night's verdict. So
# when the skill ships a `digest` phase, ask for the digest's OWN marker; when
# it ships no phases at all, the old question is still the right one.
if [[ "$STATUS" -eq 0 ]]; then
  if (( HAS_DIGEST == 1 )) && [[ ! -s "$ROUTINE_DIGEST_FILE" ]]; then
    echo "midnight-run: exit 0 but the digest never reported — treating as a no-op run" >> "$LOG"
    scout-report.sh "⚠️ **$SKILL** exited 0 on $(hostname -s) without a digest ($TODAY) — the night's one guaranteed report never happened. Log: \`$LOG\`" >> "$LOG" 2>&1 || true
    STATUS=4
  elif (( HAS_DIGEST == 0 )) && [[ ! -s "$ROUTINE_REPORT_FILE" ]]; then
    echo "midnight-run: exit 0 but no report was delivered — treating as a no-op run" >> "$LOG"
    scout-report.sh "⚠️ **$SKILL** exited 0 on $(hostname -s) without delivering a report ($TODAY) — it did no work. Log: \`$LOG\`" >> "$LOG" 2>&1 || true
    STATUS=4
  fi
fi

# Chat is the only place an operator actually looks. scout-report.sh returns 0
# even when `om room say` fails — deliberately, so a night that found real bugs
# is not marked failed because chat was unreachable — and it mirrors the body
# into $ROUTINE_REPORT_FILE BEFORE trying to send. Together those two facts made
# a delivery failure indistinguishable from a clean night: the report file was
# non-empty, the sentinel above was satisfied, and four real reports sat unread
# in ~/.local/state/routines/undelivered/ while their runs exited 0. The marker
# below is how the RUN finds out what the report script will not tell its
# caller. The text still survives in the mirror and the fallback dir; what
# changes is that the night now ENDS loudly.
if [[ -s "$ROUTINE_UNDELIVERED_FILE" ]]; then
  echo "midnight-run: $(wc -l < "$ROUTINE_UNDELIVERED_FILE" | tr -d ' ') report(s) NEVER REACHED CHAT. Unread copies:" >> "$LOG"
  sed 's/^/midnight-run:   /' "$ROUTINE_UNDELIVERED_FILE" >> "$LOG"
  if [[ "$STATUS" -eq 0 ]]; then
    STATUS=6
  else
    # Already non-zero, so the night is already loud, and 4/5 say something
    # more specific about WHY it produced nothing. Don't overwrite them.
    echo "midnight-run: keeping exit $STATUS rather than the delivery-failure code 6" >> "$LOG"
  fi
fi

exit "$STATUS"
