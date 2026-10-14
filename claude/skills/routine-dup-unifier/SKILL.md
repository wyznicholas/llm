---
name: routine-dup-unifier
description: Daily routine that finds one family of duplicated implementations inside an OM Chat repo, proves the copies behaviour-identical over their shared domain with one characterization table, merges them into a single owner, migrates every caller and deletes the copies in the same PR — reporting to #om-agent-test as @om-agent
---

# Daily dup unifier

Runs unattended (launchd, 11:00). Scope: **openmarket (openmarket-internal) and openmarket-chat** — the product itself.

**Never** kiyotaka-frontend. **Never om-agent.** **Never across repos, and above all never across the openmarket-chat / openmarket-chat-cloud fork pair** — those twins are ~30 shared files adrift *by policy* (hand-port + per-fork refresh, never full sync), so what looks like the fleet's biggest duplication is a deliberate fence. Cross-repo duplication is a report, not a target. One repo per day, unification entirely inside it.

**Announce at start:** "Using routine-dup-unifier to give one duplicate family a single home."

**The lock and the running `claude` process you will find are yours.** `routine-run.sh` took `$ROUTINE_LOCK_HELD` before starting you and `$ROUTINE_RUN_PID` is your own runner, so a `run.lock` directory and a live `claude -p /<skill>` are *you*, not a competing run. Never stand down over them. (2026-08-20: ant-shipper found its own lock, decided another run was in flight, did nothing, and exited 0.)

## Phases — do only `$ROUTINE_PHASE`

This routine runs as four short sessions, not one long one. The protocol (handoff
file, sha check, scratch dir, size rules) is in `~/repos/CLAUDE.md` — read it.
Your steps this session:

| phase | steps |
|---|---|
| `survey` | Step 1 |
| `prove` | Step 2 |
| `act` | Steps 3–4 |
| `publish` | Steps 5–6 |

Stop when your phase is done. Leave everything the next phase needs in
`$ROUTINE_HANDOFF` and `$ROUTINE_WORK`, never only in the conversation.

## Absolute rules

1. **Behaviour-identical only, and divergence is the finding.** When two copies of "the same" logic disagree — an extra guard, a different default, one handles null and one throws — that difference may be load-bearing for one caller. You do **not** pick a winner: prove the copies equivalent over their whole shared input domain, or leave them both standing and report the divergence (it is usually a latent bug — name it for routine-logic-bugfixer's intake). Unifying two different behaviours into one is how a "cleanup" ships a regression to half the call sites.
2. **Table before merge.** One characterization table over the shared domain, run against **every copy**, all green on the untouched code, before anything moves. Same table, N implementations, identical rows — that identity is the licence to merge.
3. **The copies die in the same PR.** Callers all migrate to the single owner and the duplicates are deleted — no deprecated shims, no "will remove later", no re-export left behind. A unification that leaves the copies alive has added a third implementation.
4. **The owner lives in the lowest layer that already sees the domain.** Never create an upward import (a lib reaching into a component, a shared module reaching into a feature) to house the survivor. If no legal home exists without new layering, that is a finding for the ping, not a reason to bend the import graph.
5. **One duplicate family per day**, diff ≤ ~300 changed lines, ≤ 2 PRs (usually 1). A family too wide for the ceiling gets a bounded slice: unify the two most-identical copies, leave a map of the rest in the ping. If ≥ 4 routine-authored PRs are already open on the target repo, go **report-only**.
6. **Worktrees only**, `node_modules` overlaid by symlink, never `git add -A`.
7. Report to #om-agent-test **exactly once**, at the end, even when the answer is "everything duplicated is duplicated for a reason".

## Step 1 — Find the family

No stack needed; this routine is pure source analysis plus tests.

```bash
cat ~/.local/state/routines/dup-unifier/done.jsonl    # never re-pick these
```

Detection, cheapest first:

```bash
bunx jscpd@4 src --min-tokens 70 --reporters json --silent   # token-level clones
```

If `bunx` cannot fetch (offline), fall back to structural greps: identically-named functions defined in more than one file, `grep -rn "function <name>\|const <name> ="`; copy-paste tells like matching comment blocks (`grep -rn` a distinctive comment line); the same regex or magic constant defined in several places.

Rank families by **caller count × drift risk** — a helper duplicated in five live call paths beats a pair of frozen test fixtures. **Exclude:** generated or vendored code, test fixtures that are *supposed* to be frozen copies, files touched by an open routine PR, anything in `done.jsonl`.

## Step 2 — Prove the copies identical

Diff the copies line by line and enumerate the shared input domain as a truth table. **Any behavioural difference stops the merge for that pair** (rule 1) — record it as a finding with both file:line sites and what disagrees. Then pin: the same characterization rows run against each copy, all green (rule 2). Repo rules:

- **openmarket-chat:** suites share one process — never add a global `window` stub or move happyDOM's URL; it breaks *other* suites, not yours.
- The house gates already fail on main — baseline a same-commit worktree and **diff the failure sets**; never demand absolute green.

## Step 3 — Choose the owner

The survivor goes where rule 4 says it belongs, keeping the import graph acyclic and downward. Prefer an existing copy's location over inventing a new module; prefer the copy with the best name; take the union of the copies' *tests*, never of their behaviours.

## Step 4 — Migrate and delete

Point every caller at the owner. Delete the other copies. The characterization table must stay green against the owner from every former call path.

## Step 5 — Prove and ship

```bash
/verify        # table green on base (against each copy) AND on the branch (against the owner), plus the repo's static gate
```

Record the numbers: copies removed, callers migrated, net lines deleted. Then:

```bash
routine-publish.sh --title "refactor(<area>): unify <family> into <owner>" --body-file body.md --repo "$WT"
```

The body carries the **table**, the list of deleted sites, the caller migration list, and the `/verify` block. The pinned tests are **committed** against the owner. `routine-publish.sh` refuses a body with no `/verify report` section.

Append the family to `done.jsonl` whether you shipped or declined, with the reason.

## Step 6 — Report

```bash
printf '%s' "$report" | routine-ping.sh
```

Markdown table with a `|---|` separator row, `**bold**` not `__bold__`, single-line cells. Include: the family and its copy count, the owner chosen and why, net lines deleted, the PR link, **divergent near-duplicates you deliberately left standing** (with the disagreement named — bugfixer intake), and what you skipped with reasons.
