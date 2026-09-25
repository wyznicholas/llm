# Watching the agents

*A reference for the `om-bug-loop` coordinator. `SKILL.md` carries the policy and the decision rules; this file carries the mechanics. If the two ever disagree, `SKILL.md` wins and this one is the bug.*

The coordinator's failure mode is reactive: it waits for completion
notifications, and a task quietly overrunning looks exactly like one making
progress. That is not a habit problem, it is a missing instrument — so there is
a command, and **running it is a duty, not an option**:

```bash
bun ~/.claude/skills/om-bug-loop/scripts/task-watch.ts
```

One line per live task: ref, status, slug, **elapsed** in the current phase, and
**how long since it last wrote an artifact**. Exit 1 if anything is past the
hour. Run it whenever you surface to answer Nicholas, and whenever a
notification arrives — not only when he asks.

**Launch it as a background task at `start`, exactly like the to-do watcher.**
A command nobody runs is a habit again — that is how a task reached 63 minutes
with nobody noticing. Same wake pattern the pipeline already trusts: it polls
quietly and **exits when there is something to act on**, and the exit re-invokes
you.

```bash
bun ~/.claude/skills/om-bug-loop/scripts/task-watch.ts --watch
```

| exit | meaning | do |
|---|---|---|
| 0 | a task crossed the checkpoint or the hour | nudge that task, then relaunch the watcher |
| 3 | heartbeat, an hour with nothing to say | relaunch silently — **unless nothing is live**, in which case leave it down and start it again on the next dispatch. An hourly wake to report an empty pipeline is noise |

It alerts on the **transition** into a threshold, never on standing state — it
seeds itself with whatever is already flagged at launch, so relaunching after a
nudge does not immediately re-fire on the same task.

**Read the two signals as different things:**

- **ELAPSED ≥ 40 min** — the checkpoint. Ask the owner where it is and whether
  it will make the hour. A coordinator that intervenes at 40 minutes can
  re-scope; one that notices at 2h30 can only record it.
- **ELAPSED ≥ 60 min** — past budget. It owes an unprompted timing account, and
  you should be telling it to close out rather than waiting for it to finish.
- **QUIET ≥ ~12 min** — *look*, do not escalate. A long silence is usually a
  build or a test run: one task sat silent 11 minutes on a visual subset and was
  perfectly healthy. A genuine stall is reported by the harness. Check the
  worktree and the last artifact before concluding anything, and **never** kill
  a task on quiet alone.

**Report every nudge to Nicholas, in chat, as you send it** (his instruction,
2026-09-03: *"everytime you nudge anything report it back here, so i know it's
still going on"*). Say which task, why, and what you told it to do. A nudge is
the only visible sign that a long-running task is being managed rather than
forgotten — from the outside, a silent coordinator and an absent one look
identical. Include what you found when you checked, not just that you checked.

**The checkpoint is now the AGENT's to enforce, not yours.** A coordinator message cannot
reach an owner that is inside a blocking verifier — an inbox drains only at a
tool round — so on T32 the 40-minute checkpoint landed ~90 minutes late, after every
question in it had been answered by events. `om-task` now carries a **self-imposed stop**:
past 40 minutes and not close to shipping, it ends its turn with an interim report and
waits. Keep running `task-watch.ts` — it is still how you see the clock and catch drift —
but read a threshold crossing as "expect an interim report", not as "send a question that
may arrive after it no longer matters".

**Messaging a busy agent interrupts it**, so the checkpoint nudge is not free —
it cost one task a Codex run. Use it when the clock justifies the interruption,
not as a status poll. What is free is running `task-watch.ts` and reading the
board.

It also catches state drift the board hides: T23 shipped and merged while its
`tasks.json` status still read `reviewing`, so it showed as a live task idle for
43 minutes. Nothing else would have surfaced that.


# Wall clock: never pay for a build or a home copy twice

> **This section is the CHAT lane only.** `arm-env.sh`, `clone_home`,
> `base_dist`, the 347 MB `OM_HOME` clone and the `:31417` base-arm shortcut all
> describe the OM Chat daemon and have no chart equivalent — a chart task runs
> `pnpm dev` in each of its own worktrees. What DOES carry over is the
> obligation: report build and boot cost as a number, so the chart lane earns
> its own baseline instead of inheriting this one's argument.

Nicholas's standing instruction (2026-09-04): **a timeline whose largest block is
"build + daemon boot" is a pipeline failure, not an explanation.** T33 was a
one-line diff whose 31 minutes were 9 min build+boot for the fix arm, 3.5 min
setup for the base arm, and 89 seconds of actual Codex. That ratio is not
allowed to recur.

Three things remove it, and every CHAT `impl-` prompt must carry them:

1. **`clone_home` instead of `rsync`.** The home is 347 MB and used to be byte-copied
   per arm. On APFS a copy-on-write clone is **0.07 s, measured**. `. scripts/arm-env.sh`
   then `clone_home "$S/om-home"` — it clones and strips `.om-runner.lock`,
   `om.sqlite-shm` and `runner.boot.marker`, and fails loudly rather than falling back
   to a slow copy.
2. **`base_dist <commit>` instead of building the base.** Every task in a batch shares
   one pinned base, and a build is a deterministic function of a commit — so five
   owners building byte-identical base bundles is four wasted builds. `base_dist`
   returns a shared commit-keyed `dist/`, builds it at most once, and makes concurrent
   callers wait on a lock rather than race. **It is safe again only with its
   assertion (fixed 2026-09-15).** Between f190644c and the fix, it compiled the
   shared checkout's `packages/chat-ui` into every base. It now refuses to cache
   unless `@openmarket/chat-ui` resolved inside its own build worktree and matched
   the commit's tree. Every prompt that hands out `base_dist` must also say:
   check `BUILD-INFO.json` next to the returned `dist/` (`commit` is the base sha,
   `assertion.status` is `pass`) and cite it. Owner-built arms use
   `overlay_node_modules` + `assert_arm_build` → `openmarket-chat-env.md` §2 and §7.
3. **Prefer `:31417` for the BASE arm**, which removes that arm's build *and* boot
   entirely. `review-gate.md` gives the three conditions; the stamp check is mandatory, but so is
   actually trying it. Booting a second daemon you did not need is the most expensive
   avoidable mistake in this pipeline.

Fix 2 is also the contention fix. Builds collide worse than measurements, and the
dispatch gate cannot see the difference — so the durable answer is fewer builds,
not more pacing.

**Every owner reports its build/boot cost as a number** in its timing account. That
is what makes the next regression visible instead of anecdotal.


# Pin one base per batch, and do the close-out yourself

**Pin a base.** When you dispatch more than one task at a time, choose **one**
`origin/main` commit and give every task in the batch that same base. `main`
moved six-plus times in one afternoon, and every move cost somebody a rebase and
a re-measurement — T23 alone paid 25 minutes, T25 and T29 each rebased and
re-ran, and one PR went conflicting because another task merged and rewrote the
line it sat beside. Rebase once, at the end, per task. Name the pinned base in
every `impl-` prompt.

**Do the close-out yourself.** An owner's turn ends at *"commits on an open batch
PR, verdicts banked, card note written, Feature Map recorded"*. `train.ts ship`
has already written `mrUrl` and `train` — do not backfill those. Everything
after that touches only files you own, so **you** do it:

```bash
kanban.ts upsert <slug> --column Review     # move
# then backfill branch / worktree and status in tasks.json
```

**A batch PR is not mergeable per task.** Read the train with `train.ts status`
— mergeable state and CI per surface — and when one merges, `train.ts landed`
moves **every** ref on it to `Done`. A train that goes conflicting is one rebase
for the whole surface, not one per card; that is the point of it (`trains.md`).

T27 spent ~40 minutes on that tail while its PR was already mergeable; doing it
here took under a minute. Tell owners this explicitly in the prompt, or they
will keep doing it — every task today ended long after its code was correct.

