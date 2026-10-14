# Finishing a waiting `webport/*` MR

> A `webport/run-*` MR is finished as a run: follow `run-procedure.md` "Integrator" from where it stopped, and merge it **without squashing** (step 7). This file is for older single-row `webport/<slug>` MRs.

For a port MR an earlier agent built but left waiting (device host offline, a session
cut off, a question since answered). The coordinator fills in `{IID}`, `{BRANCH}`,
`{SLUG}`, `{SHORT}` and `{EXTRA}`. Web-port-scout's port agents are the sessions allowed
to merge in kiyotaka-frontend-app (GitlabRepos/CLAUDE.md); Nicholas authorised porting
and merging on their own.

MR: !{IID} on openmarketxyz/frontend/kiyotaka-frontend-app (branch `{BRANCH}`). Card:
`~/Documents/Obisidian/kanban/cards/{SLUG}.md`. Read it all, especially the dated
`## Findings` note that says what is left. Board line in
`~/Documents/Obisidian/kanban/Kanban.md` `## todo` ends `· waiting !{IID} (…)` (or a
stale `porting`). When you start, set the marker to
`· porting (web-port-scout <YYYY-MM-DD HH:MM>)` (atomic temp-file + rename; edit only
that line). {EXTRA}

Never use the MacBook Pro (Nicholas, 2026-10-10: unstable). Follow
`references/port-procedure.md` §2–§4 exactly (read it fresh).

1. Fresh worktree of the MR branch; never touch or switch the shared checkout.
   `git fetch && git rebase origin/main`. If `assets/chart.html` conflicts or chart-web
   changed on main: `npm ci` chart-web if its package files changed, rebuild with
   `npm run build:copy` (never hand-resolve), and check a build of origin/main alone
   reproduces its committed chart.html. Re-run the MR's scoped gates (jest + tsc vs an
   origin/main baseline), always including the app-side suites `src/features/chart src/shell`
   as well as `chart-web`: on 10-12 two app tests went stale on main after chart-web-only runs. Push with `--force-with-lease`, on your own webport branch only.
2. Start Metro with its own `TMPDIR` and `--clear` (Expo's shared cache serves other
   agents' builds), plus the local "Update required" policy server; grep the served
   bundle for your change. Then device check on a signed-in Android device: the Mac mini
   emulator (lock `miniEmu`, `~/.claude/om-bug-loop/scratch/remote-emu.sh mini …`) or
   the Linux box emulator (lock `linuxEmu`, `remote-emu.sh linux …`, x86_64 APKs only);
   never the Redmi tablet (Nicholas's manual device). Take whichever lock is
   free (`mobile-alerts-sim-turn.sh status "linuxEmu miniEmu"`) as `wp-{SHORT}`, only for
   the burst; release it right after. Before (origin/main) vs after (branch). Record and
   restore his exact starting state; screenshot the restored state. Never shut the mini
   emulator down; force-stop the app when done. Found signed out: stop the device step
   and note it (never sign in).
3. Update the MR description with the Android before/after evidence. Merge per §3:
   `glab mr rebase`, wait for `detailed_merge_status == "mergeable"` (retry a 405 once
   after 15 s), `glab mr merge --squash --sha <tested sha> --yes`. If main moved
   chart.html again before the merge, rebuild and re-run gates first: the tested build
   must be what lands.
4. §4 close-out: board line to `## Done` as `- [x] … · merged !{IID} <url>` (drop stale
   markers), Feature Map page(s) if the card says so, remove your worktrees, stop your own
   Metro and policy servers by pid.

Other agents finish other MRs at the same time, queue on the same two device locks, and
several rebuild `assets/chart.html`; whoever merges later rebases and rebuilds. Keep your
scratch files in `~/.claude/om-bug-loop/scratch/wp-{SHORT}/` (`/private/tmp` is wiped on
reboot).

Hard limits: touch only this #web-port card; never post in OM Chat; on Nicholas's devices
never touch alerts, alert lines or any delete/trash control, never sign out, never press
"Resume here", never answer an account prompt (except the Passwords sheet's "Do this
later"); one tap at a time with a screenshot after each; load gates; never `pkill expo`.
Cap long commands at 10 min. Commit identity Nicholas Wong
<nicholaswong@trontalgroup.com>, explicit paths only, trailer
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The MR keeps "iOS:
implemented, compiles, not device-tested".

Stopping short (host offline, a regression you can't fix faithfully, an account prompt):
leave the MR unmerged, add a dated note under `## Findings`, and set the board marker to
`· waiting !{IID} (<why>)`.

End with exactly one line: `finished !{IID} → (merged | waiting: <why>)`.
