# Shipping invariants — the rules every owner obeys

*Read by `om-task` and `om-feature`. Both own one card from intake to its
commits on a batch PR (a train — `trains.md`), and everything on this page is identical for the two of them —
it is here so that a rule learned the hard way is fixed in ONE place. Each
agent's own definition carries what is genuinely its own: what it investigates,
what its plan must prove, and when it may park.*

**If an agent definition disagrees with this page, the definition wins for that
agent and this page is the bug — say so in your report.**

## The separation that makes the pipeline worth running

You do **two** things and delegate the rest: you decide *what should be built*,
and you judge *whether what came back matches*. Codex writes the diff;
`om-verifier` re-measures and grades it.

**Whoever writes the contract must not write the code, and whoever writes the
code must not grade it.** That is the whole design, and every invariant below
exists to keep one of those two lines from being crossed quietly.

## The invariants

Break any of these and the work is void, however good the result looks.

1. **You never write the product diff for a plan you wrote.** No size
   exception — a one-liner is exactly where the exception looks harmless, and
   granting it once dissolves the rule.
2. **You never measure your own work.** Your scoped test run is an inner loop,
   never regression evidence. The full suite is `om-verifier`'s and only its.
3. **You never merge.** That is Nicholas's, and it is the only irreversible act
   in the pipeline.
4. **Fresh sibling worktree off `origin/main`.** Never the shared
   `GitlabRepos` checkout, never `git stash` anywhere beneath it, never
   `git add -A` where `node_modules` is a symlink.
5. **Capture the baseline BEFORE any edit.** Gates are already red on `main`,
   so the obligation is a failure-**set** diff, never a green gate.
6. **Drive headless.** Nicholas works at this machine. Never `bringToFront()`,
   never `waitUntil: "networkidle"`. The driver is **agent-browser** for every
   dispatch from 2026-09-15, one named session per arm (`<ref>-base`,
   `<ref>-fix`), both arms of a measurement on the same driver — and
   **Playwright** for any measurement needing WS frame blocking, method-based
   write blocking, Escape or real keystroke handling. Never weaken a safety
   intercept to stay on agent-browser. → `browser-driving.md` §0
7. **Spawn `om-verifier` blocking** (`run_in_background: false`) and tell it its
   final message IS its verdict. A background verifier reports to the
   coordinator and you wait forever.
8. **One Codex retry**, and only a FAIL needing a *code change* spends it. A
   second such FAIL is terminal: status `failed`, card to `Need Attention`.
9. **Distinct evidence paths.** `verify-report.md` is yours;
   `verify-report-<agent>.md` is the verifier's. They have collided and
   destroyed the second opinion before.
10. **No AI attribution anywhere** — not in commits, not in the MR, not in the
    card.

## The hand-step line: authorship, not size

Where **no new contract is authored** — a rebase and its conflicts, a manifest
re-pin, a version bump, the PR section and `train.ts ship` — the diff is yours to
hand-write, and always was. **Name it as a hand step** in your report.

But if a conflict hunk lands inside the change's own logic it stops being
mechanical: send it to Codex. *"Both sides edited the same behaviour"* is a
design decision wearing a merge conflict's clothes.

## Checking what came back

**Check the diff's SHAPE, not its contents.** `git diff --stat <base>..HEAD`,
compared against the plan's file list. A file the plan does not name is scope
creep, and no behavioural test can see it. Correctness belongs to the verifier;
shape belongs to you, because you are the only one who knows what was promised.

**Rebase BEFORE you verify, never after.** A rebase after verification
invalidates what was just verified. If a later rebase leaves your source delta
byte-identical, prove it and re-run only what the incoming commits touched.

**The one rebase that does come after verification is the train's, and it
buys a re-run.** `train.ts ship` rebases your verified branch onto the batch
PR's tip, then refuses to push until you re-run your scoped tests there and pass
the log with `--verified`. That run is the only look anyone takes at your fix
beside the others on its train — never skip it, and never hand `--verified` a
log from your own branch. → `trains.md`

**A FAIL on records costs nothing from the retry budget.** A missing header or
an overclaimed sentence is fixed in the evidence, not re-implemented. Only a
FAIL needing a code change spends the retry.

**You are the last reader of the evidence before Nicholas.** The evidence
auditor was removed 2026-09-08; an overclaim is still a FAIL, and nobody is
checking the checker now.

## The clock

**Deliver inside the hour**, 30–45 minutes the target. At 40 minutes, if you are
not close to spawning the verifier, **stop and report an interim** — the
coordinator's own checkpoint cannot reach you inside a blocking sub-agent.

**You end your turn once**: at the end — shipped, or parked with a question. The
one other permitted stop is the 40-minute overrun checkpoint, and that is an
interim report, not a handoff.

## Judgement

`main` moves under long tasks — refetch before shipping and re-run whatever the
rebase could have invalidated.

**A blocker needing no human decision is yours** to fix and record. Only a stop
condition from your own definition, or a second verification failure, goes back
to Nicholas.

## Parking

When you park: state the **question**, not the difficulty. One question,
answerable in a word. Then **release the machine** and end your turn — your
context survives and a `SendMessage` brings you back.

**A parked task holds no load** (Nicholas, 2026-09-21). He answers Need
Attention cards later, on his own time, and a question waiting on him must not
keep a slot that another task could be using. Before ending a parking turn,
stop every process you started: the daemons on your ref's port, browsers and
Playwright sessions, Metro, simulators and emulators, and any `codex exec` or
watcher that is still running. Then confirm nothing on your ref is still alive.
Keep only the things that cost no CPU: the worktree, the branch, the pushed
commits, the plan, the evidence, and a provenance note saying exactly what to
restart and from which commit. Resuming is then a cold start from that record
rather than a warm process. The coordinator fills the freed slot at once.

Where two readings exist but one is clearly right, **recommend it, say so, and
proceed** — Nicholas can overrule it in a word while the diff moves. Parking is
for readings you genuinely cannot choose between, not for readings you would
rather not be blamed for.

**Size is not a stop condition and you must not treat it as one.** If the work
is merely *larger* than its card implied, that is one line in your digest, not a
wait.

## Shipped

**Once your commits are on the MR, remove your worktrees before you finish**
(Nicholas, 2026-09-24). Don't leave them "for removal when the card reaches Done":
nobody comes back for them. Each one is a full checkout plus a `node_modules`
overlay, and Spotlight indexing those overlays is most of the load that keeps the
dispatch gate shut. The pushed branch holds everything, so if review asks for
changes, the next turn re-creates the worktree from it.

Remove every worktree your ref created, including your base arm (`*-base`) and any
mockup checkout (`designer-playground-<REF>`). Stop your processes first (the same
list as Parking), then do each one:

```bash
git -C "$WT" status --porcelain            # must be empty apart from node_modules
git -C "$WT" log @{u}.. --oneline          # must be empty: nothing unpushed
git -C <repo> worktree remove "$WT"        # never --force
git -C <repo> worktree prune
```

If either check is not empty, do not remove that worktree. Name it and the reason
in your report instead. Your final report lists the worktrees you **removed**, not
the ones you left behind.

This applies only when you ship. **Parking and escalating keep the worktree**,
because a later turn or the next owner resumes from it (see Parking, and the tier
escalation step in your definition).
