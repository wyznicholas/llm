# One run, one MR

Every scout run that has rows to port or unport ships them, together with that run's
`docs/web-parity.md` update, as **one MR** on branch `webport/run-<YYMMDD-HHMM>`. The run
merges it itself once the gates and the Android check pass (Nicholas, 2026-10-12: "merge
after checks pass"). Commits are kept, not squashed, so every feature stays its own
revertible commit on `main`, findable by its trailer.

`R=openmarketxyz/frontend/kiyotaka-frontend-app`,
`KFA=~/Documents/GitlabRepos/kiyotaka-frontend-app` (shared checkout: never switch it,
never edit it). Scratch files go in `~/.claude/om-bug-loop/scratch/wp-<short>/`, never
`/private/tmp` (a reboot wipes it).

## Roles

- **Coordinator** (the scout run): judges, writes the doc rows, picks the rows, starts the
  agents, never writes product code, never touches a device.
- **Row agent**, one per `port` or `unport` row, up to 4 live, in parallel: code and
  tests only, no device, no MR.
- **Integrator**, one per run, after every row agent has reported: assembles the run
  branch, rebuilds `chart.html`, runs the gates, does the Android check, opens and merges
  the MR, and updates the doc.

## Row agent (port)

1. Worktree `../kiyotaka-frontend-app-wp-<id>` on branch `webport/wp-<id>` off
   `origin/main`. Deps: APFS clone (`cp -cR $KFA/node_modules …`) after checking
   `git -C $KFA diff --quiet HEAD origin/main -- package.json` (a version-field-only
   difference is fine); for chart-web, `npm ci` with
   `npm_config_userconfig=$HOME/Documents/GitlabRepos/openmarket-chat/.npmrc`.
   `touch …/node_modules/.metadata_never_index`.
2. Read the web change (`git -C ~/Documents/GitlabRepos/kiyotaka-frontend show <sha>`) and
   mobile's code. Mobile `AGENTS.md` is binding. Web is the reference: its behaviour,
   copy and tests. Native code gets both iOS and Android in the same commit.
3. TDD: the failing jest test first, watch it fail, implement, watch it pass, plus a
   control test.
4. Gates vs a detached `origin/main` baseline: `npx jest --watchman=false
   src/features/chart src/shell <touched areas>` **and** `chart-web` when chart-web or
   shared behaviour changed, plus `npx tsc --noEmit` (and `-p chart-web`). The failing
   set must not grow. **Run them on the Linux box** (Nicholas, 2026-10-13: "u can use the
   linux box"), both arms at once:
   `G=~/.claude/om-bug-loop/scratch/linux-gates.sh; $G <baseline-wt> wp-<id>-base <paths> & $G <your-wt> wp-<id> <paths> & wait`.
   Results land in `~/.claude/om-bug-loop/scratch/linux-gates/<label>/` (`summary`,
   `jest.json`, `jest.log`, `tsc.log`, `tsc-cw.log`); compare failing sets from
   `jest.json`. All gates take about a minute there. The box tests the working tree as
   git sees it (tracked + untracked, not ignored), so no `node_modules` needed for gates;
   the TDD loop in step 3 can run single files locally. If the box is unreachable, run
   the gates locally as before, one arm after the other.
5. **Do not commit `assets/chart.html` or `assets/orderbook.html`.** The integrator
   rebuilds them once for the whole run.
6. One commit per row (two at most). Identity `Nicholas Wong
   <nicholaswong@trontalgroup.com>`, explicit paths, `type(scope): lowercase summary`, a
   body that says why, then the trailers from `ledger-format.md` (`Web-Port:`, one
   `Web-Commit:` per web SHA) and `Co-Authored-By: Claude Opus 5.5
   <noreply@anthropic.com>`.
7. Push `webport/wp-<id>`. Do not open an MR. Write down, for the integrator: what to
   look at on a device to see the change (screen, steps, what before/after should show),
   and whether it needs a native build (APK).
8. Remove your worktrees. Reply: `row WP-<id> → <commit sha> (device: <what to check>)`,
   or `row WP-<id> → stuck: <why>`.

A row the agent cannot port faithfully (the bug isn't on mobile, the scope is much bigger
than the row says, it needs a product call) → no commit; reply `stuck` with the finding.
The coordinator then sets the row to `undecided` (or Not applicable) with that note.

## Row agent (unport)

Find the row's commits: `git log origin/main --grep "Web-Port: WP-<id>" --format=%H`, plus
any squash SHA listed in the doc's Mobile cell. `git revert --no-edit` them newest first
on `webport/wp-<id>` (resolve conflicts faithfully, and if a later commit builds on it,
stop and reply `stuck`). Amend the message to carry `Web-Port: WP-<id>` and
`Unport: true`. Same gates, no chart.html, push, reply.

## Integrator

1. Worktree on `webport/run-<YYMMDD-HHMM>` off `origin/main`. Cherry-pick each row branch's
   commits in WP order (`git cherry-pick -x`; trailers survive). A conflict between rows:
   resolve faithfully, or drop the later row (back to `port` with a note) and say so.
2. Apply the coordinator's doc changes (the run's new rows, already written by the
   coordinator to `<scratch>/web-parity.patch` or described in the prompt), and set each
   shipped row to `ported` (`unport` → `skip`, "unported <date>") with `!<iid>` in Mobile.
   One commit: `docs(web-parity): run <YYMMDD-HHMM>` with no `Web-Port` trailer.
3. If chart-web changed: `npm ci` chart-web, check a build of `origin/main` alone
   reproduces its committed `chart.html`, then `npm run build:copy` and commit
   `build(chart-web): rebuild chart.html for WP-<ids>`.
4. Full gates on the run branch vs `origin/main`: `npx jest --watchman=false src
   chart-web`, `npx tsc --noEmit`, `npx tsc --noEmit -p chart-web`. Nothing new fails.
   Run both arms on the Linux box in parallel: `linux-gates.sh <wt> run-<stamp> src chart-web`
   and `linux-gates.sh <base-wt> run-<stamp>-base src chart-web` (see row agent step 4).
5. Android check, per `port-procedure.md` §2 (devices, locks, account safety, the
   "Update required" policy server, one Metro cache per agent): build Metro once
   from the run branch, one before (origin/main) / after (run branch) pass covering every
   row's "what to check", taking the device lock only for the burst. A row that needs
   native code needs debug APKs of both arms (save the installed APK first, put it back
   at the end). A row that fails its check: drop its commits, rebuild, re-run gates, set
   the row back to `port` with the finding in Notes.
6. MR: `glab mr create -R $R --source-branch webport/run-… --target-branch main --title
   "webport: run <YYMMDD-HHMM> (WP-<ids>)" --description "$(cat desc.md)" --yes`.
   The description has one section per row (WP id, web SHAs, what changed, Android
   before/after images uploaded per port-procedure §3, tests), the doc diff summary,
   "iOS: implemented, compiles, not device-tested", and
   `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
7. Merge **without squashing**, so each row keeps its commit and trailers. The project
   squashes by default (`squash_option: default_on`), and `squash=false` on the merge
   call alone is ignored (seed MR !211 squashed anyway, 2026-10-12). So:
   1. Create the MR with `glab mr create … --squash-before-merge=false`, then force it off
      on the MR itself: `glab api --method PUT "projects/openmarketxyz%2Ffrontend%2Fkiyotaka-frontend-app/merge_requests/<iid>" -F squash=false`.
   2. Read it back: `glab mr view <iid> -R $R --output json` must show `"squash": false`.
      If it won't turn off, **do not merge**: leave the MR open and reply
      `open: GitLab forces squash` (a squashed run MR loses per-row commits and trailers).
   3. `glab mr rebase <iid> -R $R`, wait for `detailed_merge_status == "mergeable"`, then
      `glab api --method PUT "projects/openmarketxyz%2Ffrontend%2Fkiyotaka-frontend-app/merge_requests/<iid>/merge" -f sha=<tested head> -F squash=false`
      (retry a 405 once after 15 s).
   4. Check it landed unsquashed: `git log origin/main --grep "Web-Port: WP-<id>"` finds
      every shipped row as its own commit. If it squashed anyway, say so in the reply
      and add each row's squash SHA to its Mobile cell so unport still works.
   If main moved `chart.html` before the merge: rebase, rebuild, re-run gates, push,
   merge the new tested head.
8. Close-out: remove worktrees and the merged `webport/wp-*` branches, stop your servers
   by pid, release locks. Reply: `run <YYMMDD-HHMM> → !<iid> merged (WP-…)`, or
   `→ !<iid> open: <why>`.

Stopping short (no Android device usable, an account prompt, a regression): leave the MR
open and unmerged, keep the shipped rows `in progress` with the reason in Notes, and say so.
The next run finishes it before starting new rows.
