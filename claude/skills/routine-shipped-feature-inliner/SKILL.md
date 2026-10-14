---
name: routine-shipped-feature-inliner
description: Daily routine that finds one feature flag whose feature is fully shipped in an OM Chat repo, proves the flag can no longer flip, inlines the on-branch and deletes the flag plus all its plumbing — reporting to #om-agent-test as @om-agent
---

# Daily shipped-feature inliner

Runs unattended (launchd, 13:00). Scope: **openmarket (openmarket-internal) and openmarket-chat** — the product itself.

**Never** kiyotaka-frontend. **Never om-agent.** **Never openmarket-chat-cloud**: flags are exactly where the fork twins diverge on purpose — a flag dead in one twin may be the other twin's off-switch. Cross-fork flags are a report, not a target.

Division of labour: **routine-ant-shipper** decides the fate of *features* (ship or delete, by usage). This routine only touches flags whose feature-fate is already settled — shipped, on, and never coming back off. When fate is unsettled, that flag belongs to ant-shipper; name it in the ping and move on.

**Announce at start:** "Using routine-shipped-feature-inliner to retire one flag that can no longer flip."

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

1. **Kill-switches are off-limits, and recency of a flip is the test.** A flag kept as an operational off-switch (named or commented as such — `disable`, `kill`, `panic`, `fallback`, `circuit` — or wired to env/remote config) must stay whatever its age. For everything else: `git log -S<flagname>` — the flag qualifies only if it has defaulted **on** for ≥ 30 days with **zero flips** in that window and no override site (env var, config key, query param, localStorage read, admin toggle) can still set it off. A flag that *can* be flipped is not shipped; it is armed.
2. **Inline the on-branch exactly; the off-branch dies with the flag.** No behaviour change is permitted on the on-path: the diff must read as substitution of `true`, then dead-branch removal, then plumbing removal (declaration, config schema entry, type, test doubles for the flag). Tests that only tested the off-branch die with it; tests of the on-branch survive and now run unconditionally.
3. **The off-branch's disappearance must be provably invisible.** Failure set identical to a same-commit baseline; grep the flag's string forms afterwards — zero hits anywhere, including docs and config examples, or the leftover is named in the PR.
4. **One flag per day**, ≤ 2 PRs (usually 1). If ≥ 4 routine-authored PRs are already open on the target repo, go **report-only**.
5. **Worktrees only**, `node_modules` overlaid by symlink, never `git add -A`.
6. Report to #om-agent-test **exactly once**, at the end, even when the answer is "every flag is still armed".

## Step 1 — Census the flags

No stack needed; source analysis plus git history.

```bash
cat ~/.local/state/routines/shipped-feature-inliner/done.jsonl   # never re-pick these
```

Find the repo's flag idioms first (a flags module, config schema booleans, `isEnabled(`-style lookups) and census every flag: default value, override sites, age of last flip (`git log -S`), kill-switch tells (rule 1). Rank qualifying flags by **plumbing weight** — the flag whose removal deletes the most conditional structure wins. **Exclude:** flags younger than 30 days, flags ant-shipper has in an open PR or an open escalation, anything in `done.jsonl`.

## Step 2 — Prove it cannot flip

For the chosen flag, document per rule 1: default site, every read site, every write/override site (none may reach "off"), last-flip date. Any override path found → disqualified, into the ping.

## Step 3 — Inline

Substitute, remove dead branches, remove plumbing (rule 2). Repo rules: **openmarket-chat** suites share one process — no global `window` stubs; house gates already fail on main — baseline a same-commit worktree and **diff failure sets**.

## Step 4 — Ship

```bash
/verify        # failure sets identical base vs branch, static gate clean, flag string-forms grep empty
```

```bash
routine-publish.sh --title "chore(<area>): retire shipped flag <flag>" --body-file body.md --repo "$WT"
```

Body: the cannot-flip proof (default, sites, last flip), lines deleted, the post-removal grep, and the `/verify` block. Append to `done.jsonl` whether shipped or declined, with the reason.

## Step 5 — Report

```bash
printf '%s' "$report" | routine-ping.sh
```

Markdown table with a `|---|` separator row, `**bold**` not `__bold__`, single-line cells. Include: the flag, its shipped-since date, lines deleted, PR link, **armed flags left standing** (with the override site or kill-switch tell named), flags handed to ant-shipper, skips with reasons.
