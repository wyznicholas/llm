# kiyotaka-frontend-app (product `mobile-charts`): working recipe

*Written 2026-10-02 from T320 (iOS, jest) and T321/T322 (Android, source-scrape). Append what you learn. Not OpenFloor: no redesign rules, no mockup, no !101.*

Repo `~/Documents/GitlabRepos/kiyotaka-frontend-app`, origin `gitlab.com/openmarketxyz/frontend/kiyotaka-frontend-app`, default branch `main` (the shared checkout sits on `production`; never touch it). Expo / React Native app "OpenMarket", bundle `com.kiyotaka.frontendapp`, URL scheme `kiyotaka`. Read its `AGENTS.md` first: G2 (navigate through `@/navigation/nav`), G3 (do not delete the flag-off React screens), G6 (shared control = three files), the Swift-vs-`expo-router` rules. Train surface key `mobile-charts` (MR !8, merge method `merge`, not ff).

## Two renderers, one data layer. Check the screenshot first.
- **Android** draws the symbol dialog, chat lists and most sheets in **Kotlin Compose** (`modules/nav-shell/android/.../ui/*.kt`), fed by React models (`src/shell/*-model.tsx`, `sheet-form.ts`).
- **iOS** draws them in **Swift/declarative forms** (`src/shell/forms/`, `src/features/chart/components/*.ios.tsx`, hook `use-symbol-search.ts`).
- Shared data (`src/features/chart/data/*`: `markets.ts`, `all-category-preview.ts`, `polymarket-markets.ts`, `coin-icons.ts`) feeds both. A QA report with a Samsung status bar and 3-button nav bar is Android; an iOS simulator cannot show an Android layout bug, but it CAN show a data-layer bug.
- **Android runtime: it works (T321, 2026-10-02), but slowly; it is NOT "no runtime".** Android package is `xyz.openmarket.app` (iOS is `com.kiyotaka.frontendapp`), scheme `exp+kiyotaka-frontend-app`, dev-client build. Recipe, from a worktree off `origin/main` with `node_modules` cloned or symlinked, no install needed:

      export PATH="/opt/homebrew/opt/node@22/bin:$PATH" JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
      export ANDROID_SDK_ROOT=$ANDROID_HOME PATH=$JAVA_HOME/bin:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH
      CI=1 npx expo prebuild --platform android --no-install        # ~1 min; writes gitignored android/, leaves package.json alone
      cd android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a --console=plain --max-workers=3
      #   -> android/app/build/outputs/apk/debug/app-debug.apk (114 MB)

  Timings: **cold build 46m58s** (765 tasks, at host load 200-900 from other sessions' Docker work; most of it was RN's arm64 C++ and `configureCMakeDebug`, a long silent stretch with a harmless `CXX5304` warning, not a hang); **incremental after a Kotlin-only change 2m17s** (40 tasks), so build the base arm first, then `git checkout <ref> -- <the .kt file>` and rebuild for the fix arm. Copy each APK out as you go. `JAVA_HOME` is required; the gradle daemon (`~/.gradle/daemon/9.3.1`) outlives the build, so record and kill its PID (never `./gradlew --stop`, it stops every owner's daemon of that version).
  AVD `openfloor_pixel7` (Pixel 7, android-36, 1080x2400, 420 dpi) **does boot** with `emulator -avd openfloor_pixel7 -no-window -no-boot-anim -no-snapshot-save`: it loaded `default_boot` in ~14 s, `sys.boot_completed` after about a minute, then `service list` has no `activity` for another minute or two. Under host load the guest throws "Pixel Launcher / System UI / Process system isn't responding" dialogs; `adb shell settings put global hide_error_dialogs 1` (reset to 0 after) or tapping Wait clears them. `adb install -r` of the 114 MB APK took several minutes under that load.
  Run: `env -u CI npx expo start --dev-client --port <refport> --clear` (the first bundle took 265 s, 5933 modules, at load 400), `adb reverse tcp:<refport> tcp:<refport>`, then `adb shell am start -W -a android.intent.action.VIEW -d "exp+kiyotaka-frontend-app://expo-development-client/?url=http%3A%2F%2Flocalhost%3A<refport>" xyz.openmarket.app`. First launch shows the dev-menu notice: tap Continue, then back once. Metro's real PID is the `node` listener (`lsof -iTCP:<port>`), not the shell's `$!`; two processes carry the worktree cwd, kill both. Stop with `adb emu kill`.
  **Signed-out data door (scratch, never committed):** Chat and Terminal are guest-gated. Two edits in the worktree let a guest into Chat with rows: `GUEST_GATED_TABS = {}` in `src/features/gating/tab-gating.ts`, and a fixture array replacing the `dmConversations` memo in `src/shell/chat-model.tsx` (T321's is `kanban/evidence/T321/scratch-fixture.patch`). They are JS, so Metro serves them to every APK and the base/fix arms stay identical. Tab bar y~2256 (x: Home 108, Chat 324, Chart 540, Terminal 756, Menu 972); Private chip (880, 342). Screenshots: `adb exec-out screencap -p > x.png`.
  Limits: the lock says one owner for the emulator; the AVD has hung on boot for other owners (QEMU main loop), it did not here. Rebuild only when a native (Kotlin/Swift) file changes.

## Linux emulator box (x86_64), since 2026-10-13
A third Android host: `ubuntu@192.168.100.237` (Ryzen 5950X, 125 GB), driven with
`~/.claude/om-bug-loop/scratch/remote-emu.sh linux …` (serial `127.0.0.1:6557`, turn lock `linuxEmu`).
Its emulator is **x86_64**, so the usual `-PreactNativeArchitectures=arm64-v8a` APK **crashes on launch**
there (`SoLoaderDSONotFoundError: libreactnative.so`), although the image advertises ARM translation.
Keep arm64-only for the mini (faster builds; iOS needs no Android ABI at all). For the Linux box, build a
separate x86_64 APK in the mini's dedicated tree `~/repos/kfa-linux-x86` (detached; never another agent's tree):

    cd ~/repos/kfa-linux-x86/android && source ~/.mobile-env
    ./gradlew :app:assembleDebug -PreactNativeArchitectures=x86_64 --max-workers=4 --no-daemon

then `scp` the APK here and `remote-emu.sh linux install <apk>`. Re-run `expo prebuild` and re-sync
`node_modules` only when `main` changes native deps, as for any mini tree.

## Install (never run an install)
`package.json` and `patches/` on `main` match the shared checkout, so **APFS-clone its `node_modules`**:

    cp -cR ~/Documents/GitlabRepos/kiyotaka-frontend-app/node_modules <worktree>/node_modules   # ~20 s, ~0 disk
    touch <worktree>/node_modules/.metadata_never_index

(A `node_modules` symlink to the shared one also works for jest, but remove the symlink before `git worktree remove`, and Metro prefers the real directory.) Package manager is npm (`package-lock.json`); an install writes a lockfile and can clobber the shared tree, so do not. Postinstall is `patch-package`.

## Tests
`jest` (jest-expo), not bun. Node 22 first on PATH. **`--watchman=false`** (watchman is blocked in the sandbox).

    export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
    cd <worktree> && npx jest --watchman=false <file1> <file2> ...

- Files are separate arguments. `train.ts ship` wants `--test-cmd "npx jest --watchman=false <files…>"` and NO `--test-list` for jest; the log must show jest's `Tests:` / `Test Suites:` summary.
- `jest.mock` factories may only reference variables named `mock*`. `react-test-renderer` is installed; there is no `@testing-library/react-native`. Several tests scrape the Kotlin/Swift source instead (`src/shell/__tests__/more-sheet-rows.test.ts` is the model). `src/features/chart/data/__tests__/cme-flag.test.ts` is a good model for mocking the gateway lanes.
- A project-wide `tsc` is heavy; diff its error set for the touched files only. Lint: `npx eslint <files>`.

## iOS simulator (pool devices only; see openfloor-mobile-env.md "simulators")
1. Claim `simPool.holders.<udid>` in `~/.claude/om-bug-loop/locks/emulator.lock` (temp file + rename). Never create, clone or erase a device.
2. Copy the prebuilt app, never build: `cp -cR ~/Library/Developer/Xcode/DerivedData/om-main-dd/Build/Products/Debug-iphonesimulator/OpenMarket.app <scratch>/` then `xcrun simctl install <udid> <scratch>/OpenMarket.app`. No Xcode build unless the fix is native.
3. Metro from your worktree on a ref port, **without `CI=1`** (CI mode disables reloads):

        cd <worktree> && EXPO_NO_TELEMETRY=1 nohup node node_modules/.bin/expo start --dev-client --port 8318 > <scratch>/metro.log 2>&1 < /dev/null & echo $! > <scratch>/metro.pid

   Kill only that PID (confirm with `lsof -p <pid> | grep cwd`).
4. **Warm the bundle before launching.** A cold bundle took 38 s on an idle machine and **4 min at load 250+**, and the dev launcher gives up first ("Failed to load app"), so request it yourself once with `curl -m 1500 "http://localhost:8318/index.bundle?platform=ios&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.bytecode=1&transform.routerRoot=app&unstable_transformProfile=hermes-stable" -o /dev/null`, then launch. Editing a source file mid-session reloads JS; a native sheet left open across a JS reload is **orphaned and frozen**: terminate the app and relaunch.
5. Launch: `xcrun simctl launch <udid> com.kiyotaka.frontendapp`, then `xcrun simctl openurl <udid> "kiyotaka://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8318"` and tap the system "Open" dialog. Trust Metro's "iOS Bundled" line, not the screen (the launcher reconnects to the last server; entries for other owners' Metros are listed).
6. The app starts as a **guest** (`session.guest=1`): the chart, symbol sheet and search all work signed out. Never sign in (email code goes to Nicholas).
7. **Drive with maestro** (`~/.local/bin/maestro --device <udid> test flow.yaml`, `appId: com.kiyotaka.frontendapp`). Native SwiftUI placeholders are NOT in the accessibility tree, so tap by **percentage point**: `tapOn: {point: "20%,9%"}` (chart header symbol button → opens the markets sheet), `"40%,92%"` (sheet search field), then `inputText`. Bottom tabs are tappable by label ("Chart"). Dev-menu intro: tap "Continue", then X at `90%,50%`. Each maestro call takes 1–5 min at high load; run it in the background and poll its log. Screenshot with `xcrun simctl io <udid> screenshot <png>`.
8. Release: leave the device **booted**, stop your Metro by PID, remove your holder entry, tell the coordinator.

## Traps
- **Machine load.** Other owners' simulators put the load average at 250–760 on 2026-10-02; every step is slow. Do not queue interactive steps; background them and poll.
- **Compose `Row` trap (T321):** `weight(1f, fill = false)` next to `Spacer(Modifier.weight(1f))` leaves the unused share with the spacer, so the item after them floats at a content-dependent x. It also exists at `ui/ChatSheets.kt:862-864`.
- **QA builds can be older than `main`.** Check git history before debugging an Android report (`79c1681d`, 2026-09-23, already fixed the watchlist inline-create race).
- **The core market transform drops POLYMARKET venues** (`markets.ts` `transformMarketAssetsImpl`, "handled elsewhere"); events come only from `fetchPolymarketMarkets`. Hyperliquid is not filtered (only `HYPERLIQUID_HIP4` is).
- **Equity icons:** the Polygon CDN `…/polygon/<ticker>.jpg` 403s for every fund (SOXL, SPY, QQQ); only single stocks (MU, NVDA) resolve. Web puts the gateway `iconUrl` first; mobile `symbolRowIcon` returns the CDN guess as a lone URL. See T318.
- **Frames from a QA recording:** no ffmpeg; `AVAssetImageGenerator` in a small Swift script (`swiftc`, then run); see T322 evidence.
- **Measuring a reporter's screenshot:** a 40 dp avatar gives the px/dp scale (65 px for 40 dp in seq103); do not assume a density.
- **Web is the reference implementation** for behaviour (`~/Documents/GitlabRepos/kiyotaka-frontend`, read-only; `git show origin/main:<path>`): Nicholas, 2026-10-02, "just follow them".

## `#web-port` cards: not om-bug-loop's

Since 2026-10-08 web-port-scout ports its own `#web-port` cards end to end
(`~/.claude/skills/web-port-scout/references/port-procedure.md`). om-bug-loop never
consumes or dispatches them. The `mobile-charts-web-port` train surface is unused.
