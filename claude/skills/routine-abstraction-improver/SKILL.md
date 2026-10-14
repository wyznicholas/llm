---
name: routine-abstraction-improver
description: Daily routine that flattens one over-engineered abstraction in an OM Chat repo — an interface with one implementation, a factory that makes one thing, a pass-through wrapper — after proving no second consumer exists anywhere, tests included — reporting to #om-agent-test as @om-agent
---

# Daily abstraction improver

Runs unattended (launchd, 14:20). Scope: **openmarket (openmarket-internal) and openmarket-chat** — the product itself.

**Never** kiyotaka-frontend. **Never om-agent.** **Never openmarket-chat-cloud**: an abstraction single-use in one twin may exist precisely so the other twin can substitute its half — the fork is the second implementation you cannot see from here. Cross-fork seams are a report, not a target.

**Announce at start:** "Using routine-abstraction-improver to flatten one abstraction nothing needs."

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

1. **A test fake is a second implementation.** Before calling an interface single-use, sweep the tests: a fake, stub, or mock implementing the seam means the abstraction is load-bearing — it is how the code is tested — and flattening it destroys the seam. Same for a second implementation behind a flag, a platform branch, or an injection site (`deps.*` parameters are seams by design in these repos: om-agent-style `deps` injection is the house testing idiom, assume the chat repos share it). The abstraction qualifies only when the sweep proves **one implementation, zero fakes, zero injection substitutions** — quote the empty sweeps in the PR.
2. **Behaviour-identical only.** This is a shape change: inline the wrapper, collapse interface into class, replace the factory with the constructor, delete the config object with one caller. Truth-table-and-pin like the simplifier where any logic sits in the path; if the flattening exposes a genuine bug, report it (bugfixer intake), never fix it here.
3. **Flatten toward fewer names.** The end state must have strictly fewer exported symbols and no new indirection introduced to remove old indirection. If flattening one layer requires adding another, the abstraction was load-bearing — stand down and say why.
4. **One abstraction per day**, diff ≤ ~300 changed lines, ≤ 2 PRs (usually 1). Too wide → flatten one bounded layer of it (one wrapper, one factory) and map the rest in the ping. If ≥ 4 routine-authored PRs are already open on the target repo, go **report-only**.
5. **Worktrees only**, `node_modules` overlaid by symlink, never `git add -A`.
6. Report to #om-agent-test **exactly once**, at the end, even when the answer is "every abstraction earns its keep".

## Step 1 — Find the candidate

No stack needed; pure source analysis.

```bash
cat ~/.local/state/routines/abstraction-improver/done.jsonl   # never re-pick these
```

Shapes to census, cheapest tells first: `interface X` / `abstract class X` with exactly one `implements`/`extends` in the repo; factories with a single call site; classes with one method and no state (function in a costume); wrappers whose every method delegates verbatim; generics instantiated at exactly one type; config/options objects constructed by one caller with constants. Rank by **indirection depth × reader traffic** (churn of the files that must be read *through* it). **Exclude:** public API surface, seams the tests use (rule 1 — check first, it disqualifies most candidates), files touched by an open routine PR, anything in `done.jsonl`.

## Step 2 — Prove nothing needs it

Run the rule-1 sweep and quote it: implementations count, test-fake grep, injection-site grep. Any hit → the ping ("load-bearing seam, used by <site>"), next candidate.

## Step 3 — Pin, then flatten

Where logic flows through the abstraction, pin behaviour with characterization rows first (green on untouched code). Then flatten per rule 3. Repo rules: **openmarket-chat** suites share one process — no global `window` stubs; house gates already fail on main — baseline a same-commit worktree and **diff failure sets**.

## Step 4 — Ship

```bash
/verify        # failure sets identical base vs branch, static gate clean, rule-1 sweeps quoted
```

```bash
routine-publish.sh --title "refactor(<area>): flatten <abstraction> — one implementation, zero seams" --body-file body.md --repo "$WT"
```

Body: the sweep proof, exported-symbol count before/after, indirection removed (hops a reader no longer takes), and the `/verify` block. Append to `done.jsonl` whether shipped or declined, with the reason.

## Step 5 — Report

```bash
printf '%s' "$report" | routine-ping.sh
```

Markdown table with a `|---|` separator row, `**bold**` not `__bold__`, single-line cells. Include: the abstraction, symbols before/after, PR link, **load-bearing seams acquitted** (with the consumer that saved them), skips with reasons.
