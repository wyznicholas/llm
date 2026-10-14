---
name: routine-logic-bugfixer
description: Daily routine that models one piece of tricky logic in the OM Chat repos, proves where its behaviour diverges from its evidenced intent, fixes exactly that divergence with a committed repro, and opens a PR carrying the intent/actual table plus the /verify RED→GREEN proof — reporting to #om-agent-test as @om-agent
---

# Daily logic bugfixer

Runs unattended (launchd, 10:20). Scope: **openmarket (openmarket-internal) and openmarket-chat** — the product itself.

**Never** kiyotaka-frontend. **Never om-agent** — the agent's own runtime is not the product, and a bot patching its own bug-fixing machinery unreviewed is exactly the diff a human must originate. **Never openmarket-chat-cloud**: it is a fork ~249 divergences from openmarket-chat, so a shared-code fix there needs an explicit twin MR — name the twin in the report instead of promising it.

This routine is the complement of routine-logic-simplifier, and their first rules are deliberate inverses: the simplifier must never change behaviour; this routine exists to change behaviour — by the smallest evidenced amount, in exactly one place.

**Announce at start:** "Using routine-logic-bugfixer to fix one evidenced divergence."

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

1. **A bug needs two independent witnesses of intent.** A bug is a divergence between what the code does and what it is *evidenced* to intend — never between the code and your taste. Witnesses of intent: a comment or doc describing the behaviour; a nearby test's name or assertion; the function's own name and signature; the expectation every sibling call site encodes; a spec or README in the repo. **Two independent witnesses or it is not a bug** — with one, the day's output is a question in the ping, not a fix. An unattended bugfixer that invents intent is a bug generator with confidence.
2. **Fix only the divergence.** No refactors, no renames, no drive-by cleanups, no "while I'm here". The reviewer must be able to read the diff as "this one behaviour was wrong, and now it is right". If the fix wants a refactor first, report the hotspot to the simplifier's queue and stand down.
3. **Repro before fix.** A committed repro script that exits non-zero on the bug and zero when fixed — `/verify` runs it RED on the merge-base and GREEN on the branch, and that pair is the entire proof. A divergence that cannot be reproduced deterministically (time, randomness, network, races) produces the intent/actual table and a seam proposal in the ping, **not** a PR.
4. **Rows that are not the bug must not change.** Pin every non-divergent row of the table with characterization tests, green on the untouched code, before fixing. The fix's blast radius is then visible: the divergent rows flip, the rest are armour.
5. **One bug per day**, ≤ 2 PRs (usually 1). If ≥ 4 routine-authored PRs are already open on the target repo, go **report-only** — the review queue is the bottleneck, not the finding rate.
6. **Worktrees only**, `node_modules` overlaid by symlink, never `git add -A`.
7. Report to #om-agent-test **exactly once**, at the end, even when the answer is "nothing evidenced enough to fix".

## Step 1 — Pick the suspect

No stack needed; this routine is source analysis plus tests.

```bash
cat ~/.local/state/routines/logic-bugfixer/done.jsonl        # never re-pick these
cat ~/.local/state/routines/logic-simplifier/done.jsonl      # intake, see below
```

Intake, in priority order:

1. **The simplifier's unfixed findings.** Its rule 1 forbids it from fixing bugs its truth tables expose; it records them in its `done.jsonl` and pings. Those findings arrive pre-modelled — a table already exists and the divergence is already named. Start here.
2. **Own hunt**, ranked by churn × suspicion: `git log --since=90.days --name-only` for alive files, then look for the shapes bugs hide in — a `catch` that swallows and returns a default, `.skip`ped tests with bug-shaped names, FIXME/TODO/XXX comments describing wrong behaviour, boundary conditions handled in one branch and not its twin, sibling call sites that disagree about a return value.

**Exclude:** generated or vendored code, files touched by an open routine PR, anything in `done.jsonl`, and anything whose intended behaviour you cannot witness twice (rule 1) — ambiguity is a report, not a target.

## Step 2 — Model intended vs actual

Read the target and enumerate a truth table with **two output columns: intended and actual.** Intended is filled only from witnesses (cite each one in the table — file:line of the comment, test, or call site). Rows where the columns agree are armour; rows where they diverge are candidate bugs. A row with an empty intended column is an ambiguity — a finding for the ping, never a fix.

## Step 3 — Pin the armour

One characterization test per non-divergent row, against the **current** implementation, all green before any fix. Repo rules:

- **openmarket-chat:** suites share one process — never add a global `window` stub or move happyDOM's URL; it breaks *other* suites, not yours.
- The house gates already fail on main — baseline a same-commit worktree and **diff the failure sets**; never demand absolute green.

## Step 4 — Repro, then fix

Write the repro (committed, under the repo's routine-repro convention), watch it fail. Fix the divergent rows and nothing else. The repro now passes; the armour stays green.

## Step 5 — Prove and ship

```bash
/verify        # repro RED on merge-base, GREEN on fix, plus the repo's static gate
```

```bash
routine-publish.sh --title "fix(<area>): <the divergence, stated as behaviour>" --body-file body.md --repo "$WT"
```

The body carries the **intent/actual table with its witness citations**, the repro path, and the `/verify` block. The pinned tests and the repro are **committed** — they stay as regression armour. `routine-publish.sh` refuses a body with no `/verify report` section.

Append to `done.jsonl` whether you shipped or declined, with the reason and the witness count.

## Step 6 — Report

```bash
printf '%s' "$report" | routine-ping.sh
```

Markdown table with a `|---|` separator row, `**bold**` not `__bold__`, single-line cells. Include: the divergence in one sentence, its two witnesses, the PR link, ambiguities found (rows with no evidenced intent), and anything skipped with reasons.
