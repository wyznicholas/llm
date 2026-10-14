---
name: routine-useless-test-pruner
description: Daily routine that finds tests that cannot fail in an OM Chat repo, proves each one passes against a deliberately broken subject, then repairs the salvageable and deletes the tautological — reporting to #om-agent-test as @om-agent
---

# Daily useless-test pruner

Runs unattended (launchd, 12:20). Scope: **openmarket (openmarket-internal) and openmarket-chat** — the product itself.

**Never** kiyotaka-frontend. **Never om-agent.** **Never openmarket-chat-cloud** (fork ~249 divergences adrift; its suite is also the one that is too flaky to run whole locally — no honest proof is available there).

**Announce at start:** "Using routine-useless-test-pruner to remove one family of tests that cannot fail."

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

1. **"Cannot fail" is proven by breaking the subject, never by reading the test.** For every candidate: sabotage the code under test in a scratch worktree (invert the return, throw at entry, return the wrong constant) and run the test. **Still green → proven useless.** Goes red → the test can fail after all; it leaves candidacy immediately, whatever it looks like. The sabotage diffs go in the PR body as the proof; the sabotage itself is never committed.
2. **Repair beats deletion when one mechanical defect explains it.** A missing `await`, an assertion inside a `catch` that swallows, `expect` on the wrong variable, a mock that mocks the assertion itself — fix that one defect, watch the test go red under sabotage (now it works), and keep it. Delete only tautologies: tests asserting constants, asserting the mock they configured, or asserting nothing.
3. **Repaired tests must be red-under-sabotage AND green on the real code.** A repair that turns the test red on the untouched implementation has found a real bug — do **not** fix the code (that is routine-logic-bugfixer's job); report the bug, leave the test skipped with a comment naming the finding, and say so in the ping.
4. **One test family per day** (one file or one describe-block), ≤ 2 PRs (usually 1). If ≥ 4 routine-authored PRs are already open on the target repo, go **report-only**.
5. **Worktrees only**, `node_modules` overlaid by symlink, never `git add -A`.
6. Report to #om-agent-test **exactly once**, at the end, even when the answer is "every suspicious test can in fact fail".

## Step 1 — Find candidates

No stack needed; source analysis plus test runs.

```bash
cat ~/.local/state/routines/useless-test-pruner/done.jsonl   # never re-pick these
```

Structural tells, ranked: tests with zero `expect` calls; `expect(true)`/`toBeDefined()` on something that cannot be undefined; async tests that never await the act; assertions living inside `catch`; mocks configured and then asserted verbatim; `.skip`/`.todo` older than 90 days (candidates for deletion as abandoned, via git log on the line). **Exclude:** files touched by an open routine PR, anything in `done.jsonl`, and characterization tables committed by the other routines — those are armour, and they were proven red-capable at birth.

## Step 2 — Prove each one (rule 1)

Sabotage worktree per subject, run candidates. Repo rules: **openmarket-chat** suites share one process — never add a global `window` stub or move happyDOM's URL; the house gates already fail on main — baseline a same-commit worktree and **diff failure sets**.

## Step 3 — Repair or delete

Apply rule 2. For deletions, the test's *name* may still describe a behaviour worth covering — if so, say exactly that in the ping (coverage gap, named), don't write a new test speculatively.

## Step 4 — Ship

```bash
/verify        # proof: candidates green-under-sabotage on base; repaired ones red-under-sabotage on branch; failure sets otherwise identical; static gate clean
```

```bash
routine-publish.sh --title "test(<area>): remove tests that cannot fail" --body-file body.md --repo "$WT"
```

Body: per-test verdict table (kept / repaired / deleted, with its sabotage result), the sabotage diffs, and the `/verify` block. Append to `done.jsonl` whether shipped or declined, with the reason.

## Step 5 — Report

```bash
printf '%s' "$report" | routine-ping.sh
```

Markdown table with a `|---|` separator row, `**bold**` not `__bold__`, single-line cells. Include: counts (proven useless / repaired / deleted / acquitted), any **real bug found via rule 3** (bugfixer intake), coverage gaps named, PR link, skips with reasons.
