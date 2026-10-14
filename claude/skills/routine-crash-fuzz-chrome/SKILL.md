---
name: routine-crash-fuzz-chrome
description: Daily crash-fuzzing routine for the OM Chat web app — boots the local parity stack and zero-login daemon pair, fuzzes the real GUI in Chrome with seeded random walks, minimizes any crash to a stable repro, opens at most 2 fix PRs carrying repro + truth table + /verify transcript, and reports to #om-agent-test as @om-agent
---

# Daily crash fuzzer — OM Chat in Chrome

Runs unattended (launchd, 06:40). Target is the **OM Chat web app**, never kiyotaka-frontend, and never a production room.

**Announce at start:** "Using routine-crash-fuzz-chrome to fuzz the OM Chat GUI."

**You get exactly one turn.** This runs under `claude -p`: the moment you end your turn, the process exits — there is no later turn where you "check back on the run". Ending your turn while drivers are still running orphans them and delivers no report (2026-08-27: a run announced "waiting on the four 10-minute runs", ended its turn, and exited 0 three minutes in with nothing to show). Wait *inside* the turn: poll with `sleep 60`-style Bash loops until the drivers' output shows completion, then write the report. The wrapper's 3600s cap is the only clock you answer to.


**The lock and the running `claude` process you will find are yours.** `routine-run.sh` took `$ROUTINE_LOCK_HELD` before starting you and `$ROUTINE_RUN_PID` is your own runner, so a `run.lock` directory and a live `claude -p /<skill>` are *you*, not a competing run. Never stand down over them. (2026-08-20: ant-shipper found its own lock, decided another run was in flight, did nothing, and exited 0.)

## Phases — do only `$ROUTINE_PHASE`

This routine runs as short sessions, not one long one. The protocol (handoff
file, sha check, scratch dir, size rules) is in `~/repos/CLAUDE.md` — read it.
Your steps this session:

| phase | steps |
|---|---|
| `survey` | Steps 1–2 — world up, oracle self-test |
| `prove` | Step 3 — the fuzz run |
| `act` | Steps 4–5 — triage, then at most 2 fixes |
| `publish` | Steps 6–7 — verify, publish, report |
| `!teardown` | Step 8 — **runs even if an earlier phase failed** |

**The `prove` phase is the exception to stopping early.** Its drivers run for
about ten minutes; ending the turn kills them and the run reports nothing (that
is exactly what happened on 2026-08-24). Wait for them *inside* the phase with
`sleep`-style polling, then write the crash ledger before you stop.

Hand on **signatures and repro paths**, never driver logs — those stay on disk in
`$ROUTINE_WORK` and get grepped.

## Absolute rules

1. **Loopback only.** Fuzz traffic goes to `127.0.0.1:31398` (daemon pair). The driver refuses a non-loopback origin; never override that. A fuzzer that reaches openmarket.xyz types garbage into real rooms under a real identity.
2. **≤ 2 fix PRs per day.** If ≥ 4 routine PRs are already open in the repo, run **report-only**: fuzz, triage, ping — no new PRs. (This pile-up is what buried perf-sentinel-remediator.)
3. **No stable repro → no PR.** Below 8/10 replay stability it is a race; report it and move on.
4. **Worktrees only.** Never touch the primary checkout. Overlay `node_modules` by symlink and never `git add -A`.
5. Report to #om-agent-test **exactly once**, at the end, even if nothing was found.

## Step 1 — Bring up the world

`routine-run.sh` already ran the preflight for you (it does this for any skill
whose name contains `fuzz`). If you are running by hand, or anything below looks
wrong, run it yourself — it is idempotent:

```bash
routine-stack-up.sh    # exit 0 = world ready, exit 1 = do not fuzz
```

It ensures, in order: mongod on 27027 (launchd, native — **Docker is no longer
used**; it only ever provided Mongo), redis on 6379 (**the relay needs it for
rate-limit and presence — without it the GUI hangs forever on its boot skeleton
while every HTTP call returns 200 and no console error appears**), auth 4011,
tharamine 5011, relay 3002, then a fresh `bun run build` and the zero-login
daemon pair serving the GUI at `http://127.0.0.1:31398/rooms/`.

If it exits non-zero, **stop**. Do not fuzz a missing world: the run would
report "0 crashes, clean", which is indistinguishable from a healthy result.

## Step 2 — Prove the oracle still works

```bash
bun tools/fuzz/oracle-selftest.ts    # must report exactly 1 finding
```

Run this **every day, before fuzzing**. An oracle that has silently stopped detecting crashes reports "no crashes found" — identical to a healthy app. If the self-test does not report exactly one finding, stop and report that as the day's finding.

## Step 3 — Fuzz (Workflow fan-out)

Use the Workflow tool: 4 parallel agents, distinct seeds, ~10 minutes each.

```bash
bun tools/fuzz/driver.ts --seed <seed> --minutes 10
```

The driver logs `composer reachable: true|false`. **False means the run never reached a message surface** — treat that as a harness failure, not a clean run, and report it.

Artifacts land in `~/.local/state/routines/crash-fuzz/<date>/seed-<n>/`: `actions.jsonl` (the replayable log), `findings.json`, `last.png`.

## Step 4 — Triage

For each finding, dedupe by `signature` against `~/.local/state/routines/crash-fuzz/known-crashes.jsonl`.

- Signature already `fixed` or `wontfix` → ignore.
- Signature `open` from a previous day → retry it before spending budget on new fuzzing.
- New signature → minimize:

```bash
bun tools/fuzz/minimize.ts --actions <actions.jsonl> --signature <sig>
```

Exit 3 means unstable (<8/10) — report, do not fix. Append every new signature to the ledger with `{sig, firstSeen, seed, status, mrUrl}`.

## Step 5 — Fix (≤ 2, only stable signatures)

Use **superpowers:systematic-debugging** — find the root cause, do not pattern-match a fix onto the symptom. Then **superpowers:test-driven-development**: write the failing unit/component test derived from the minimized sequence first.

Test-isolation rule for this repo: suites share one process, so a stubbed `window` or a moved happyDOM URL breaks *other* suites. Never add global stubs.

Commit the minimized repro as `tools/fuzz/repros/<sig>.repro.ts` — a standalone script that replays the sequence and exits non-zero on the oracle hit. `/verify` runs exactly this.

## Step 6 — Verify and publish

```bash
# proof: RED on merge-base, GREEN on fix, plus the static gate
Skill: verify
routine-publish.sh --title "fix(...): ..." --body-file body.md --repo "$WT"
```

The static gate for openmarket-chat is a **tsc error-set diff**, not a binary pass — `main` carries a pre-existing error and a green-only gate would block every PR. `routine-publish.sh` picks the right forge (this repo is on **GitHub**) and refuses any body without a `/verify report` block.

PR body carries, in order: **repro**, **truth table** (the minimized sequence plus neighbouring scenarios that must not regress), **/verify transcript**.

If the crash is in code shared with openmarket-chat-cloud, open the twin PR the same day or say explicitly in the ping that the port is outstanding — the forks are ~249 divergences apart and nothing ports by assumption.

## Step 7 — Report

One message, markdown tables, via `routine-ping.sh` (posts as @om-agent). Include: seeds run and actions executed, new vs known signatures, PR links with verify status, skips with reasons (unstable repro, cap reached), and the count of routine PRs still unmerged.

Long report? Check the split first with `ROUTINE_SAY_DRY=1`. Tables need their `|---|` separator row, `**bold**` never `__bold__`, and cells must stay single-line.

## Step 8 — Tear down

Record the primary checkout's branch **before** any of this (`git -C ~/repos/openmarket-chat rev-parse --abbrev-ref HEAD`), then at the end:

1. Stop the daemon pair (`pkill -f tools/daemon-pair.ts`).
2. `bash tools/rooms-stack/stack-down.sh` (same env overrides as Step 1).
3. Remove the worktree (`git worktree remove --force`) unless it holds an unpublished fix — leftovers fill the disk and eventually break `git worktree` entirely.
4. **Confirm the primary checkout is back on the branch you recorded**, still clean, with its stashes. A worktree round-trip has been observed leaving it on a detached HEAD at `origin/main`; nothing is lost, but a developer sitting down to a detached checkout they did not detach will reasonably assume the bot ate their work.

## Failure modes

| Symptom | Meaning | Action |
|---|---|---|
| `composer reachable: false` | app booted to Home; message surfaces unfuzzed | harness failure — report, do not claim a clean run |
| oracle self-test ≠ 1 finding | detection is broken | stop; that is the day's finding |
| `daemon-pair: dist/ was built from a different tree` | stale bundle | `bun run build`, restart the pair |
| `Cannot find module '@cli/...'` | worktree has no sibling `openmarket` | symlink the sibling next to the worktree |
| every action a no-op, many toasts | relay throttle (5 posts / 3s) | pacing regression in the driver |
