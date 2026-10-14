---
name: routine-logic-simplifier
description: Daily routine that finds the most convoluted business logic in the OM Chat repos, pins its behaviour with a characterization truth table, refactors it to be behaviour-identical, and opens a PR carrying the table plus before/after complexity — reporting to #om-agent-test as @om-agent
---

# Daily logic simplifier

Runs unattended (launchd, 08:20). Scope: **openmarket (openmarket-internal) and openmarket-chat** — the product itself.

**Never** kiyotaka-frontend. **Never om-agent**: it is the agent's own runtime, not the product, and simplifying the bot that files the MR is not what this routine is for (it drifted there on 2026-08-20 because the two product repos' hotspots all tripped the blast-radius rule below and om-agent was the only thing left ranked — that fallback is now closed). **Never openmarket-chat-cloud** either: it is a fork ~249 divergences from openmarket-chat, so a shared-code refactor there needs an explicit twin MR, which is more than a one-hotspot-a-day routine can honestly promise.

**Announce at start:** "Using routine-logic-simplifier to make one hotspot boring."

**The lock and the running `claude` process you will find are yours.** `routine-run.sh` took `$ROUTINE_LOCK_HELD` before starting you and `$ROUTINE_RUN_PID` is your own runner, so a `run.lock` directory and a live `claude -p /<skill>` are *you*, not a competing run. Never stand down over them. (2026-08-20: ant-shipper found its own lock, decided another run was in flight, did nothing, and exited 0.)

## Phases — do only `$ROUTINE_PHASE`

This routine runs as four short sessions, not one long one. The protocol (handoff
file, sha check, scratch dir, size rules) is in `~/repos/CLAUDE.md` — read it.
Your steps this session:

| phase | steps |
|---|---|
| `survey` | Step 1 |
| `prove` | Steps 2–3 |
| `act` | Step 4 |
| `publish` | Steps 5–6 |

Stop when your phase is done. Leave everything the next phase needs in
`$ROUTINE_HANDOFF` and `$ROUTINE_WORK`, never only in the conversation.

## Absolute rules

1. **Behaviour-identical only.** If the truth table exposes a genuine bug, you do **not** fix it — report it in the ping. Mixing a bug fix into a refactor destroys the equivalence claim, which is the only reason anyone can trust the diff.
2. **Table before code.** The characterization tests are written and green against the *current* implementation before a single line is refactored. A table written after the change just documents the change.
3. **One hotspot per day**, ≤ 2 PRs (usually 1).
4. **Worktrees only**, `node_modules` overlaid by symlink, never `git add -A`.
5. Report to #om-agent-test **exactly once**, at the end, even when the answer is "nothing worth doing".

## Step 1 — Pick the hotspot

No stack needed; this routine is pure source analysis.

```bash
cat ~/.local/state/routines/logic-simplifier/done.jsonl   # never re-pick these
```

Rank candidates by **cyclomatic complexity × recent churn** — complex *and* alive beats complex-and-frozen:

```bash
cd <repo> && git log --since=90.days --name-only --pretty=format: -- src \
  | sort | uniq -c | sort -rn | head -40
```

Cross-reference with the repo's own lint (`bunx biome check` / `pnpm lint`) for
long functions and deep nesting.

**Exclude:** generated or vendored code, files touched by an open routine PR, and anything in `done.jsonl`.

**On a hotspot too big to rewrite whole** (`runRoomJoin`, `library-sync`, `dispatchSlashCommand`, `TopicPeekPane`, `WindowedList` are all cc>110 and past 300 lines): do **not** skip it and do not rewrite it whole. Take one cohesive sub-behaviour out of it — a single guard ladder, one branch family, one loop — pin *that* with its own table and extract it, keeping the day's diff under ~300 changed lines. The 300-line ceiling is on the **diff**, not on the function, and it exists so a human can review the equivalence claim in one sitting. Only report "needs a human sprint" when even a bounded slice cannot be made behaviour-identical on its own; say which slice you tried.

## Step 2 — Model the behaviour

Read the target function and enumerate what it *actually does* as a truth table: every input class × branch × observable output or side effect. Record ambiguities (dead branches, contradictory conditions, unguarded division, missing early return) as **findings**, not as things to fix.

## Step 3 — Pin it

Write one characterization test per row, against the **current** implementation, and run them. All must pass on the untouched code. Repo rules:

- **openmarket-chat / -cloud:** suites share one process — never add a global `window` stub or move happyDOM's URL; it breaks *other* suites, not yours.

If rows cannot be pinned deterministically (time, randomness, network), the day's output is the table plus a seam proposal in the ping — **not** a refactor.

## Step 4 — Simplify

Flatten nesting, name the predicates, collapse duplicate branches, extract pure functions, delete arms the table *proves* unreachable. No behaviour changes.

## Step 5 — Prove and ship

```bash
/verify        # table green on base AND on the refactor, plus the repo's static gate
```

Record before/after complexity numbers. Then:

```bash
routine-publish.sh --title "refactor(<area>): <what got simpler>" --body-file body.md --repo "$WT"
```

The body carries the **truth table** (it doubles as the documentation this logic never had), the complexity delta, and the `/verify` block. The pinned tests are **committed** — they stay as regression armour. `routine-publish.sh` refuses a body with no `/verify report` section.

Append the hotspot to `done.jsonl` whether you shipped or declined, with the reason.

## Step 6 — Report

```bash
printf '%s' "$report" | routine-ping.sh
```

Use a markdown table with a `|---|` separator row (without it the room renders raw pipes), `**bold**` not `__bold__`, and single-line cells. Include: the hotspot, complexity before/after, the PR link, any **findings you deliberately did not fix**, and what you skipped with reasons.
