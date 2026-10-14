# Trains — batch PRs and MRs by surface

*Read by `om-task`, `om-feature` and the coordinator. `SKILL.md` carries the policy; this file carries the conventions and the commands. If the two disagree, `SKILL.md` wins and this one is the bug.*

**An owner no longer opens its own PR or MR.** It verifies on its own branch exactly as before, then ships its commits onto the open batch review for its surface — a **train** — with `train.ts ship`. Its terminal state is *"my commits are on an open batch review"*, not *"my PR/MR is open"*.

## Why

On 2026-09-15 the pipeline had **55 open PRs, 16 of them approved and still unmerged**. Eight sat on `Shell.tsx`, six on `Sidebar.tsx`, six on `DocPane.tsx` — so every merge conflicted the rest of its file's queue, each conflict cost a rebase and a re-measurement, and the approved ones were not merging because merging one broke the next. One PR per task was the wrong grain: the unit Nicholas reviews and merges is a surface, not a card.

Nicholas approved batching on 2026-09-15. **There is no cap on open PRs, and none may be added** — he declined one explicitly. A train reduces the count by grouping, never by holding work back.

**Approval does not exempt a PR from its surface's train.** The approved PRs were regrouped onto trains on Nicholas's say-so (2026-09-15), approvals and all.

## Conventions

These are fixed. Other agents built the first trains by hand with them, so `train.ts` matches them exactly.

| thing | convention |
|---|---|
| branch | `train/<surface>`, off `origin/main`, one per surface |
| review | one open batch PR/MR per branch, base `main` |
| title | `train(<surface>): <n> fixes — <refs>` — e.g. `train(sidebar): 2 fixes — T167, F33` |
| merge method | GitHub: **Rebase and merge**. GitLab: fast-forward (project `merge_method: ff`); press Rebase first if asked, never squash |
| commits | every commit's subject starts with its ref (`T167 fix(sidebar): …`). `train.ts` adds the prefix if Codex did not |
| body | first line names the host's merge method; then a table — fix, ref, files, lines ±, verifier verdict, how to try; then one `## <ref> · <title>` section per fix |
| ledger | the task's `tasks.json` entry gains `"train": "<surface>"`, and `mrUrl` is the batch PR's URL |
| surfaces | [[kanban/references/train-surfaces|train-surfaces]] — edit it freely; `train.ts` reads it |

**Why rebase-and-merge and ref-prefixed subjects.** A squash would fuse five fixes into one commit, and the first one that turns out wrong would take the other four out with it. Rebased commits land on `main` individually, each carrying its ref, so `git log --grep '^T167'` finds exactly one fix and `git revert` of those commits removes it alone.

**Pick the surface by the file most of the diff lives in**, not by where the symptom showed. The point is that PRs on the same files stop conflicting with each other.

## Forges

The forge follows the raw URL of `origin`, so git pushes and review operations
cannot split across hosts. `github.com` uses `gh`; a host containing `gitlab`
uses `glab api`. Local-path and other origins keep the old `gh repo view`
fallback. `--gh-repo <owner/name>` explicitly selects GitHub;
`--gl-repo <group/path>` explicitly selects GitLab. The web surfaces ship to
`gitlab.com/openmarketxyz/frontend/openmarket-chat`; `openmarket-internal-*`
surfaces stay on GitHub, and `mobile-*` surfaces use the GitLab
`openmarket-chat-app` project.

### What does not map

The normalized fields shown by `status`, and the host constraints around them,
map like this:

| GitHub | GitLab | fit |
|---|---|---|
| `mergeable` | `has_conflicts` + `detailed_merge_status` | derived faithfully |
| `mergeStateStatus` | `detailed_merge_status` | different vocabulary, shown verbatim |
| one CI mark per check run | one mark for `head_pipeline.status` | does not map; inspect pipeline jobs for per-job detail |
| Rebase and merge | project `merge_method: ff` | equivalent individual commits, but GitLab may require Rebase first; never squash |
| CI did not gate merges | green pipeline required; skipped is not allowed | new GitLab constraint |
| approvals did not gate | `not_approved` blocks merge | new GitLab constraint |
| — | source branch deleted after merge | new GitLab constraint; the next train starts fresh |
| `#945` | `!34` | label only |

These are host constraints, not GitHub status fields in disguise.

`<home>/train-holds.json` can stop writes to one forge-qualified repository:

```json
{"gitlab.com/openmarketxyz/frontend/openmarket-chat":"main is being synchronized"}
```

Both calls to `ship` and `drop` exit 75 before the surface lock, fetch, rebuild
or push. `status`, `landed` and `move` ignore holds.

When an existing train must move from the retained `github` remote to a GitLab
`origin`, preview and execute it with:

```bash
bun …/train.ts move <surface> --from-remote github --dry-run
bun …/train.ts move <surface> --from-remote github
```

The dry run fetches and reads only. The real move adopts a matching open MR or
rebuilds the GitHub commits on GitLab `main`, archives a stale destination
branch, opens the MR, closes the GitHub PR, and repoints the ledger and cards.

## The owner's ship step

The owner has already verified on its own branch — the verifier's PASS, the card note, the Feature Map entry, all unchanged. Then:

1. **Write the PR section** to `$EVIDENCE/<ref>/pr-section.md` — what used to be the PR body, headed by three lines of front matter:

   ```markdown
   ---
   title: Clear the drop line when the drag leaves the list
   verdict: PASS — om-verifier, verify-report-om-verifier.md
   try: Drag a channel over the list and out again; the line clears
   ---

   <the old PR body: problem, root cause or acceptance criteria, evidence, the full-suite-not-run line, `## The other way to do this` if the card had an alt>
   ```

   `verdict` and `try` fill the table's columns and are required; `title` falls back to the card title.

2. **Rebase onto the train** — the first call stops on purpose:

   ```bash
   bun ~/.claude/skills/om-bug-loop/scripts/train.ts ship T167 --surface sidebar \
     --branch om-bug-loop/T167-sidebar-drop-line --section "$EVIDENCE/T167/pr-section.md" \
     --test-cmd "bun test --isolate --tsconfig-override ./tsconfig.json" \
     --test-list "$EVIDENCE/T167/scoped-tests.txt" --repo "$WORKTREE"
   ```

   `--test-list` is a file with one test path per line; `--test-cmd` is only the runner prefix (default `bun test`), and the printed command is that prefix plus the listed paths. Stamp and comment lines in the list (`# om-bug-loop:provenance …`, `//`, `<!-- -->`) and blank lines are dropped, each echoed on stderr. It refuses (exit 64) a list that yields zero test files, a listed path that does not exist, and any `#` comment token that would land inside the command — never splice a list in with `$(cat …)`: a stamp line flattened into the printed command turns into a shell comment, and every test path after the `#` is silently skipped while the run still "passes" (F64, 2026-09-15).

   It takes the surface lock, fetches, rebases your commits onto the train tip (or onto `origin/main` if the train is new, or its last PR merged or closed), prefixes any subject missing your ref, and **exits 3 — NOT SHIPPED** — printing the exact command to re-run your scoped tests on the rebased tip.

3. **Re-run the scoped tests on the rebased tip.** Run the printed command; it asserts `HEAD` first and tees into `$EVIDENCE/<ref>/train-reverify-<sha>.log`. Diff the failure **set** against your own branch's run, as always. The verifier graded your branch; the train tip also carries other fixes, and this run is the only thing that looks at the two together.

4. **Ship**, with the log:

   ```bash
   bun …/train.ts ship T167 --surface sidebar --branch … --section … --verified <the log> --repo "$WORKTREE"
   ```

   It refuses a missing log, an empty one, or one older than the rebase. It also requires exactly one bun summary line (`Ran N tests across M files`) with more than zero tests and files, and in `--test-list` mode an `M` between the number of listed files and the number of test files the list can match in the worktree — a range, not an equality, because bun treats each path as a substring filter (F64's 18 entries ran 26 files) and does not print every file it ran. Then it pushes **without force**, creates the batch PR or regenerates its title and body from every section on the train, writes `mrUrl` + `train` into `tasks.json`, and **moves the card**: `kanban.ts stage <slug> shipped`, `kanban.ts status <slug> shipped`, `kanban.ts upsert <slug> --column Review`, then `kanban.ts stamp <slug>` — the four steps the coordinator used to run by hand (cards were left in `in progress` at `reviewing`, T182 and T191 on 2026-09-15). A card already at status `shipped` in `Review` is only stamped.

   **The Review gate still decides.** `upsert --column Review` refuses without a real card note, an embedded image or a "No UI surface" line, a Feature Map entry recorded for this task, and the steps section. When it refuses, the ship is **not** undone — your commits are on the batch PR and `mrUrl` is written, which is correct — but `train.ts` prints the gate's refusal verbatim, then `SHIPPED onto <PR>, but the card could not move to Review. Fix the note, then run: kanban.ts upsert <slug> --column Review`, stamps the card, and **exits 5**. Fix what the refusal names and run that `upsert` yourself. Never re-run `ship` for it: there is nothing left to ship.

   If the train moved while your tests ran, it re-rebases. When the incoming commits touch none of your files it says so and ships; when they overlap, it **exits 3 again** naming the files, and you re-run step 3.

| exit | meaning |
|---|---|
| 0 | shipped — your commits are on the open batch PR, and the card is in `Review` at status `shipped` |
| 5 | shipped, but the card is **not** in `Review` — the Review gate (or `stage`/`status`) refused; fix what it printed, then run `kanban.ts upsert <slug> --column Review`. Do not ship again |
| 3 | rebased, not shipped — run the printed re-verify command, then `--verified` |
| 4 | conflict — your branch is restored untouched; rebase it onto `origin/train/<surface>` yourself (a hand step, unless the hunk is inside the fix's own logic, which goes to Codex) and ship again |
| 75 | the surface lock is held/stale, or the repository is on a ship hold — the message names the lock or hold reason |
| 1 / 64 | refused / usage — the message says what to fix |

A **new surface**: `train.ts ship` refuses a key not in [[kanban/references/train-surfaces|train-surfaces]] and lists the known ones. Pass `--new-surface "<what it covers>"` once and the key is added to the list.

## Dropping a fix, and reverting one

**Before merge — `drop`.** A fix that should not ride the train (a late FAIL, Nicholas says pull it) comes off with:

```bash
bun …/train.ts drop T167 [--reason "<why>"]
```

It rebuilds the train without that ref's commits and pushes with `--force-with-lease` pinned to the tip it read — **the only routine force push in the pipeline**, and the lease is what stops it erasing a fix someone appended a second ago. (The one other lease-guarded write is housekeeping: when a train's PR has merged or closed and its branch is still on the remote, the next `ship` deletes that branch before starting fresh — a closed-unmerged one is first kept as `train-closed/<surface>-<pr>`.) It regenerates the body (or closes the PR if nothing is left), clears `mrUrl` and `train`, and moves the card to `Need Attention`. The fix's own branch still holds its commits, so re-shipping is one `ship` away.

**After merge — revert its commits.** `git log --format='%h %s' origin/main | grep '^[0-9a-f]* T167 '` lists them; revert those, newest first, on a fresh branch, as a normal task. Nothing else on the train is touched.

## Watching and landing

```bash
bun …/train.ts status    # every open train: PR, age, mergeable state, CI, refs
bun …/train.ts landed    # a merged train moves EVERY ref on it to Done
```

For GitHub PRs that merged before the openmarket-chat move, land them against
their original forge explicitly:

```bash
bun …/train.ts landed --gh-repo openmarket-xyz/openmarket-chat
```

**A merged batch PR moves every ref on it to `Done`**, not just the one whose card you happen to be looking at — that is what `landed` is for. It reads the refs off the merged PR's commits, so trains built by hand land too; it skips refs this pipeline does not own (`C<n>`), and it is idempotent. `status` flags any merged train not yet landed.

## Where things live

| what | where |
|---|---|
| the lock, one per surface | `~/.claude/om-bug-loop/locks/train-<surface>.lock` |
| each fix's section, so the body can be regenerated | `~/.claude/om-bug-loop/trains/<surface>/<ref>.md` |
| the train record | `~/.claude/om-bug-loop/trains/<surface>/train.json` |
| a finished or dropped train's sections | `~/.claude/om-bug-loop/trains/<surface>/archive/` |

A section missing from the store — a train another agent built by hand — is imported from the open PR's current body before regeneration, never wiped.

**A stale lock is reported, never stolen.** If the holder's pid is gone, `train.ts` prints the file and the `rm` to run and exits 75; a live holder is waited on up to `--lock-wait` seconds (300) and then reported the same way. It never hangs.
