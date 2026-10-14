---
name: routine-dead-code-removal
description: Daily routine that finds one family of provably unreachable code in an OM Chat repo, assembles two independent proofs of unreachability, deletes it, and opens a PR carrying the proof plus /verify — reporting to #om-agent-test as @om-agent
---

# Daily dead-code removal

Runs unattended (launchd, 11:40). Scope: **openmarket (openmarket-internal) and openmarket-chat** — the product itself.

**Never** kiyotaka-frontend. **Never om-agent.** **Never openmarket-chat-cloud**: the fork is ~249 divergences from openmarket-chat, and code dead in one twin can be the living half in the other — a deletion there needs an explicit twin audit, which is more than a one-family-a-day routine can honestly promise.

**Announce at start:** "Using routine-dead-code-removal to delete one provably unreachable family."

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

1. **Two independent proofs of unreachability, one of which must survive dynamic dispatch.** Static "no references" is one proof (tsc, or `bunx knip` if it fetches, or exhaustive grep of the identifier). The second must address the ways code is reached without being named: grep the **string forms** — the bare name in quotes and template literals, kebab/snake variants, route paths, event names, registry keys, `data-*` attributes, i18n keys. Code reachable through a registry, DI container, dynamic `import()`, or string-keyed dispatch is **not provably dead** unless you trace the registry itself and show the key absent. One proof = a finding in the ping, not a deletion.
2. **Delete, never comment out.** Git is the archive. The PR body carries both proofs per deleted symbol, so a reviewer can refute either.
3. **Dead flags are dead branches.** A feature flag provably constant (default hard-coded, no override site, no env/config path that can flip it) makes its off-branch dead — but flag *removal* belongs to routine-shipped-feature-inliner; here you only delete code no flag value can reach.
4. **One family per day** — one module, one export cluster, or one dead branch family; diff ≤ ~300 deleted lines, ≤ 2 PRs (usually 1). If ≥ 4 routine-authored PRs are already open on the target repo, go **report-only**.
5. **Worktrees only**, `node_modules` overlaid by symlink, never `git add -A`.
6. Report to #om-agent-test **exactly once**, at the end, even when the answer is "everything unreferenced is reachable dynamically".

## Step 1 — Find the family

No stack needed; pure source analysis.

```bash
cat ~/.local/state/routines/dead-code-removal/done.jsonl   # never re-pick these
bunx knip@5 2>/dev/null || true                            # unused exports/files, if it fetches
```

Fall back to `tsc --noEmit` with unused locals, and grep sweeps for exports never imported. Prefer whole dead **files** over dead functions — the proof is cleaner and the diff is purer. **Exclude:** generated or vendored code, public API surface (package.json `exports`, anything a *other* repo imports), test fixtures, files touched by an open routine PR, anything in `done.jsonl`.

## Step 2 — Prove it twice

For each symbol: proof A (static — the reference graph shows nothing), proof B (dynamic — the string-form sweep of rule 1 shows nothing, or the registry trace shows the key absent). Record both as commands with their empty output. Any hit ends that symbol's candidacy: it goes in the ping as "looks dead, reachable via <site>".

## Step 3 — Delete and prove nothing noticed

Delete the family. Then the repo's own evidence: build green, suite failure set **identical to a same-commit baseline worktree** (the house gates already fail on main — diff failure sets, never demand absolute green; openmarket-chat suites share one process — no global `window` stubs).

## Step 4 — Ship

```bash
/verify        # base and branch: identical failure sets, static gate clean, plus both proofs quoted
```

```bash
routine-publish.sh --title "chore(<area>): delete unreachable <family>" --body-file body.md --repo "$WT"
```

Body: per-symbol proof pairs, net lines deleted, and the `/verify` block. Append to `done.jsonl` whether shipped or declined, with the reason.

## Step 5 — Report

```bash
printf '%s' "$report" | routine-ping.sh
```

Markdown table with a `|---|` separator row, `**bold**` not `__bold__`, single-line cells. Include: family, lines deleted, PR link, **almost-dead code left standing** (one proof only, with the reachable-via site named), and skips with reasons.
