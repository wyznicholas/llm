# OpenMarket Chart — local environment

> **Lane: `product: chart`.** Fix repos: `kiyotaka-frontend` (the app; its
> package name is `kiyotaka-chart`) and `titan-charts` (the engine). The chat
> lane's `references/openmarket-chat-env.md` does not apply here — different
> package manager, different app, different gates.

## The traps, in the order they bite

### 1. `.env` is untracked, so a fresh worktree has none

`kiyotaka-frontend/.env` is gitignored (`.gitignore:35`) and not in git. A new
worktree therefore starts with **no `.env` at all** — vite boots with no
`VITE_PORT`, no API URLs and no CME token, and nothing errors. Copy it in
before anything else:

    cp ~/Documents/GitlabRepos/kiyotaka-frontend/.env "$WORKTREE/.env"

This is the chart lane's equivalent of the chat lane's "never `bun install`":
the single silent failure that costs half an hour if you do not know it.

### 2. `pnpm`, never `bun`

Different lockfile, different store. `pnpm install --frozen-lockfile`. If
`pnpm dev` exits immediately doing nothing, run `pnpm approve-builds` — an
unapproved build script blocks the dev server with no useful message.

### 3. The shared checkout is NOT on main

`~/Documents/GitlabRepos/kiyotaka-frontend` sits on a feature branch
(`nicholas/production-alerts-C1` as of 2026-09-09). It is therefore useless as
a base arm even read-only, and must never be edited or switched. Both arms come
from your own worktrees off `origin/main`.

### 4. Local charts render MOCK data by default

`.env` ships `VITE_CME_API_MODE=mock`. A local chart shows synthetic data while
the UI still says "Real-time" — there is no visual tell. So a **data** bug (a
price reading `$0`, a market missing) may be unreproducible locally until this
is flipped. If you cannot reproduce, say so and say why, rather than concluding
the bug is not real. `VITE_CME_REALTIME_ENABLED` is a separate switch: "enabled"
and "real" are two different things.

## Driving the app

`pnpm dev` runs vite on `VITE_PORT` (default 8080). **Namespace the port by task
ref** — `VITE_PORT=80NN` for `TNN` — and never kill a process on a port you did
not start. Two agents once killed each other's daemons on a shared port.

**Never kill by pattern** (`pkill`, `killall`, `pgrep | xargs kill`): every owner's
`pnpm dev` looks the same, and a verifier's `pkill -f "bootstrap.ts run"` took down
Nicholas's `:31417` daemon on 2026-09-15. Start the dev server as its own process
group, record that PID, and stop only that group. `pnpm` is a wrapper, so the
listener on the port is a child — check it belongs to your group before signalling
(this shape verified 2026-09-15 on macOS with a throwaway wrapper+listener pair):

    bash -c 'set -m; cd "$1" && VITE_PORT=$2 pnpm dev > "$3/vite-$2.log" 2>&1 & echo $! > "$3/vite-$2.pid"' _ "$WORKTREE" 8061 "$S"

    PORT=8061; PID=$(cat "$S/vite-$PORT.pid"); LIS=$(lsof -ti tcp:$PORT -sTCP:LISTEN)
    [ "$(ps -o pgid= -p "$PID" | tr -d ' ')" = "$PID" ] && [ "$(ps -o pgid= -p "$LIS" | tr -d ' ')" = "$PID" ] \
      && kill -TERM -- "-$PID" || echo "refusing: $PORT's listener is not in the group I started"

Both arms are your own: a base worktree at the merge-base and a fix worktree,
each with its own port. There is no shared long-lived instance to borrow, and
none of the chat lane's `arm-env.sh` / `clone_home` / `base_dist` machinery
applies. Report your build and boot cost as a number anyway — the chart lane has
no measured baseline yet, and that is how it gets one.

## Authenticated sessions — use the bootstrap, never log in by hand

The Terminal (and therefore the Watchlist) requires an account. A fresh
automated browser is always signed out, so **every** chart task that needs the
widget starts here:

```bash
node ~/.claude/skills/om-bug-loop/scripts/auth-bootstrap.mjs        # reuse or mint
node ~/.claude/skills/om-bug-loop/scripts/auth-bootstrap.mjs --check # status only
```

Then load the state into your own browser — do NOT re-mint per agent. From
2026-09-15 the driver is agent-browser (`references/browser-driving.md` §0), which
reads the same file:

```bash
export AGENT_BROWSER_SESSION=T<NN>-fix
agent-browser --state /tmp/<ref>-state.json open "http://localhost:80NN/chart/"
agent-browser set viewport 1920 1080
```

`--state` takes Playwright's `storageState` shape as-is. Measured on 2026-09-15 with a
synthetic state file: an `httpOnly` + `secure` + `sameSite: Strict` cookie reached a
`localhost` server, stayed invisible to `document.cookie`, and localStorage was restored.
It has **not** yet been run against the chart app itself, so the first chart task on
agent-browser must assert `guest: false` before trusting the session. Playwright, for a
measurement that stays on it:

```js
const ctx = await browser.newContext({
  storageState: `${process.env.HOME}/.claude/om-bug-loop/auth/storage-state.json`,
  viewport: { width: 1900, height: 1000 },
});
```

Why it is built this way, so nobody tries the shortcut again:

- Auth is **httpOnly cookies** (`orange-v2-backend`, `createCookie` in
  `src/utility/utils.ts` — httpOnly + secure + sameSite strict). Page
  JavaScript cannot read `accessToken`/`refreshToken`, so there is no token to
  copy out of `localStorage` and none can be handed to you. Capture has to
  happen at the browser layer, which is exactly what `storageState` is.
- **Cookies ignore ports.** One state file authenticates `:8080`, `:8081` and
  any other localhost dev server at once. The isolation boundary is the browser
  **profile**, not the port — which is why the human's Chrome stays logged in
  while yours is a guest.
- Guest mode does not merely gate the watchlist, it **does not render it at
  all** (zero watchlist nodes in the DOM). "I could not find the widget" almost
  always means "I am not signed in", not "the feature is flagged off".

Credentials live in `~/.claude/om-bug-loop/auth/credentials.env` (chmod 600),
read at runtime and never logged. If the script exits 2, that file is missing —
ask Nicholas to populate it; never work around it by typing a password.

## Three walls sit between a cold browser and the Watchlist

Each one, on its own, looks like the feature not existing. In order:

1. **"Best on Desktop" interstitial** — appears on clicking the terminal button.
   NOT width- or touch-driven (it shows at 1900px with a fine pointer). Dismiss
   with **Continue Anyway**.
2. **Authentication** — a Sign Up / Log In dialog. Handled by the bootstrap above.
3. **Email verification** — a further gate on some accounts, separate from
   being signed in. Affects persistence.

Also: the terminal button is **icon-only with no accessible name**, so semantic
locators and natural-language `find` miss it entirely. Use the class selector
`.tb-terminal`.

## Reaching the Watchlist widget — it is a PANEL, not a route

T63 burned its last mile here, so take the recipe rather than exploring:

1. Load **`/chart/<id>`** — an ordinary chart URL. The watchlist lives on that
   page; there is no `/workspace` route to find. Grepping `src/router/` for one
   is a dead end. The component is
   `src/components/workspace/WorkspaceLayoutContainer.vue`.
2. **Dismiss the onboarding modal first.** A "Kata is back." dialog opens over
   the centre-right of a fresh profile and swallows clicks aimed at the panel
   toggles behind it. A second toast can appear at the right edge.
3. **Run at ≥1800px wide.** At 1440×900 the top nav silently drops `API`, `CME`
   and `Streams`, and the right rail is easy to miss entirely. The reporter's own
   window is ~1800px.
4. Open the **Workspace** panel from the toggle row at the top right. The
   WATCHLIST widget is docked inside it, with the `+` button for adding symbols.

The trap is that the app looks fully working while you are locked out of one
widget, which reads as "feature-flagged off" and is not — T63 concluded exactly
that and was wrong.

## Email verification does NOT block the Terminal (re-corrected 2026-09-09, T63 round 3)

**Round 2's finding below was wrong and is superseded.** With a properly
signed-in session minted by `auth-bootstrap.mjs --out <path>`, clicking
`.tb-terminal` opens the Terminal straight onto the Workspace with the
**Watchlist docked and populated**; the page reports `guest: false` and
`unverified: false`. The *"Verify your email to unlock Terminal"* dialog round 2
hit was a symptom of the **signed-out** session it was driving, not a property
of the account or of the surface. Measured T63 round 3;
`~/.claude/om-bug-loop/evidence/T63/watchlist-full-widget-before.png`.

**Working recipe** (all measured, headless, 1920x1080):

1. `auth-bootstrap.mjs --out /tmp/<ref>-state.json --force` — **immediately**
   before driving. The exported state is effectively single-use: refresh tokens
   rotate on the app's boot `refresh-token` call, and a state ~7 minutes old
   loads as a guest. Never reuse one across runs.
2. `goto /chart/`, `domcontentloaded` + ~9 s fixed wait.
3. `[data-testid="mobile-entry-continue-btn"]` if present.
4. `.tb-terminal` (icon-only, class selector only).
5. Remove the **"Kata is back."** onboarding modal — it overlaps the watchlist
   and survives ordinary clicks; deleting the node is the reliable move.
6. Watchlist rows are `[data-testid="watchlist-row-<EXCHANGE>|<rawSymbol>-btn"]`.
   Add via `watchlist-add-symbol-btn` -> `symbol-selection-search-input` ->
   **`symbol-row-screener-checkbox-<KEY>`** -> `symbol-selection-apply-btn`.
   **Clicking `symbol-row-<KEY>-btn` does NOT select** — it navigates, and Apply
   then silently adds nothing.

### Superseded — round 2's text, kept only for the record

## ~~Email verification DOES block the Terminal~~ (round 2, WRONG)

The shell shows *"Email not verified — edits won't save"*. Chart reads and live
prices work regardless — but the **Terminal does not**. Clicking
`[data-testid="tb-terminal-toggle-btn"]` on an unverified account opens a
blocking dialog, *"Verify your email to unlock Terminal"*, with only a "Send me
a code" button. The Terminal is where `WorkspacePanel.vue:10` mounts
`WorkspaceLayoutContainer`, the **only desktop mount of `Watchlist.vue`** — so
the watchlist widget is unreachable on an unverified account, and step 4 of the
recipe above cannot complete. Measured T63 round 2, 2026-09-09;
`~/.claude/om-bug-loop/evidence/T63/terminal-email-gate-T63.png`.

The dev instance's session is unverified *and effectively signed out* — the
mobile layout (viewport 390x844, iPhone UA) renders "Sign in / Access your
account", and `mobile-nav-btn-Watchlist` exists but sits behind the primary tab
bar. So there are no saved watchlists to render either way.

**The way round it is not the UI.** Drive the app's own data path in-page
instead: `import('/chart/src/services/metadata.service.ts')` plus
`buildMarketsRequestFromSymbols` from `v2.service.ts` lets you issue the exact
`StreamMarkets` request a widget makes and read the response fields, against
production, with no account. Working probe:
`~/.claude/om-bug-loop/evidence/T63/repro-wire-probe.mjs`.

**Two dev servers from one worktree fight over `node_modules/.vite`** and both
break with `Failed to fetch dynamically imported module` on random chunks. If
`VITE_PORT` reports "Port NNNN is in use, trying another one", stop — reuse the
existing server rather than running a second.

## Gates

| gate | state on main | how to read it |
|---|---|---|
| `pnpm lint` | **clean** | trustworthy as pass/fail |
| `pnpm typecheck` | **red, ~1428 errors** | never a verdict. Grep the error list for the files you touched. `scripts/typecheck-ratchet.mjs` exists for this |
| `vitest run --config vitest.node.config.ts` | node lane, usable | scope it to what you changed |
| `*.browser.ts` lane | **cannot run out of the box** | needs `node_modules/.bin/playwright install chromium-headless-shell` once per machine; the failure looks like a broken config, not a missing download |
| `tests/locales/` (73 tests) | usable | run it whenever you touch any `src/locales/*.json` — it is the locale-parity gate |

`scripts/verify-locale-convention.mjs` is **not** runnable headless — it drives a
live dev server on `localhost:8097`.

**`regression-impact-check`** is a required skill run whenever `kiyotaka-frontend`
is touched; the plan template already asks for its output.

## Watchlist and user data live in the BACKENDS, not in this repo

`kiyotaka-frontend` renders a watchlist it does not own. The rows, and the
market identifiers on them, are persisted server-side across the user-data
backends — **`auth-service-backend`, `tharamine-user-service` and
`orange-v2-backend`** (Nicholas, 2026-09-09). All three are cloned under
`~/Documents/GitlabRepos/` and indexed in the global graphify graph, so reading
them costs almost nothing.

Read them on **every** chart task, and read them EARLY. The reason is that the
two failure modes are indistinguishable from inside the frontend: a row showing
`$0`, a blank column, or a symbol that never resolves looks exactly the same
whether the component failed to render a value it was given, or was handed a
row whose stored identifier no subscription can key off. You cannot tell those
apart from the render alone — you have to look at what was stored and what the
backend returned.

They are **read** repos, not fix repos: a defect proved to live in one is a
finding in your plan and a follow-up task, under the same second-repo rule as
`titan-charts` below.

## titan-charts is a separate task

The app consumes the engine as a **published package**,
`@orangecharts/titan-charts-next` (pinned at `0.0.4-alpha.861`; the local
checkout is behind, at `0.0.4-alpha.816`). One worktree cannot reach two repos,
so a root cause in the engine is written into your plan as a finding and
dispatched as its own task, with the pin bump as a third. Same shape as
`rooms-client` in the chat lane.

## Worktrees

Sibling worktrees work with `node_modules` symlinked to the main checkout, which
also shares vite's dep cache. The standing rules hold: never `git add -A` where
`node_modules` is a symlink, never `git stash` anywhere under GitlabRepos, never
edit or commit in the shared checkout.

## MEASURED — first pass, T63, 2026-09-09 @ `16bbe41e3`

Replaces the old UNVERIFIED list. Everything here was measured, not reasoned;
artifacts in `~/.claude/om-bug-loop/evidence/T63/`.

- **`pnpm install --frozen-lockfile` in a fresh worktree: works, exit 0, 17.3 s.**
  Just run it.
- **NEVER symlink `node_modules` from the shared checkout in this lane.** The
  chat lane's overlay trick breaks the chart lane twice over:
  1. `pnpm dev` refuses — `ERR_PNPM_UNSAFE_MODULES_DIR: Refusing to remove the
     modules directory ... because its resolved target is not a strict
     subdirectory of the project root`. pnpm 11 runs a deps-status check before
     `dev` and cannot reconcile a symlinked modules dir.
  2. Bypassing that and invoking vite directly still fails to boot:
     `Failed to resolve import "@msgpack/msgpack"`. `origin/main` declares
     `"@msgpack/msgpack": "3.1.3"` and the shared checkout's branch does not, so
     the shared `node_modules` is stale relative to main **by construction**.
  Related hazard: if the worktree's `node_modules` is *already* a symlink, an
  `ln -s ... "$WT/node_modules"` resolves **through** it and writes a stray
  `node_modules/node_modules` into the **shared checkout**. Check with
  `ls -ld "$WT/node_modules"` first. This happened on T63.
- **`pnpm dev` cold boot: vite ready in 997 ms**, HTTP 200 on
  `http://localhost:<port>/chart/` within 30 s of the command. The app serves
  under **`/chart/`** — a bare `/` 302s there.
- **`node node_modules/.bin/vite` does not work** — `.bin/vite` is a shell shim,
  not JS. Use `pnpm dev`, or execute the shim directly.
- **The app is NOT mock and NOT blocked on auth.** With the shared `.env` copied
  in, it boots to a live chart with a real session and **production** market data
  (`VITE_V2_WEB_SOCKET_DOMAIN=wss://api.chart.ore.openmarket.xyz/v2/`), e.g.
  BTCUSDT ticking at a real price. `VITE_CME_API_MODE=mock` gates **only** the
  CME entitlement lane; do not read it as "everything here is mock".
- **The user-data backend runs locally**: `VITE_BACKEND_DOMAIN` →
  `http://localhost:3000` → `tharamine-user-service`, `/api/v1/health` → 200.
- **Headless driving works** with the repo's own playwright
  (`node_modules/playwright`); chromium is already downloaded in
  `~/Library/Caches/ms-playwright`. Use `waitUntil: "domcontentloaded"` plus a
  fixed wait — the app holds sockets open, so `networkidle` will time out.
  **From 2026-09-15 drive with agent-browser instead** (one `--session T<NN>-base`
  / `T<NN>-fix` per `VITE_PORT`, never `wait --load networkidle`), and keep
  Playwright for exactly what `browser-driving.md` §0 lists: WS frame blocking,
  method-based write blocking, Escape, keystroke handling. Step 5 of the recipe
  above deletes a modal node rather than pressing Escape, which is what keeps it
  on agent-browser. The `*.browser.ts` gate lane in the Gates table above is the repo's
  own Playwright and is untouched by this.

### Still unverified

- Where the **Workspace / Watchlist** surface actually lives. T63 enumerated the
  shell (`Ecosystem`, `Academy`, `OpenMarket Plus`, chart toolbar, `Chat`) and
  found no entry point; `#/workspace` and `#/terminal` render nothing, and
  `/chart/workspace` bounces to `?redirect=/workspace`. It may be flagged, or
  gated on email verification (the shell shows *"Email not verified — edits
  won't save"*). **Grep `src/router/` rather than guessing hashes.**
- Which port the app settles on when `VITE_PORT` is already taken.
- Whether `pnpm lint` is still clean on the merge-base you measure.
- Whether a second worktree's first boot is materially faster from the dep cache.
