#!/bin/bash
# Run one daily code-health routine headlessly under launchd.
#
# Usage: routine-run.sh <skill-name>   e.g. routine-run.sh routine-crash-fuzz-chrome
#
# macOS ships no `timeout(1)`, so the wall-clock cap is enforced here with a
# watchdog against the job's own process group (`set -m` puts the job in its
# own pgid, so killing -PGID reaps claude's whole subprocess tree — dev servers,
# daemon pairs and headless chromium included, which is the part that actually
# leaks if you only signal the parent).
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# GH_TOKEN must come from a file, not the keychain: under launchd (and any
# non-interactive ssh) ombot's login keychain is locked, so osxkeychain fails
# with -25308 and every GitHub fetch/push dies on "could not read Username".
# shellcheck source=/dev/null
[[ -r "$HOME/.config/om-routines/github.env" ]] && source "$HOME/.config/om-routines/github.env"


SKILL="${1:?usage: routine-run.sh <skill-name>}"
LIMIT="${ROUTINE_TIME_LIMIT:-3600}"     # hard cap, seconds
GRACE="${ROUTINE_KILL_GRACE:-30}"       # SIGTERM → SIGKILL grace
WORKSPACE="${ROUTINE_WORKSPACE:-$HOME/repos}"
STATE="$HOME/.local/state/routines/$SKILL"
TODAY="$(date +%Y-%m-%d)"
LOG="$STATE/$TODAY.log"

mkdir -p "$STATE"
{
  echo "=== $SKILL run $(date '+%Y-%m-%d %H:%M:%S %Z') on $(hostname -s) ==="
  echo "workspace=$WORKSPACE limit=${LIMIT}s"
} >> "$LOG"

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
    echo "routine-run: stale lock (${LOCK_AGE}s old, cap ${LIMIT}s) — reclaiming" >> "$LOG"
    rmdir "$LOCK" 2>/dev/null || rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || { echo "routine-run: could not reclaim lock, skipping" >> "$LOG"; exit 0; }
  else
    echo "routine-run: $SKILL already running (lock $LOCK, ${LOCK_AGE}s old), skipping" >> "$LOG"
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

cd "$WORKSPACE" || { echo "routine-run: cannot cd to $WORKSPACE" >> "$LOG"; exit 1; }

# The routine runs INSIDE this lock, and a routine that inspects its own state
# directory finds the lock plus a live `claude -p /<skill>` process. On
# 2026-08-20 routine-ant-shipper read exactly that, concluded a competing run was
# already in flight, stood down without doing any work, and still exited 0.
# So say plainly whose lock it is.
export ROUTINE_RUN_PID="$$"
export ROUTINE_LOCK_HELD="$LOCK"
export ROUTINE_SKILL="$SKILL"
# routine-ping.sh mirrors every delivered report here, which is what lets this
# script tell "nothing worth doing" (a report) from "did nothing" (no report).
export ROUTINE_REPORT_FILE="$STATE/$TODAY.report.md"
rm -f "$ROUTINE_REPORT_FILE"

# Fuzz routines need the OM Rooms world (services + zero-login daemon pair).
# Build-or-repair it here rather than trusting the skill to do it: a run against
# a missing world produces "0 crashes, clean", which is indistinguishable from a
# healthy run and can hide a dead routine for days.
if [[ "$SKILL" == *fuzz* ]]; then
  echo "routine-run: preflight — ensuring the rooms world is up" >> "$LOG"
  if ! routine-stack-up.sh >> "$LOG" 2>&1; then
    echo "routine-run: FATAL preflight failed — skipping $SKILL" >> "$LOG"
    routine-ping.sh "⚠️ **$SKILL** skipped $(date +%F) — could not bring up the fuzz stack. See \`$LOG\`." || true
    exit 1
  fi
fi


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
if [[ -r "$PHASES_FILE" ]]; then
  while IFS= read -r _p || [[ -n "$_p" ]]; do
    case "$_p" in ''|\#*) continue ;; esac
    PHASES+=("$_p")
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
    echo "routine-run: budget spent after $PHASE_N phase(s) -- stopping before '$PHASE'" >> "$LOG"
    SKIP_REST=1
    continue
  fi
  if (( REMAIN <= 0 )); then
    echo "routine-run: no budget left -- stopping" >> "$LOG"
    STATUS=5
    break
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
      >> "$LOG" 2>&1 &
  fi
  JOB=$!
  set +m

  (
    sleep "$REMAIN"
    if kill -0 "$JOB" 2>/dev/null; then
      echo "routine-run: ${LIMIT}s cap hit, terminating $SKILL" >> "$LOG"
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
    echo "routine-run: handoff says stop after phase '$PHASE'" >> "$LOG"
    SKIP_REST=1
  fi
done
STATUS=$FINAL_STATUS

echo "=== $SKILL exited $STATUS at $(date '+%H:%M:%S') ===" >> "$LOG"

# A usage limit is not a failure of the routine, and paging it as one trains
# the room to ignore the pages that matter. Claude prints one recognizable line
# and exits; report it as a deferral with the reset time and stop there — the
# next scheduled run picks the day's work fresh, so nothing is lost but time.
if grep -q "hit your .* limit" "$LOG" 2>/dev/null; then
  RESET="$(grep -o "resets [^(]*" "$LOG" | tail -1)"
  echo "routine-run: deferred by Claude usage limit (${RESET:-reset time unknown})" >> "$LOG"
  routine-ping.sh "⏸ **$SKILL** deferred ($TODAY) — Claude usage limit (${RESET:-reset time unknown}). Not a code failure; it will run as scheduled tomorrow." || true
  exit 0
fi

# A silently broken routine is worse than no routine: report the failure to the
# same room the successful runs report to.
if [[ "$STATUS" -ne 0 ]]; then
  routine-ping.sh "⚠️ **$SKILL** failed on $(hostname -s) — exit $STATUS ($TODAY). Log: \`$LOG\`" || true
fi

# Exit 0 is not proof of work. Every routine's last act is one report through
# routine-ping.sh; if none was delivered, the run produced nothing and must not
# be allowed to look like a clean day.
if [[ "$STATUS" -eq 0 && ! -s "$ROUTINE_REPORT_FILE" ]]; then
  echo "routine-run: exit 0 but no report was delivered — treating as a no-op run" >> "$LOG"
  routine-ping.sh "⚠️ **$SKILL** exited 0 on $(hostname -s) without delivering a report ($TODAY) — it did no work. Log: \`$LOG\`" || true
  STATUS=4
fi

exit "$STATUS"
