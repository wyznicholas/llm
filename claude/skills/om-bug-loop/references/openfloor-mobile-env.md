# OpenFloor (mobile) — local environment

> **Lane: `product: mobile`.** Fix repo: `openmarket-chat-app` — the Expo/React
> Native app called **OpenFloor**. The chat lane's
> `references/openmarket-chat-env.md` does **not** apply: different package
> manager, different app, different gates, and no daemon. Written 2026-09-18
> from a first setup on `nicholass-Mac-mini` at `c07f8cb`.

Repo: `~/Documents/GitlabRepos/openmarket-chat-app` (cloned 2026-09-17 with
`glab repo clone openmarketxyz/frontend/openmarket-chat-app` — the gitlab SSH
key is denied on this machine, so `git clone git@gitlab.com:…` fails; use `glab`
or https).

## 0. The rule that matters more than any gate

**This app talks to PRODUCTION.** `src/config/app.ts` ships working defaults for
every endpoint and there is no local backend to point at — a signed-in emulator
is signed in to the real `openmarket.xyz/chat`. So every write an owner makes in
the running app is a real write on a real account, usually **Nicholas's**, and
the cloned-home rule applies here exactly as it does on the web lane: do not
post, react, rename, delete, mute, invite or change settings in the app unless
the write is route-intercepted. Reading is safe; sending is not.

**The emulator is signed in as Nicholas himself, not a test account**
(2026-09-18). That was his call, and he scoped the work with it: **use the
`nalo` server to test things.** So this is a named exception, not an open door:

- Writes are authorised **inside `nalo` only**. Posting, reacting, renaming,
  muting, inviting or changing settings anywhere else on that account is out of
  bounds, exactly as the rule above says.
- **Reads elsewhere are worse than useless**: opening his other channels burns
  his unread state and fires read receipts on his real account, so a "harmless
  look around" costs him something he cannot get back.
- If `nalo` turns out to be member-only, or otherwise wrong for the surface
  under test, **park and ask**. Choosing which of his real servers to experiment
  in is not an owner's decision. `my server` and `my own server` are also in his
  list and may be his own test servers, but nobody has confirmed that — do not
  assume.

A surface that cannot be reached inside `nalo` is one this lane cannot verify
yet. Say so in the write-up rather than inventing a walked path.

## 1. The traps, in the order they bite

### 1. Node 22, not 20 — `docs/OPENFLOOR-ONBOARDING.md` is stale

`src/rooms/__tests__/composer-persistence-sqlite.test.ts:2` imports
`node:sqlite`, which does not exist before Node 22.5 (landed `9edd94a`,
2026-09-09). On Node 20 that suite fails and `pnpm run lint` reports a hard
`import/no-unresolved` error. Put Node 22 first on `PATH` for every command:

    export PATH="/opt/homebrew/opt/node@22/bin:$PATH"   # v22.23.2, keg-only

The global `node` is 26 and works too; 20 does not. Do **not** `brew link` either
one — an earlier `brew install node@22` upgraded `simdutf` and broke
`/opt/homebrew/bin/node` for every other routine on this Mac (fixed with
`brew upgrade merve node`). After any brew work here, run `node -v` before you
trust anything else.

### 2. `pnpm`, never `bun`, never `npm`

`packageManager` pins **pnpm 10.34.4**; get it with `corepack enable`, not
`npm i -g pnpm`. An `npm install` writes a `package-lock.json` that fights
`pnpm-lock.yaml`. `.npmrc` sets `node-linker=hoisted` deliberately — Metro, the
Expo config-plugin toolchain and the jest `setupFiles`/`resolver` entries all
walk a flat `node_modules`. Leave it alone.

### 3. `@openmarket/rooms-client` is private — install with the token npmrc

`pnpm install` 404s on its own. The token that can read the `@openmarket` scope
lives in **`openmarket-chat/.npmrc`** (repo-local, on the web lane); reuse the
file in place rather than copying the secret:

    npm_config_userconfig=/Users/nicholas/Documents/GitlabRepos/openmarket-chat/.npmrc \
      pnpm install --frozen-lockfile

Verify **from the app root**: `node -e "console.log(require('@openmarket/rooms-client/package.json').version)"` → the version `package.json` pins (0.92.0 at `c07f8cb`).

The onboarding doc's §2.1 hand-copy from the monorepo is **obsolete** — that was
for 0.90.0 before it was published. Ignore it. (The doc's "openmarket-main"
monorepo is `openmarket-internal`.)

### 4. iOS: the simulator runs, and it belongs to mobile-scout at night

*Updated 2026-09-21 — the "no Xcode" note that stood here is stale.* Xcode is
installed and OpenFloor (`sh.openmarket.openfloor`, dev client) is on the iPhone
17 Pro simulator `2BAC3CD5-…`, signed in as Nicholas, same account rule as §0.
Maestro 2.10.0 drives it headlessly (`~/.local/bin/maestro`). CommandLineTools
are still outdated, so `brew install` of anything needing them refuses.

The nightly `mobile-scout` routine (00:00–08:00 Mon–Sat; **disabled since 2026-09-21**) would own the simulator and
its own Metro on **:8090** from a checkout at
`~/.local/share/mobile-scout/openmarket-chat-app`. Do not re-point the dev
client or stop that Metro during those hours. Android remains the owners'
verification surface.

### 5. Native config changes need a rebuild, not a reload

Anything under `plugins/`, `modules/`, `targets/` or `app.json` is native
config: Metro cannot reload it and `android/` is **generated by prebuild and
gitignored** (`.gitignore:48`). A change made in `android/app/src/main/AndroidManifest.xml`
survives nothing. Edit `app.json`, then `pnpm exec expo run:android` again
(~23 min the first time, seconds after).

### 6. A dark error toast in a dev build is usually LogBox, not the app

React Native draws `LogBox` notifications — a dark box with a red icon — over
whatever screen is showing, and they **persist across navigation until
dismissed**. The screen a warning appears over is therefore not evidence of
where it came from: on 2026-09-18 an undismissed notification left by the
previous night's signed-out session was read as an error on the signed-in Chats
screen (T257). Check Metro's log for the occurrence and its position before
attributing it to a surface, and remember LogBox is `__DEV__` only — it is
stripped from a release build, so it proves nothing about what a user sees.

## 2. Android, end to end

    export JAVA_HOME=/opt/homebrew/opt/openjdk@17
    export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
    export ANDROID_SDK_ROOT="$ANDROID_HOME"
    export PATH="$JAVA_HOME/bin:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"

AVD `openfloor_pixel7` already exists (android-36, `google_apis`, `arm64-v8a`,
GPU `host`, 4 GB RAM, hardware keyboard on). Boot, build, install:

    emulator -avd openfloor_pixel7 -no-boot-anim &
    adb wait-for-device
    pnpm exec expo run:android            # 22m43s cold; incremental after

Metro for later runs, and the dev client is **not** Expo Go:

    pnpm exec expo start --dev-client --port 8081
    adb reverse tcp:8081 tcp:8081
    adb shell am start -W -a android.intent.action.VIEW \
      -d "exp+openfloor://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" com.openmarket.chat

First launch shows the dev-client's own "developer menu" notice — tap
**Continue**, then press back once to leave the dev menu. That is dev tooling,
not the app, and dismissing it is not an app write.

Driving and observing:

    adb exec-out screencap -p > shot.png
    adb exec-out uiautomator dump /dev/tty      # labels and bounds

Identifiers: Android package `com.openmarket.chat`, iOS bundle
`sh.openmarket.openfloor`, scheme `openfloor://` (Android also filters `om://`).
They deliberately do not match.

### `glab` flags that waste a cycle

- **Image uploads need `--form`, not `--field`.** `glab api projects/<enc>/uploads --field file=@shot.png` returns **400**; `--form file=@shot.png` works and returns the `markdown` to paste.
- **`glab mr create` has no `--no-squash-before-merge`.** Do not reach for it.

### A screenshot can show you the wrong screen

**After the back-stack is disturbed, `adb exec-out screencap` AND `uiautomator dump`
both return the frozen PREVIOUS layer**, not the screen you just opened — found by
T249/T250 (2026-09-18), which lost two capture attempts to it.

This is the worst class of tooling bug for this pipeline, because it does not fail:
it hands you a confident, well-formed artifact of the wrong thing, and a before/after
pair built from it will look perfect and prove nothing. `am force-stop` clears it.

So: after any navigation that goes backwards, assert the capture shows what you
think it does — check for a label only the new screen has — before you treat it as
evidence.

## Emulator state that survives your task

The emulator is shared, and two kinds of state outlive the owner that set them.
Check both before you measure anything that depends on them, or you will measure
the previous task's setup and call it your result.

- **App-link verification approvals.** F93 (2026-09-18) approved `openmarket.xyz`
  by hand with `pm set-app-links-user-selection`. That **overrides** Android's
  verification rather than satisfying it, so a deep link may open the app on this
  device while being genuinely broken for every real user. Clear it, or state in
  your write-up that your proof rides an override:

      adb shell pm set-app-links-user-selection --user 0 --package com.openmarket.chat false openmarket.xyz

- **Which build is installed.** F93 left its fix build on the device. `am start`
  reaching `MainActivity` proves nothing about `main`.

  **And the reverse bit you: as of 2026-09-21 the installed APK has NO `https`
  intent filter** — `adb shell dumpsys package com.openmarket.chat` lists only
  `om`, `openfloor`, `exp+openfloor` (F131; capture at
  `kanban/evidence/F131/verify-ac10/pkgdump-no-https-filter.txt`). A later owner
  reinstalled from a `main`-based branch and F93's `app.json` registration went
  with it, so `pm set-app-links-user-selection` is now a **no-op**: an override
  picks among apps that declare the host and none does. **Check the filter
  before you plan an https device arm**, and if it is absent, either accept
  explicit delivery —
  `am start -n com.openmarket.chat/.MainActivity -a android.intent.action.VIEW -d "<url>"`,
  which proves the app's routing but not the OS's — or rebuild from a branch
  carrying F93. Do not read a missing filter as F119: F119 is a filter that
  fails verification, this is no filter at all.

## 3. Gates

    pnpm run lint          # 0 errors, ~7 warnings on main (Node 22)
    pnpm run typecheck     # clean on main
    pnpm test              # 346 suites
    pnpm run export:smoke  # builds a WEB target

**Baseline red on `main` at `c07f8cb`, measured 2026-09-18 — diff the failure
set, never expect green:** `src/rooms/__tests__/room-screen.test.tsx` fails one
test, *"refuses past the cap locally, naming it, without a round trip"*, timing
out at 5 s in 3 of 3 runs on an otherwise idle machine. Everything else passes
(6006/6007). It has its own to-do; do not adopt it and do not report it as
yours.

`export:smoke` is a **build diagnostic only**. The web target deliberately has no
durable credential, no Rooms and no push — a surface is never "verified" from it.
`pnpm test` can also print "Jest did not exit one second after…" and exit
non-zero while every suite passes; judge by the pass line.

## 4. Worktrees

Same rules as the other lanes: work in a sibling worktree, never in the shared
checkout, never `git stash` under `GitlabRepos`, never `git add -A` where
`node_modules` is a symlink. A fresh worktree needs its own install — with the
token `npm_config_userconfig` from §3 above, or it 404s.

Commit as `Nicholas Wong <nicholaswong@trontalgroup.com>`.

## 5. Feature Map

The mobile map is its own tree: `Obisidian/openmarket-mobile/Feature Map/`,
reached as `references/features-mobile` (symlink), 128 entries written
2026-09-18 from `c07f8cb`. `kanban.ts` resolves it from `product: mobile`, so a
mobile task is gated against it and **not** against the chat map. The entries are
**source-read**, not device-driven (the app was signed out), and they say so —
treat an entry as a strong lead, not as an observation, and correct it when you
drive the surface for real.

`docs/WEB_PARITY_CHECKLIST.md` and `docs/WEB_PARITY_GAPS.md` in the repo are
**stale in both directions** — re-verified 2026-09-18: of 42 rows marked open or
partial, 25 have shipped, and several rows ticked done are not (per-run doc
revert, read-only doc control, the manage files browser, jump-to-message in DMs,
avatar constraints, quick-switcher prefixes; `§8 DMs and social ✅` at `:534` is
the loudest wrong one). Verify against `src/`, cite `file:line`, and fix the doc
row as part of the task rather than leaving the next owner the same trap.

## Not every write on this account is `nalo`-scoped

The standing authorisation is writes **inside the `nalo` server only**. That
boundary is a *room* boundary, and some of this app's writes are not room-scoped
at all — they are account-global preferences that sync to every device Nicholas
is signed in on.

The worked example is the desk (pinned shelf). Its wire key is `om:chat:desk`
(web's constant is `om.chat.desk`; the dot becomes a colon at push), and it
lives in the account's synced preferences — `openmarket-chat/packages/chat-ui/src/lib/desk.ts:33-60`.
**Pinning a room from the emulator changes Nicholas's desktop rail.** No server
is involved, so "I only touched `nalo`" is not true of it, and the `nalo`
authorisation does not cover it.

Before walking any feature, ask where its state is written, not which room you
are standing in. Room messages, topics and membership are room-scoped. Anything
reached through the preferences sync — desk, appearance, notification settings
— is account-global and needs its own authorisation. Reciprocal hazard worth
knowing: web's `snapshot()` ships only `SYNCED_KEYS` (`prefs.ts:927-938`), so a
key invented on mobile is deleted on web's next push.

## Reaching a control without a swipe burst

A long swipe burst to bring a control on screen is how this emulator's system
process gets into an ANR. F96 lost two attempts to a 25-swipe run at a doc's
"Copy link".

Prefer a layout that puts the thing one tap away. The Library's **Property
table** toggle is the worked example: `FolderTable` rows carry
`testID={`folder-row-${doc.docId}`}` (`src/rooms/library/folder-table.tsx:35`),
so a `uiautomator dump` reads the docId straight off the row with no scrolling
at all. Look for an alternate view before you script a scroll.

## One emulator, one app install: concurrent owners measure each other's code

The emulator holds **one install** of `com.openmarket.chat`, and `expo run:android`
re-points the dev client at **`:8081` regardless of the Metro port you started**.
So with two owners on the emulator at once, the APK and the JS bundle can come
from **two different branches simultaneously**, with nothing on screen saying so.

Proved 2026-09-19 (F113), at the cost of a full verification round: the verifier
measured F113's native half against another owner's JS, and the owner measured
the mirror image. Neither arm was what either of them thought they were testing,
and both looked normal.

This is a **measurement-integrity** failure, not an inconvenience — it produces
confident numbers about a build that never existed. It cannot be fixed by being
careful with ports, because the re-point ignores them.

**How to apply:** treat the emulator as a **single-owner resource**. The
coordinator dispatches at most one emulator-using owner at a time; a second one
queues even when the load gate is green, because the gate measures CPU and this
is a mutual-exclusion problem. Before trusting any device measurement, confirm
the running JS bundle's branch, not just the APK's — and if another owner's
Metro is on `:8081`, yours is not the bundle on screen.

## A coordinate error can open a real DM

The emulator is signed into Nicholas's real account, and a tap computed from a
stale or mis-measured screenshot lands wherever it lands. F113's verifier opened
his real `ryan` DM this way and backed out; that very likely fired a **read
receipt**, which is visible to the other person and cannot be withdrawn.

Reads are not free on this account. Before any tap sequence near the Chats
inbox, re-dump the layout rather than reusing an earlier capture (see "A
screenshot can show you the wrong screen"), and prefer a `testID` lookup to a
coordinate whenever one exists. If you do land somewhere you should not be, back
out and **disclose it** — F113's verifier did, which is the only reason it is
written down here.
