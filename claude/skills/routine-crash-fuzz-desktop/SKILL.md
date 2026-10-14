---
name: routine-crash-fuzz-desktop
description: Daily crash-fuzzing routine for the OM Chat Electron desktop shell — drives the real app over CDP against the local zero-login daemon pair, catches renderer crashes and main-thread hangs, minimizes to a stable repro, and opens at most 2 fix PRs with repro + truth table + /verify, reporting to #om-agent-test as @om-agent
---

# Daily crash fuzzer — OM Chat desktop (Electron)

Runs unattended (launchd, 07:40). Target is `openmarket-chat/desktop`, the only desktop app. Never a production room.

**Announce at start:** "Using routine-crash-fuzz-desktop to fuzz the Electron shell."

**You get exactly one turn.** This runs under `claude -p`: the moment you end your turn, the process exits — there is no later turn where you "check back on the run". Ending your turn while drivers are still running orphans them and delivers no report (2026-08-27: a run announced "waiting on the four 10-minute runs", ended its turn, and exited 0 three minutes in with nothing to show). Wait *inside* the turn: poll with `sleep 60`-style Bash loops until the drivers' output shows completion, then write the report. The wrapper's 3600s cap is the only clock you answer to.


**The lock and the running `claude` process you will find are yours.** `routine-run.sh` took `$ROUTINE_LOCK_HELD` before starting you and `$ROUTINE_RUN_PID` is your own runner, so a `run.lock` directory and a live `claude -p /<skill>` are *you*, not a competing run. Never stand down over them. (2026-08-20: ant-shipper found its own lock, decided another run was in flight, did nothing, and exited 0.)

This lane exercises what the Chrome lane cannot: the **shell** — window lifecycle, the IPC bridge, renderer health, native menu and deep-link paths — plus the same GUI under Electron's runtime.

## Phases — do only `$ROUTINE_PHASE`

This routine runs as short sessions, not one long one. The protocol (handoff
file, sha check, scratch dir, size rules) is in `~/repos/CLAUDE.md` — read it.
Your steps this session:

| phase | steps |
|---|---|
| `survey` | Steps 1–2 — world up, shell compiled |
| `prove` | Steps 3–4 — fuzz run and oracle |
| `act` | Step 5 — triage, fix, ship |
| `publish` | Step 6 — report |

**The `prove` phase is the exception to stopping early.** Its drivers run for
about ten minutes; ending the turn kills them and the run reports nothing (that
is exactly what happened on 2026-08-24). Wait for them *inside* the phase with
`sleep`-style polling, then write the crash ledger before you stop.

Hand on **signatures and repro paths**, never driver logs — those stay on disk in
`$ROUTINE_WORK` and get grepped.

## Absolute rules

1. **Local only.** The shell must point at the daemon pair (`OM_DESKTOP_SMOKE_ORIGIN=http://127.0.0.1:31398/rooms/`), **never** `https://openmarket.xyz/chat/`.
2. **One CDP client.** Attaching a second client kills the page socket — a documented gotcha of the existing smoke harness. The fuzzer owns the single connection; read shell state from its stdout, do not attach a watchdog.
3. **Port 9155** for fuzz CDP (9055 belongs to the smoke harness — do not collide).
4. **≤ 2 fix PRs/day**; ≥ 4 open routine PRs in the repo ⇒ report-only. No stable repro (< 8/10 replays) ⇒ no PR.
5. **Worktrees only**, `node_modules` overlaid by symlink, never `git add -A`.
6. Report to #om-agent-test **exactly once**, at the end.

## Step 1 — Bring up the world

`routine-run.sh` runs the preflight automatically for any skill whose name contains `fuzz`. By hand:

```bash
routine-stack-up.sh    # exit 0 = ready; exit 1 = do not fuzz
cd ~/repos/openmarket-chat/desktop && bun install   # desktop has its own lockfile
```

If preflight fails, **stop** — a run against a missing world reports "0 crashes, clean", which is indistinguishable from a healthy result.

## Step 2 — Compile the shell

```bash
cd ~/repos/openmarket-chat/desktop && bun install && bun run compile
```

`desktop/` has its own lockfile and `node_modules`, separate from the repo root.

## Step 3 — Fuzz

The driver exists — **do not write one**:

```bash
cd ~/repos/openmarket-chat
bun tools/fuzz/desktop-driver.ts --seed <n> --minutes 10
```

Run 3 seeds. Exit codes: `0` clean, `1` findings, `2` bad arguments, **`3` the fixture world is broken — treat as a failed run, never as "0 crashes"**.

It spawns the shell itself (fresh `OM_DESKTOP_USER_DATA` per run, CDP on 9155) and attaches to the page target. Do **not** try to drive it with playwright's `_electron.launch` or `connectOverCDP` — both were tried and neither works against Electron; see the driver's header comment.

## Step 4 — Oracle (already implemented in the driver)

Findings are: uncaught renderer exceptions (`Runtime.exceptionThrown`), the app's escaped-error toasts, and the shell-level signals only this lane can see — `render-process-gone` and `unresponsive` from the shell's own output. Benign noise (`AbortError`, `ResizeObserver loop`, `RoomOpenSupersededError`, clipboard denials) is filtered by **error name**, not message text.

If a native crash needs a dump, the shell has **no `crashReporter`** — adding `crashReporter.start({ submitURL: "", uploadToServer: false })` with a local `crashDumps` path is a worthwhile first PR for this lane.

## Step 5 — Triage, fix, ship

Dedupe against `~/.local/state/routines/crash-fuzz/known-crashes.jsonl`, namespacing signatures `desktop:`. Minimize by delta-debugging the action log; require 8/10 replay stability.

Commit the repro at `desktop/test/fuzz-repros/<sig>.repro.ts`, patterned on `smoke.e2e.ts` (exit 0 clean, non-zero on oracle hit), booting its own world so `/verify` can run it anywhere.

Truth-table rows must include: the minimized crash sequence, a plain cold-start smoke (`bun run smoke` must stay green), and the nearest **non**-crashing variant.

```bash
/verify
routine-publish.sh --title "..." --body-file body.md --repo "$WT"
```

Root causes often live in the GUI (`openmarket-chat/src/`) rather than the shell — that is fine, the PR goes where the fix goes, but the committed repro still drives Electron so the crash context survives. If the fix also applies to `openmarket-chat-cloud`, open the twin PR the same day or say explicitly in the ping that it was not ported (the forks are ~249 divergences apart; never assume a patch applies).

## Step 6 — Report

```bash
printf '%s' "$report" | routine-ping.sh
```

Markdown table with a `|---|` separator row, `**bold**` not `__bold__`, single-line cells.
