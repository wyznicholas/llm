---
name: routine-ant-shipper
description: Daily routine that inventories internal-only, flag-gated and unreachable features across the OM Chat repos, then either ships or deletes them based on measured usage — instrumenting first where no telemetry exists, and reporting to #om-agent-test as @om-agent
---

# Daily ant-only shipper

Runs unattended (launchd, 09:40). Scope: **openmarket (openmarket-internal) and openmarket-chat** — the product itself.

**Never** kiyotaka-frontend, **never om-agent** (the agent's own runtime, not the product), **never openmarket-chat-cloud** (a fork ~249 divergences away — a shared delete needs a twin MR).

**Where the code actually is:** `openmarket-chat/src` (467 ts/tsx), and openmarket-internal under **`packages/`, `apps/`, `tools/`** (3094 ts files) — it has **no top-level `src/`**, so a `src`-rooted sweep silently finds nothing there.

Finds features only ants ever walk on — internal-only, flag-gated, or forgotten — and either **ships** them or **deletes** them, based on evidence rather than taste.

**Announce at start:** "Using routine-ant-shipper to inventory ant-only features."

**The lock and the running `claude` process you will find are yours.** `routine-run.sh` took `$ROUTINE_LOCK_HELD` before starting you and `$ROUTINE_RUN_PID` is your own runner, so a `run.lock` directory and a live `claude -p /<skill>` are *you*, not a competing run. Never stand down over them. (2026-08-20: ant-shipper found its own lock, decided another run was in flight, did nothing, and exited 0.)

## Phases — do only `$ROUTINE_PHASE`

This routine runs as four short sessions, not one long one. The protocol (handoff
file, sha check, scratch dir, size rules) is in `~/repos/CLAUDE.md` — read it.
Your steps this session:

| phase | steps |
|---|---|
| `survey` | Steps 0–1 |
| `prove` | Step 2 |
| `act` | Step 3 |
| `publish` | Step 4 |

Stop when your phase is done. Leave everything the next phase needs in
`$ROUTINE_HANDOFF` and `$ROUTINE_WORK`, never only in the conversation.

## Absolute rules

1. **A delete needs numbers.** Deletion PRs quote the usage evidence verbatim — the query, the result, the window dates. A delete without numbers is not eligible to merge.
2. **Never auto-delete anything user-data-touching or billing-adjacent.** Flag it in the ping for a human call.
3. **≤ 2 verdict PRs/day.** Instrumentation PRs (one-liners) are exempt from the cap but still run the static gate.
4. **Worktrees only**, `node_modules` overlaid by symlink, never `git add -A`.
5. Report to #om-agent-test **exactly once**, at the end.

## Step 0 — First run is inventory ONLY

If `ledger.json` has no candidates, this is the first run: do **Step 1 and Step 4 only**. Build the inventory, write it to the ledger, ping it, and stop. No judging, no instrumentation, no PRs.

Measured 2026-08-19: a run that swept and judged in one sitting did not finish inside 25 minutes and was killed with an empty ledger — nothing banked, nothing to show. The sweep is the expensive part and it is worth banking on its own; verdicts are cheap once the ledger exists.

Work **one repo at a time**, writing the ledger after each, so a run that gets cut off still leaves progress behind.

## Step 1 — Sweep

No stack needed. Refresh the candidate inventory and diff it against the ledger:

```bash
cat ~/.local/state/routines/ant-shipper/ledger.json
```

Candidate classes — **measured 2026-08-20**, because the original list was written for a
codebase this isn't, and a sweep for absent idioms spends the whole cap proving nothing:

| Idiom | chat | internal | Verdict after reading the hits |
|---|---|---|---|
| `flags.*` / `flag.*` | 14 | 33 | **NOT gates** — chat: message-render props from user prefs (cozy/dense/compact/mine/op); internal: CLI argv parsing (`flag.name`, `flag.takesValue`). Do not re-sweep |
| `enable[A-Z]…` | 1 | ~70 / 12 names | **NOT gates** — user-invoked setup actions (`enableSlackChat` etc. via `om setup`), pure helpers, vendor SDK options. Do not re-sweep |
| `searchParams.get("…")` | 1 | 37 | **NOT surfaces** — YouTube URL parsing; ordinary REST params (limit/cursor/spaceId). Do not re-sweep |
| `import.meta.env.*` | 3 | 0 | build mode (DEV/PROD/BASE_URL), never a feature gate |
| `VITE_*` | 0 | 0 | a naive `/VITE_[A-Z_]+/` returns **25 false positives** — substrings of `INVITE_*`. Anchor the pattern (`\bVITE_`) or skip |
| env-var gates in **openmarket** | — | **structurally impossible** | `packages/cli/src/shared/env-vars.ts` is a governed registry anchored **bidirectionally** by `test/generated-reference-drift.test.ts`: a var read in src but absent from the registry fails CI, and a registry entry naming nothing in src fails too. A forgotten env gate cannot survive. `OM_TEST_*`/`OM_RUN_*`/`OM_E2E_*` are excluded on purpose — ant-only by design, not candidates |
| `isInternal`, `internalOnly`, `staffOnly`, `featureFlag*`, `experimental*`, `__DEV__`, `isDev`, `NODE_ENV` | 0 | 0 | do not sweep for these |
| unrouted lazy surfaces | 0 orphans | — | all 30 exports of `components/lazy-surfaces.tsx` have live references |

**The classes above are measured, not guessed — the 2026-08-20 inventory read every hit.**
The remaining honest work is therefore NOT grep-shaped. Start from `ledger.json`'s
`examined` and `openQuestions`, and reach for reachability-by-reading only when a
surface has no link, no nav entry and no docs — then **check its churn before
proposing a delete**: `KitchenSink.tsx` looks abandoned (hash-only, unlinked, 1190
lines) and has 28 commits in 90 days. Reachability alone would have deleted live
dev infrastructure.

Also still worth sweeping (no cheap grep exists, so cap the effort): exported-but-unrouted
pages/components reachable only by a URL nobody links to, and flags that are **always on** in
every config — the flag itself is then the ant-only thing.

If a class above measures 0 again, say so in the report as a measured zero and move on; an
empty inventory is a finding, not a failure, but it must be reported as measured rather than
left to look like a dead routine.

## Step 2 — Judge, by evidence tier

**Tier 3 — static certainty.** Provably unreachable (gate constant-false everywhere, no toggle path) ⇒ delete now. The truth table *is* the reachability proof; no waiting window needed.

**Tier 1 — existing telemetry.** Query daemon/chat-service logs or room-feature usage. Expect this tier to be thin: the chat repos have no Sentry/Faro.

**Tier 2 — instrument and wait.** Where there is no telemetry, day-1 action is a tiny PR adding one usage log line at the feature's entry point, and the candidate enters the ledger with a **7-day window**:

```json
{ "id": "chat:VITE_DEBUG_PRESENCE_PANEL", "tier": "instrumented",
  "instrumentedAt": "2026-08-19", "decideAfter": "2026-08-26",
  "hits": null, "verdict": null, "prUrl": null }
```

When a window closes: any real (non-team) usage ⇒ **ship** (remove the gate, promote the UI, update docs). Zero ⇒ **delete** (feature + flag + its tests + the instrumentation you added). Ambiguous ⇒ extend once, then escalate in the ping for a human decision.

## Step 3 — Act

The truth table here proves **reachability and equivalence**, not a crash fix:

| # | Build/config | Path to feature | Expected after PR | Before | After |
|---|---|---|---|---|---|
| 1 | prod config | gated entry point | (ship) reachable without flag / (delete) 404s cleanly | flag-gated | ✅ |
| 2 | prod config | every call site of the removed flag | compiles, no dangling refs | n/a | ✅ tsc clean |
| 3 | dev config | the old debug toggle | no orphaned UI | present | ✅ removed |

Back row 1 with a real walk to the entry point in the running app, asserting presence or absence — not by reading the code.

**You must boot the world yourself.** `routine-run.sh` only preflights the stack for skills whose name contains `fuzz`, so this routine starts with nothing running:

```bash
routine-stack-up.sh || echo "cannot verify reachability"   # exit 1 = do NOT guess
```

Then drive `127.0.0.1:31398/rooms/`. If stack-up fails, downgrade the verdict to "unverified" and report it — never infer reachability from source alone for a delete.

```bash
/verify
routine-publish.sh --title "..." --body-file body.md --repo "$WT"
```

## Step 4 — Report

```bash
printf '%s' "$report" | routine-ping.sh
```

Markdown table with a `|---|` separator row, `**bold**` not `__bold__`, single-line cells. Include: inventory delta, verdicts issued with their evidence, windows still open with their close dates, and anything escalated for a human.
