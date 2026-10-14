---
name: routine-flaky-test-fixer
description: Daily routine that catches one flaky test in an OM Chat repo by repeated local runs, root-causes the nondeterminism, fixes the test (or names the product race it exposes), and opens a PR proving N-consecutive stability — reporting to #om-agent-test as @om-agent
---

# Daily flaky-test fixer

Runs unattended (launchd, 13:40). Scope: **openmarket (openmarket-internal) and openmarket-chat** — the product itself.

**Never** kiyotaka-frontend. **Never om-agent.** **Never openmarket-chat-cloud** (fork ~249 divergences adrift, and its full suite is known too flaky to run whole locally — it would eat the day producing noise).

**CI is not the instrument here.** openmarket-chat's Actions budget is exhausted — every PR check dies in 4s with no steps run, so a red check there says nothing about flakiness or anything else. Flakiness is measured **locally, by repetition**: the same suite, same commit, run K times, diffing which tests flip.

**Announce at start:** "Using routine-flaky-test-fixer to make one flipping test deterministic."

**The lock and the running `claude` process you will find are yours.** `routine-run.sh` took `$ROUTINE_LOCK_HELD` before starting you and `$ROUTINE_RUN_PID` is your own runner, so a `run.lock` directory and a live `claude -p /<skill>` are *you*, not a competing run. Never stand down over them. (2026-08-20: ant-shipper found its own lock, decided another run was in flight, did nothing, and exited 0.)

## Phases — do only `$ROUTINE_PHASE`

This routine runs as four short sessions, not one long one. The protocol (handoff
file, sha check, scratch dir, size rules) is in `~/repos/CLAUDE.md` — read it.
Your steps this session:

| phase | steps |
|---|---|
| `survey` | Step 1 |
| `prove` | Step 2 |
| `act` | Step 3 |
| `publish` | Steps 4–5 |

Stop when your phase is done. Leave everything the next phase needs in
`$ROUTINE_HANDOFF` and `$ROUTINE_WORK`, never only in the conversation.

## Absolute rules

1. **A flake is a measurement, never an anecdote.** A test qualifies only when it flips in your own K-run measurement on one commit (K ≥ 10 for a single file; K ≥ 5 for a whole suite). Record flip count and seed conditions. One observed flip from history or hearsay = a candidate to *measure*, not to fix.
2. **Root cause, never retry.** Banned fixes: retries, longer sleeps, widened timeouts, `.skip`. The fix names the mechanism — shared module state leaking between tests in the same process, order dependence, an unawaited promise settling late, real time or real randomness unseeded, a port collision — and removes it. If the mechanism cannot be named, the day's output is the measurement plus the narrowed suspect list, not a PR.
3. **The race may be the product's.** If root-causing shows the *code under test* is racy (not the test), do **not** fix the product — that is a real bug with a ready-made repro: hand it to routine-logic-bugfixer's intake via the ping, commit nothing but the measurement.
4. **Stability is proven by the same instrument that caught the flake.** `/verify` here means: on the merge-base the test flips within K runs (RED); on the fix it is green **K consecutive times** (GREEN); the rest of the failure set is unchanged against a same-commit baseline.
5. **One flake per day**, ≤ 2 PRs (usually 1). If ≥ 4 routine-authored PRs are already open on the target repo, go **report-only**.
6. **Worktrees only**, `node_modules` overlaid by symlink, never `git add -A`.
7. Report to #om-agent-test **exactly once**, at the end, even when the answer is "K runs, nothing flipped".

## Step 1 — Hunt by repetition

No stack needed unless the flaky test itself needs one.

```bash
cat ~/.local/state/routines/flaky-test-fixer/done.jsonl   # never re-pick these
```

Where to point K runs first: suites the other routines' pings have called flaky; test files with `retry`/`sleep`/timeout-bump commits in `git log --since=90.days`; files whose names admit it (`*.flaky.*`, comments saying "flaky"). Budget the runs — a whole-suite pass in openmarket-chat is minutes, so pick one suspect area per day rather than boiling the ocean. **Exclude:** files touched by an open routine PR, anything in `done.jsonl`.

**openmarket-chat suites share one process** — this is the single biggest flake mechanism in the repo (a stubbed `window`, a moved happyDOM URL, module state mutated by a neighbour), so measure suspect files both alone and with their usual neighbours: a test green alone and flipping in company is order-dependence, caught.

## Step 2 — Corner it

Bisect the nondeterminism: alone vs in company (order), repeated in-process vs fresh process (leaked state), seeded vs unseeded time/random (fake timers), parallel vs serial (ports, tmpfiles). The mechanism must be named (rule 2) with the evidence run that pins it.

## Step 3 — Fix the mechanism

Fix in the test or its harness only (rule 3 guards the boundary). Typical honest fixes: await the act, isolate module state per test, fake timers/seeded random, per-test tmpdirs and ports, restore what the test mutated.

## Step 4 — Ship

```bash
/verify        # RED: flips within K runs on base (logged). GREEN: K consecutive green on fix. Failure set otherwise unchanged; static gate clean.
```

```bash
routine-publish.sh --title "test(<area>): make <test> deterministic — <mechanism>" --body-file body.md --repo "$WT"
```

Body: the measurement (K, flip count, conditions), the named mechanism, the K-consecutive proof, and the `/verify` block. Append to `done.jsonl` whether shipped or declined, with the reason.

## Step 5 — Report

```bash
printf '%s' "$report" | routine-ping.sh
```

Markdown table with a `|---|` separator row, `**bold**` not `__bold__`, single-line cells. Include: the test, flip rate before, mechanism, PR link, **product races found under rule 3** (bugfixer intake, with repro), unmeasured suspects left for tomorrow, skips with reasons.
