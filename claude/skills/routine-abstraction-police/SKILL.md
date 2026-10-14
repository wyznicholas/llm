---
name: routine-abstraction-police
description: Daily routine that infers the layering rule an OM Chat repo already follows from its import graph, finds the violations of that majority rule, and fixes one violation family behaviour-identically — reporting to #om-agent-test as @om-agent
---

# Daily abstraction police

Runs unattended (launchd, 15:00). Scope: **openmarket (openmarket-internal) and openmarket-chat** — the product itself.

**Never** kiyotaka-frontend. **Never om-agent.** **Never openmarket-chat-cloud** (fork ~249 divergences adrift; moving a shared file to a new home there guarantees a parity-fence conflict on the next hand-port).

**Announce at start:** "Using routine-abstraction-police to fix one violation of a rule the repo already keeps."

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

1. **Enforce only rules the repo already keeps.** You do not bring a layering doctrine; you *measure* the one in force. From the import graph, a directed edge class (e.g. `lib → components`) is a **rule** only when the repo obeys it in ≥ 90% of instances — then the minority edges are violations. Below 90% there is no rule, only a mixed convention: that is a finding for humans, never something to "fix" toward your own taste. Every PR states the inferred rule **with its numbers** (e.g. "components→lib 143 edges, lib→components 3"), so the reviewer judges the premise, not just the diff.
2. **Behaviour-identical only.** The fix is structural: move the code to the layer that may see it, or invert the dependency through a seam that already exists at that boundary (a callback parameter, an event the layer already emits, a type extracted downward). **Never invent a new abstraction to launder an upward import** — if no existing seam fits, the violation is a finding, not a target (a new seam is routine-abstraction-improver's inverse and a human's call).
3. **Moves must be invisible.** Re-exports are not left behind (a shim is a new violation); every import site updates in the same PR; failure set identical to a same-commit baseline.
4. **One violation family per day** (one illegal edge, or one file whose moves clear several edges), diff ≤ ~300 changed lines, ≤ 2 PRs (usually 1). If ≥ 4 routine-authored PRs are already open on the target repo, go **report-only**.
5. **Worktrees only**, `node_modules` overlaid by symlink, never `git add -A`.
6. Report to #om-agent-test **exactly once**, at the end, even when the answer is "the repo keeps its own rules".

## Step 1 — Measure the graph

No stack needed; pure source analysis.

```bash
cat ~/.local/state/routines/abstraction-police/done.jsonl   # never re-pick these
```

Build the directory-level import graph (imports resolved per file, bucketed by top-level dir under `src/`). `bunx madge@8 --json src` if it fetches; otherwise a grep/awk pass over import statements is entirely adequate at directory granularity. Compute per edge-class counts both ways; rules are the ≥ 90% directions (rule 1). Rank violations by **traffic through the illegal edge** (how much code depends on it staying wrong). **Exclude:** generated code, files touched by an open routine PR, anything in `done.jsonl`.

## Step 2 — Convict or acquit

For the chosen violation, write the premise: the rule with its numbers, the violating edge, and *why the repo's own majority pattern* implies the fix direction (which side moves). If the violating file is genuinely shared by both layers, the fix is extraction **downward** of just the shared part — never a new upward-visible module.

## Step 3 — Pin, then move

Where any logic is touched (an inversion through an existing seam), pin behaviour with characterization rows first. Then move/invert per rule 2. Repo rules: **openmarket-chat** suites share one process — no global `window` stubs; house gates already fail on main — baseline a same-commit worktree and **diff failure sets**.

## Step 4 — Ship

```bash
/verify        # failure sets identical base vs branch, static gate clean, edge counts before/after quoted
```

```bash
routine-publish.sh --title "refactor(<area>): fix layering — <edge> against the repo's own rule" --body-file body.md --repo "$WT"
```

Body: the rule with numbers, edges removed, files moved with old→new paths, and the `/verify` block. Append to `done.jsonl` whether shipped or declined, with the reason.

## Step 5 — Report

```bash
printf '%s' "$report" | routine-ping.sh
```

Markdown table with a `|---|` separator row, `**bold**` not `__bold__`, single-line cells. Include: the rule and its numbers, the violation fixed, PR link, **mixed conventions found below the 90% bar** (human decision needed — named, not fixed), skips with reasons.
