# Measuring a fix independently

*A reference for `om-verifier`. The agent file carries the contract and the verdict rules; this file carries the how. If the two ever disagree, the agent file wins and this one is the bug.*

Your entire value is independent measurement. Reuse the owner's **bytes** — its `dist/`, its worktrees — but never its **numbers**. Every figure in your report must be one you produced.

This has repeatedly mattered. Independent re-measurement has caught a green component suite hiding a right-click that was broken in the real browser, a regression file set that silently missed every test using a dynamic import, and a `before` screenshot that was actually a later build.


## The scoped test set — the full suite is no longer run

**Stopped by Nicholas, 2026-09-14.** Measured that day: one full-suite run takes ~2–7 min on a quiet machine (as long as its slowest shard), the verifier's base-and-fix pair ~5–15 min, and one pair under load took 16.6 min per run with ~1,345 spurious failures. That does not fit a 60-minute task budget.

**What that gives up, stated plainly.** The full suite was the only check that caught breakage *outside* the files a task touched, and CI is the backstop: since 2026-09-15 main's CI passes Lint, so its `Test` step runs the full bun suite on every PR. A regression outside the scoped set shows up as a red PR check, which counts as evidence. The Playwright visual lane is **not** in CI, so visual regressions can still ship unseen. Every verify report and every PR body must say `Full suite not run (pipeline policy 2026-09-14)`.

Run this set yourself, on both arms. Never reuse the owner's run:

1. **The plan's declared test files.**
2. **Every test file that imports a changed module**, found by grepping imports of each changed file (`grep -a -rlE` in `openmarket-chat`, where NUL-poisoned files skip silently otherwise). Include dynamic imports: a regression file set has missed every test using a dynamic import before.
3. **The filesystem-scanning ratchets**, always, whatever the diff touches. Deleting or moving a component trips ratchets a rebase never reveals, so the branch merges clean and then goes red. These run in seconds.

Diff failure **sets**, never counts, against the same merge-base. The gates are already red on `main`, so a bare pass/fail says nothing:

```bash
grep -E "^\(fail\)" run.txt | sed 's/ \[[0-9.]*ms\]$//' | sort > fails.txt
comm -13 fail-baseline.txt fail-after.txt      # must be empty
```

Read the line above the summary first: `N fail (N confirmed)` is **false** whenever `isolation retry skipped` appears, because nothing was confirmed in isolation.

**Baseline caching:** a base-arm result depends only on the merge-base commit *and the file set*. Reuse a banked run only for that exact commit and set, and bank yours under a name carrying both.

If the scoped set finds a regression the owner's inner loop missed, that is a **FAIL back to the owner**, and it consumes the task's single retry.


## Do not rebuild — serve the owner's `dist/`

A build is a deterministic function of a commit, so rebuilding to review proves nothing and costs a ~300 MB `OM_HOME` copy and a ~22s daemon boot per arm. Point `OM_ROOMS_GUI_DIR` at the existing `dist/` for each arm. This paragraph, and the `:31417` base-arm shortcut below it, describe the **chat** lane. For a `product: chart` task there is no daemon and no `OM_ROOMS_GUI_DIR`: you serve each arm with `pnpm dev` on its own `VITE_PORT` in the owner's existing worktrees, which is why the owner must not remove them until you are done. The principle is unchanged — reuse the owner's bytes, never its numbers.

**Mandatory guard:** assert the served asset stamp (`v=…` in `/rooms/`) and confirm it corresponds to the commit under review *before measuring anything*. A `dist/` you cannot tie to a commit is void — rebuild that one. Never serve the shared checkout's `dist/` on trust; it lags `main` by hours, and reviewing a stale bundle is how a task once shipped a confident report about a page that had already been deleted.

**The stamp does not prove the chat-ui inside the bundle (2026-09-15).** A worktree whose `node_modules` came from the shared checkout compiles the shared checkout's `packages/chat-ui`. Its `om-build` meta still names the worktree's commit. So for a `product: chat` arm, also require one of these: `BUILD-INFO.json` with the base sha and `assertion.status: pass` next to a `base_dist` bundle, or a passing `assert_arm_build <wt> <sha>` for an owner-built arm (`openmarket-chat-env.md` §2 and §7). Without it, the arm is void.

A shared asset stamp is a feature, not a shortcut: it proves both parties drove the same build rather than two builds believed identical.

**Drive on the driver the spec names, both arms.** From 2026-09-15 dispatches default to agent-browser; a measurement that needs WS frame blocking, method-based write blocking, Escape or real keystroke handling runs on Playwright instead (`browser-driving.md` §0). Whichever it is, the base arm and the fix arm run on the **same** one — event delivery differs between the two tools, and a difference between arms must be the diff, not the harness. If the owner's evidence mixes drivers across arms, that measurement is void: re-run it on one. Record the driver and session on every capture with `stamp.ts write … --note "driver=… session=…"`; a capture that cannot name its driver is unprovenanced. Your sessions are your own — `<ref>-verify-base` / `<ref>-verify-fix` — never the owner's `<ref>-base` / `<ref>-fix`, which may still be open.


## Reading a gate's real output

`biome check` **caps diagnostics silently**. A lint set diffed from the default
output is drawn from roughly **8% of the data**, and a "no new diagnostic on a
touched file" claim built on it is not a measurement — it is a sample presented
as a census.

**Always pass `--max-diagnostics=1000` before diffing sets:**

```bash
bunx biome check . --max-diagnostics=1000 --reporter=summary > lint-after.log 2>&1
```

Measured on T27: the capped run supported a claim the audit then demolished; the
uncapped re-run gave the real answer (248 → 247, identical at rule level, one
diagnostic *deleted*). **That should have been the first measurement, not the
third** — it cost ~25 minutes and two audit passes.

## CI checks are not a test signal

Known noise, but **verify rather than recite**: compare per-step CI conclusions against `main`'s own run at the same base and require a **subset**, never green. `Test` is frequently skipped because the workflow stops at the first failure, so a PR check may carry no test signal at all — every test number must be local.
