---
name: verify
description: Use before opening any MR from an automated routine (crash fuzzer, ant shipper, logic simplifier) or whenever a fix needs proof it works — runs the repro on the merge-base (must fail), on the fix (must pass), plus the repo's static gate, and emits the verify-report.md that goes into the MR description
---

# /verify — RED→GREEN proof for routine MRs

## Overview

A fix is not verified because it looks right or because tests pass on the branch. It is verified when **the same repro fails without it and passes with it**, and the repo's static gate is clean. This skill produces that proof as a single `verify-report.md` block that gets pasted verbatim into the MR description.

No `verify-report.md` → no MR. A routine that cannot produce one reports the finding to #om-agent-test instead of opening an MR.

## Inputs

| Input | Meaning |
|---|---|
| `REPRO` | path to the committed repro script, relative to repo root (e.g. `tools/fuzz/repros/a1b2c3.repro.ts`) |
| `BRANCH` | the fix branch (defaults to current) |
| `REPO` | repo root (defaults to cwd) |

The repro must exit **non-zero when the bug is present** and **zero when it is fixed**. Repros that only print are not repros.

## Procedure

### Step 1 — Establish the merge-base

```bash
BASE=$(git merge-base HEAD origin/main)   # or origin/master — check the repo's default branch
```

Record the short sha; it goes in the report. Never compare against a stale local main.

### Step 2 — RED: run the repro without the fix

Use a **separate worktree** so the fix branch stays intact and node_modules is not disturbed:

```bash
git worktree add /tmp/verify-base "$BASE"
```

Overlay dependencies rather than installing (openmarket-chat / -cloud cannot `bun install` on this Mac):

```bash
ln -s "$REPO/node_modules" /tmp/verify-base/node_modules
```

Run the repro. **Expected: non-zero exit.** Capture the error type and top application stack frame — that pair is the crash signature the ledger dedupes on.

If the repro passes on base, STOP: either the bug is not real, the repro is not deterministic, or the merge-base is wrong. Report, do not ship.

### Step 3 — GREEN: run the same repro with the fix

```bash
git -C "$REPO" checkout "$BRANCH"
```

Run the identical command. **Expected: exit 0.** Run it **3 times** — a repro that passes once may be racing. All three must pass.

### Step 4 — Static gate

Run the lane for this repo. These are deliberately narrower than the full suite: the full suites are flaky or slow enough that a daily bot would drown in false failures.

| Repo | Gate | Why this lane |
|---|---|---|
| openmarket-chat | `tsc` **error-set diff vs merge-base** + `bun run lint` + `bun test <touched test files>` | **main is not tsc-clean** — measured 2026-08-18, merge-base `99c7aad7` carries 1 pre-existing error (`src/lib/home-library.ts:84`, `RoomDocTask` missing `taskId`/`headRev`). A binary green gate would block every MR forever. Suites also share one process — a stubbed `window` or a moved happyDOM URL breaks *other* suites, so run only what you touched and never add global stubs |
| openmarket-chat-cloud | `tsc` **error-set diff vs merge-base** + `bun run lint` | full bun suite too flaky locally; CI runs on main only, so MRs get no pipeline — this local gate is the only gate |
| om-agent | `bun run check` + `bun test $(ls test/*.test.ts \| grep -v proactive-chart-probe)` | bare `bun test` drags in nested worktrees and invents failures. And **`test/proactive-chart-probe.test.ts` never terminates** — measured 2026-08-20: 121 files report, the probe then errors between tests (`canvas_missing` → `timeout`) and the process wedges with no summary and no exit, so plain `bun test ./test/` eats the routine's whole time cap. Excluding that one file is the only way this gate can finish; name the exclusion in the MR body so a reviewer knows the suite was not fully run |
| openmarket | `bun run check` | |
| desktop shell (openmarket-chat/desktop) | `bun run typecheck && bun run lint` + `bun run smoke` | smoke is the shell's regression floor — a fix that breaks cold start is not a fix |

**tsc error-set diff** (cloud): capture `tsc --noEmit` output on base and on the fix, sort both, and diff. New errors fail the gate; pre-existing errors do not. A raw error *count* is not enough — counts can stay equal while the set changes.

### Step 5 — Emit the report

```markdown
## /verify report — <YYYY-MM-DD> <repo>@<short-sha>

| Check | Command | Result |
|---|---|---|
| RED (repro on merge-base `<base-sha>`) | `bun tools/fuzz/repros/<sig>.repro.ts` | ❌ exit 1 — `TypeError: Cannot read properties of undefined (reading 'seq')` at `RoomView.tsx:412` (expected) |
| GREEN (repro on fix, 3/3 runs) | same | ✅ exit 0, 0 |
| Static gate — typecheck | `bun run typecheck` | ✅ |
| Static gate — lint | `bun run lint` | ✅ |
| Static gate — tests | `bun test src/lib/room-view.test.ts` | ✅ 14 passed |

Verified <ISO timestamp> on <hostname>.
```

### Step 6 — Clean up, and check what you left behind

```bash
git worktree remove /tmp/verify-base --force
```

Leaving verify worktrees behind is how the disk fills and how a later `git worktree` command starts failing.

**Then verify the primary checkout is where you found it:**

```bash
git -C "$REPO" rev-parse --abbrev-ref HEAD    # must be the developer's branch, not "HEAD"
git -C "$REPO" status --short                 # must be as clean/dirty as before
git -C "$REPO" stash list                     # stashes must still be there
```

Observed 2026-08-18: after a worktree round-trip the primary checkout was found on a **detached HEAD at origin/main** instead of the developer's branch. Nothing was lost — the branch, its commit, and a WIP stash were all intact, and `git checkout <branch>` restored it — but an unattended routine that leaves someone's checkout detached will look like data loss to whoever sits down next. Record the branch **before** starting and restore it at the end.

## Hard rules

1. **Never `git add -A`** in a worktree with a symlinked `node_modules` — `node_modules/` in `.gitignore` does not match a symlink, and CI dies with `ENOTDIR`. Add explicit paths.
2. **Report honestly.** If GREEN needed 5 attempts, say so. If the gate was skipped because the repo could not install, say which check did not run — a report claiming ✅ for something unrun is worse than no report.
3. **The repro is committed** before verification, so the reviewer can rerun it. A repro that exists only in `/tmp` proves nothing.
4. Do not "fix" a failing gate by weakening it (deleting the assertion, adding `skip`, loosening a type). That inverts the whole point.

## Failure modes and what they mean

| Symptom | Meaning | Action |
|---|---|---|
| Repro passes on base | not a real bug, flaky repro, or wrong merge-base | do not ship; requeue for minimization |
| Repro fails on both | fix does not address this crash | back to systematic debugging |
| GREEN passes 2/3 | race, not a fix | do not ship; the crash is timing-dependent |
| New tsc errors only in cloud | fork divergence (the two chat repos are ~249 commits apart) | port deliberately; never assume the patch applies |
