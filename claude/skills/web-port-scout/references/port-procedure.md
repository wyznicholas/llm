# Porting one `#web-port` card, end to end

> **Since 2026-10-12 ports ship through `run-procedure.md`** (one MR per scout run, rows from `docs/web-parity.md`, trailers on every commit, merged without squashing). This file is still the reference for code rules (§1), devices and account safety (§2) and MR images (§3); its per-card claim (§0) and per-card MR/close-out (§3–§4) are superseded.


Nicholas, 2026-10-08: the scheduled run ports its own cards ("no port them on its
own"), from code through both devices to the merge, one background agent per card
(SKILL.md step 7). The scout has already claimed your card (§0); another agent may be
porting a second card at the same time, so the device turn locks and the
rebase-before-merge in §3 are what keep you apart. This is the recipe that shipped
!89 and !90 that day. Follow it in order and skip nothing. Where a step cannot be
done, the card **waits**: the MR stays open or is never opened, a note goes on the
card, and the next run retries. **Nothing merges without both platforms checked**,
or a platform named in the MR as impossible for a stated reason that is not "busy".

`R=openmarketxyz/frontend/kiyotaka-frontend-app`, `SC=~/.claude/om-bug-loop/scratch`,
`KFA=~/Documents/GitlabRepos/kiyotaka-frontend-app` (the shared checkout sits on
`production`: never switch it, never edit it).

## 0. Claim

- Pick the card from the board's `## todo`: a raw line tagged `#web-port`, oldest
  first. Read its note `~/Documents/Obisidian/kanban/cards/<slug>.md`.
- Append ` · porting (web-port-scout <YYYY-MM-DD HH:MM>)` to its board line. A line
  that already has that marker from under 6 hours ago belongs to another run: skip it.
- Before any code, re-check that the port has not landed meanwhile (git log on
  mobile `origin/main` and `glab mr list -R $R`). If it has, move the line to `## Done`
  with "already ported by <who> in <sha/!iid>" and stop.

## 1. Code

- Worktree: `git -C $KFA fetch -q origin && git -C $KFA worktree add -q -b webport/<slug-short> ../kiyotaka-frontend-app-wp-<slug-short> origin/main`.
- Deps (APFS clones, never symlinks): `cp -cR $KFA/node_modules <wt>/node_modules`
  (check first that `git -C $KFA diff --quiet HEAD origin/main -- package.json`
  passes, else stop and leave a card note). For chart-web: `cd <wt>/chart-web &&
  npm_config_userconfig=$HOME/Documents/GitlabRepos/openmarket-chat/.npmrc npm ci`.
  `touch .../node_modules/.metadata_never_index` for both.
- Node: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH` for jest/tsc/build, and
  `$HOME/.nvm/versions/node/v24.19.0/bin` + `LANG=en_US.UTF-8` for Metro.
- Read the web change (`git -C ~/Documents/GitlabRepos/kiyotaka-frontend show <sha>`)
  and mobile's code. Mobile `AGENTS.md` rules are binding (G2 nav facade, G3 no
  deletes, G5 chart math lives in chart-web, …). Web is the reference: port its
  behaviour and copy, and its tests where they exist.
- **TDD**: write the failing jest test first (`npx jest --watchman=false <files>`),
  watch it fail, implement, then watch it pass. Include a control test for
  behaviour that must not change.
- Gates against a baseline (always include the app-side `src/features/chart src/shell` suites, even for a chart-web-only change; 10-12 two stale tests slipped onto main): run the full `npx jest --watchman=false chart-web` (or the
  touched area) and `npx tsc --noEmit -p chart-web` on both the branch and a
  detached `origin/main` worktree. The failing **set** must not grow.
- chart-web changed → `npm run build:copy`, commit `assets/chart.html` (and
  `orderbook.html` if it changed). Check that a build of `origin/main` alone
  reproduces its committed `chart.html`; if it does not, say so in the MR.
- Commit: identity `Nicholas Wong <nicholaswong@trontalgroup.com>`, stage explicit
  paths (never `git add -A`), message `type(scope): lowercase summary`, a body that
  says WHY, the web SHA, and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## 2. Devices (both platforms, Nicholas's real account)

> **Android devices since 2026-10-10 (Nicholas).** Do not use the MacBook Pro ("unstable"): no `mbpEmu`, no ssh/adb to nicholass-macbook-pro. Use any of these, all signed in to his real account (same account-safety rules); take whichever lock is free:
> - **Mac mini emulator**: lock `miniEmu`, driver `~/.claude/om-bug-loop/scratch/remote-emu.sh mini …` (local serial 127.0.0.1:6556, 1080×2400). It is long-running; never shut it down (no `shutdown`), just force-stop the app when done.
> - **Never the USB Redmi tablet** (`redmiPad`, c3eb2c357d86): Nicholas, 2026-10-13: "redmi is my manual testing". This reverses the 10-10 approval.
> - **Linux box emulator** (since 2026-10-13, Nicholas: "it should use it as an android emulator"): lock `linuxEmu`, driver `~/.claude/om-bug-loop/scratch/remote-emu.sh linux …` (local serial 127.0.0.1:6557, 1080×2400, x86_64 Pixel 7). Signed in to his account (same safety rules). `remote-emu.sh linux launch <metroPort>` does the `adb reverse`; also `remote-emu.sh linux adb reverse tcp:<policyPort> tcp:<policyPort>`. It is the **least loaded** device (32 threads, mostly idle): prefer it when free. Native rows: it needs its OWN **x86_64** APK (the usual arm64-only APK crashes there with `SoLoaderDSONotFoundError`); build it in the mini's `~/repos/kfa-linux-x86` tree (`./gradlew :app:assembleDebug -PreactNativeArchitectures=x86_64`, recipe in skills/om-bug-loop/references/kiyotaka-frontend-app-env.md) or do native rows on miniEmu instead. Its emulator is long-running: never `shutdown`; after a session force-stop the app, go Home and `remote-emu.sh linux snapshot-save` so the sign-in token survives a reboot.
> Mini runs dev client 1.0.5, Linux 1.0.7: the "Update required" workaround below still applies to all. Metro on this Mac, `adb reverse` to the device.

Load gates: this Mac `uptime` 1-min < 25 and the mini < 16. Wait with one `until`
loop of at most 10 minutes; still high → the card waits for the next run.

| platform | device | turn lock | driver |
|---|---|---|---|
| iOS | mini iPhone Test1 (signed in) | `$SC/mobile-alerts-sim-turn.sh take miniTest1 wp-<slug>` | `$SC/mini-sim.sh Test1 …` (points 402×874) |
| Android | MacBook Pro emulator (signed in, see `$SC/mbp-emu-signed-in`) | `… take mbpEmu wp-<slug>` | `$SC/remote-emu.sh mbp …` (px 1080×2400) |

The mini's `emulator-5554` is a guest: never sign it in, and never use the Redmi tablet.

- One Metro, on a free port 8180–8189, from your worktree:
  `EXPO_PUBLIC_V2_WS=wss://api.chart.ore.kiyotaka.ai/v2/ env -u CI npx expo start --dev-client --port <p>`.
  Warm the bundle before launching (curl the manifest, then the `launchAsset.url`).
  Restart Metro between arms: it serves stale code otherwise.
- **Before/after on each platform**, same device, same screen. When only
  `assets/chart.html` differs, swap that one file between arms (main's copy vs yours),
  restart Metro, confirm with `curl localhost:<p>/assets/assets/chart.html?platform=ios | cmp - <file>`,
  then relaunch. Otherwise run arms from a detached `origin/main` worktree.
- **One Metro cache per agent (2026-10-10).** Several agents run Metro at once and Expo's default cache is shared, so one agent's Metro can serve another agent's build (seen: wrong policy port baked in). Start each Metro with its own `TMPDIR` (e.g. `TMPDIR=<your scratchpad>/metro-tmp`) and `--clear`, and check the served bundle contains your change (grep the launchAsset) before launching.
- **Hold the lock only for the device burst.** Code, build, test and warm Metro before
  `take mbpEmu`; release it the moment your screenshots are done. Up to 4 port agents
  queue on it (SKILL.md step 7), so a lock held while compiling idles everyone.
- **Android "Update required" gate (since 2026-10-09):** the live
  `openmarket.xyz/app-version.json` requires Android ≥ 1.0.6 and the emulator's dev client
  is 1.0.5. Serve a local permissive policy on a free port, `adb reverse` it, and start
  your Metro with `EXPO_PUBLIC_APP_UPDATE_URL` pointing at it, the same for both arms.
  No product code change; say so in the MR.
- **Shut down through `remote-emu.sh mbp shutdown`** (it re-saves the `warm` snapshot so
  the sign-in survives), never `adb emu kill`. Found signed out → stop the device step
  and note it; never sign in. The "Passwords are going away" sheet: Nicholas says tap
  "Do this later".
- **Account safety: these are rules, not tips.**
  - Note the starting state first (symbol, interval, indicators, layout), and
    restore it exactly at the end. Screenshot the restored state.
  - **One tap at a time, screenshot after each.** Never chain taps. On a loaded
    machine taps land late, and on 10-08 one landed on a real alert line.
  - Never touch HIS alerts, alert lines, indicators or drawings, or anything with a trash
    or delete icon, except items you added yourself under the next rule. Never sign out.
    Never press "Resume here" on the real-time CME prompt.
  - **Test setups on his account are allowed** (Nicholas, 2026-10-14: "just add them into
    my account, i allow them to do so"), so a row is not held back for lack of an
    indicator, drawing or alert to look at:
    1. Add only what the row's check needs (one indicator, one drawing, or one alert).
    2. Before adding, screenshot the starting lists it joins: the chart's indicator list,
       its drawings/object list, or the Alerts list.
    3. Alerts: name them `[test] <row id> …`. Keep the level ≥ 50% from live price unless
       the check needs it to fire. If it must fire (e.g. an alert the server pauses for
       refiring), turn off every outside delivery (webhook, Telegram, email, push) on that
       alert first; if that isn't possible, skip the device check and ship on tests. Never
       put Create inside a batched or scripted tap flow; one tap, one screenshot.
       A deliberately refused create (expiry in the past, http: webhook) is fine: it saves
       nothing.
    4. Remove exactly what you added, on the item you added (match by its `[test]` name,
       or by it being absent from the starting list), then screenshot the lists again:
       they must match step 2. Never delete, edit, pause or resume an item that was there
       before you started.
    5. Say in the MR which test items were added and removed, with the start/end
       screenshots.
  - **Never answer an account prompt** (password, passkey, subscription, terms). If
    one blocks the check, stop the device step, leave the MR unmerged, and note it.
    Nicholas answers those himself.
  - Repro for cloud-script paths: BTCUSDT, the interval in question, Marketplace
    `@om-core/adl`.
- Release both turn locks, `mbp-emu.sh unlaunch <p>`, and stop your Metro, by the pid
  listening on your port. Never `pkill expo`.

## 3. MR and merge

- `git fetch && git rebase origin/main`. A conflict in `assets/chart.html` → rebuild it
  (`npm ci` chart-web first if `chart-web/package*.json` changed on main), never
  hand-resolve. Rerun the scoped tests, then push.
- Images: `T=$(glab config get token --host gitlab.com)`, then
  `curl -s -H "PRIVATE-TOKEN: $T" -F "file=@x.png" https://gitlab.com/api/v4/projects/openmarketxyz%2Ffrontend%2Fkiyotaka-frontend-app/uploads`
  and paste `.markdown` with `{width=240}`.
- `glab mr create -R $R --source-branch webport/<…> --target-branch main --title "<commit subject>" --description "$(cat desc.md)" --yes`.
  The description has: What / Why (web SHA link) / How / Evidence (both platforms'
  before and after; a platform that could not be run, named with the reason) /
  Tests (commands + counts vs baseline) / `## The other way to do this` when there
  was a real fork / `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Merge only when** both platforms show the fix (or one is named impossible for a
  reason other than busy or load), and the tests and tsc show no new failures vs main.
  1. `glab mr rebase <iid> -R $R`, then read `.sha` from `glab mr view <iid> -R $R --output json`.
  2. Wait (one `until` loop) for `detailed_merge_status == "mergeable"`. Merging
     while it is "unchecked" returns 405.
  3. `glab mr merge <iid> -R $R --squash --sha <that sha> --yes`. The project is
     fast-forward only, squashes by default, and has no CI.
  4. If the rebase changed `assets/chart.html` (main moved in chart-web), rebuild,
     re-test and push before merging, because the tested build must be what lands.
- Another agent may merge its port while you work: both touch `chart.html`. Whoever
  merges second rebases and rebuilds first (step 4 above); never hand-resolve the
  artifact. `take` on a turn lock blocks until the other agent releases it: code
  while you wait.

## 4. Close out

- Board: move the card's line from `## todo` to `## Done` as
  `- [x] <title> <tags> [[kanban/cards/<slug>|details]] · merged !<iid> <url>`. Edit
  only that line, atomically (write a temp file, then rename). The board is shared.
- Remove your worktrees (`git -C $KFA worktree remove --force <wt>`) and any baseline worktree.
- A `port-new` (`#feature`) port also writes its Feature Map page in
  `~/Documents/Obisidian/openmarket-mobile-charts/Feature Map/`, which is how the
  scout knows mobile has it.
- Reply line: `ported <title> → !<iid> (merged | waiting: <why>)`.
