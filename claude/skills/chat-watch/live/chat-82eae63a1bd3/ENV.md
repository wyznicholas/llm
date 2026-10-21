# openmarket-chat env recipe (Linux box, user nicholas)

Verified 2026-10-20 on `908855a1`. The scripts live beside this file:
`gui.sh` (daemon start/stop/screenshot), `shot.mjs` (Playwright), `tui.sh` and `tui_render.py`
(om TUI in tmux, then PNG). Unmodified-main test results: `baseline.md`.

```bash
CTW=~/.claude/chat-todo-watch
```

## 0. One-time setup (already done; repeat only if something is wiped)

- **Deps.** The `~/.npmrc` registry token can read every private package
  (`@openmarket/rooms-client`, `@orangecharts/orange-v2-pb-common`, `@bufbuild/protobuf`).
  So a plain `bun install --frozen-lockfile` installs the full workspace, cloud included.
  No `.env`, no link and no stubs are needed. Use `/usr/local/bin/bun` (1.3.14, which
  matches `.bun-version`). Never modify that binary.
- **rooms-client.** Main uses the published `@openmarket/rooms-client@0.103.0` from npm.
  Its `dist/` is already built, so tsc is clean. `~/repos/openmarket/packages/rooms-client/dist`
  is also built, but only for `bun run rooms-client:link`. Link a worktree only when a fix
  needs unpublished rooms-client changes. Linking makes tsc read that package's `dist/`, so
  rebuild it after every change there (`bun run build` in that package with Bun 1.4.3).
- **Browser.** Playwright's chromium-headless-shell-1228 is in `~/.cache/ms-playwright`.
  It was installed by `node_modules/.bin/playwright install chromium`.
- **Dev identity template.** `~/.openmarket-chatdev` (mode 700) is a copy of the signed-in
  `~/.openmarket` (@nicholas_trontal). It has `agent.librarian.never=on` and
  `agent.library_mirror=off`, so test daemons do not run the room librarian or two-way
  file sync. `gui.sh` clones it per port into `~/.openmarket-chatdev-<port>`.

## 1. Make a worktree usable

```bash
cd ~/repos/openmarket-chat && git fetch origin
git worktree add -b fix/<topic> ~/repos/openmarket-chat-<topic> origin/main
cd ~/repos/openmarket-chat-<topic>
bun install --frozen-lockfile        # ~0.2-4 s: hardlinks from ~/.bun/install/cache, ~no disk
umask 022                            # REQUIRED before tests (see traps)
```

Use a real per-worktree install, not a symlinked `node_modules`. Bun 1.3.14 uses the
isolated linker, and `node_modules/@openmarket/chat-ui` is a relative symlink to
`../../packages/chat-ui`. A symlinked overlay would therefore silently resolve chat-ui to
the MAIN checkout's source. The per-worktree install is a real directory, git-ignored and
hardlinked. Check it with `readlink -f node_modules/@openmarket/chat-ui`, which must print
the worktree's path. Stage explicit paths only (never `git add -A`). Never `git stash`.

## 2. Gates (run from the worktree root)

```bash
umask 022
bun run typecheck                                  # tsc --noEmit, ~25 s; clean on main
bun run --cwd apps/cloud typecheck                 # cloud tsc, ~25 s; clean on main
bun run lint                                       # biome; main = 0 errors, 262 warnings
bun run build                                      # ~3 s -> dist/ (rooms.js/rooms.css/index.html)
bun --tsconfig-override ./tsconfig.json tools/check-dist.ts
bun run test                                       # all 4 lanes, 14 shards, ~2 min; main = 0 fail
bun run test:shared | test:rooms | test:cloud | test:desktop   # one lane
bun test --isolate --tsconfig-override ./tsconfig.json ./packages/chat-ui/test/<x>.test.ts   # one file
# cloud-lane tests: --tsconfig-override ./apps/cloud/tsconfig.json; bun run build:cloud first
```

Known flakes under full-suite load (they pass solo): `mermaid-svg-cache.test.ts` and
`doc/editor.test.ts` "syntax marks hide…". Details are in `baseline.md`.

## 3. Start the real GUI for a worktree (signed in, real data)

```bash
cd ~/repos/openmarket-chat-<topic> && bun run build      # the daemon serves dist/, not vite
$CTW/gui.sh start ~/repos/openmarket-chat-<topic> 31471  # pick a free port in 31470-31479
# -> up: http://127.0.0.1:31471/rooms/#/82eae63a1bd3  pid=…  log=$CTW/run/daemon-31471.log
$CTW/gui.sh status
```

What it runs: a SOURCE om daemon from `~/repos/openmarket` with Bun 1.4.3, started as
`bun packages/cli/src/bootstrap.ts run`. Its environment is
`OM_HOME=~/.openmarket-chatdev-<port> OM_BIND=127.0.0.1:<port> OM_ROOMS_GUI_DIR=<wt>/dist`,
and it runs detached with `setsid nohup`. To point it at a monorepo worktree instead, set
`OM_REPO=~/repos/openmarket-<x>` (run `bun install` and the dashboard stubs there first, as
in section 5). A source daemon re-reads a rebuilt `dist/`, so after `bun run build` just
reload; no restart is needed (verified). Ports 31470 and 31471 both run at once (verified),
and each port has its own OM_HOME. Never start two daemons on one OM_HOME.

## 4. Screenshot a room at desktop and mobile width

```bash
$CTW/gui.sh shot <port> <out-prefix> ['#/<roomId>'] [wait-ms]
# default room '#/82eae63a1bd3' (#chat), default wait 6000 ms
# -> <out>-desktop.png (1440x900) and <out>-mobile.png (390x844, iPhone 13 UA/touch, DPR 2), dark
$CTW/gui.sh shot 31471 /tmp/after-chat
$CTW/gui.sh shot 31471 /tmp/after-dm '#/dm/<username>' 8000
```

Other routes use the app's hash routes (`src/lib/routing.ts`): `#/<roomId>`,
`#/<roomId>/topic/<id>`, `#/dm/<user>`, `#/home`, and `#kitchen-sink`. For interactions
(clicks, menus, typing), copy `shot.mjs` and add Playwright steps before
`page.screenshot`. Or drive the same URL with the Playwright MCP tools.

**Before shots = the same recipe on the merge-base build, in its own worktree and port:**

```bash
cd ~/repos/openmarket-chat-<topic>
BASE=$(git merge-base origin/main HEAD)
git -C ~/repos/openmarket-chat worktree add --detach ~/repos/openmarket-chat-<topic>-base $BASE
cd ~/repos/openmarket-chat-<topic>-base && bun install --frozen-lockfile && bun run build
$CTW/gui.sh start ~/repos/openmarket-chat-<topic>-base 31472
$CTW/gui.sh shot 31472 /tmp/before-chat        # then the after: gui.sh shot 31471 /tmp/after-chat
$CTW/gui.sh stop 31472
git -C ~/repos/openmarket-chat worktree remove --force ~/repos/openmarket-chat-<topic>-base
```

Real data moves between the before and after shots (new messages arrive). For a stable
comparison, take both within a minute, or scroll or route to the same message.

## 5. Capture the om TUI (bugs here are fixed in the openmarket monorepo, not openmarket-chat)

```bash
git -C ~/repos/openmarket worktree add -b fix/<topic> ~/repos/openmarket-<topic> origin/main
cd ~/repos/openmarket-<topic> && PATH=~/.local/opt/bun-1.4.3:$PATH bun install --frozen-lockfile   # <1 s
$CTW/gui.sh start ~/repos/openmarket-chat 31470     # optional: gives the TUI "om running" and creates the slot home
$CTW/tui.sh start ~/repos/openmarket-<topic> 31470 [cols=160] [rows=48]
$CTW/tui.sh keys 31470 '/watches' Enter             # any tmux send-keys args: C-c, Escape, BTab…
sleep 2; $CTW/tui.sh shot 31470 /tmp/after-tui      # -> /tmp/after-tui.txt, .ansi, .png
$CTW/tui.sh stop 31470
```

`tui.sh` runs `bun packages/cli/src/bootstrap.ts chat` from the given monorepo worktree. It
runs inside tmux socket `omtui-<port>` with OM_HOME `~/.openmarket-chatdev-<port>`. It sets
`OPENMARKET_LLM_PROVIDER=openai-compatible OPENMARKET_LLM_BASE_URL=http://127.0.0.1:9/v1`, a
keyless dummy that satisfies the "needs an LLM" gate, so the terminal opens instead of the
`om init` walk. Agent turns that call a model fail. The PNG is `capture-pane -e`, rendered
through `rich` to HTML and screenshotted by Playwright. For the before shot, run the same
steps on a merge-base worktree of the monorepo. This build's TUI is the agent terminal: it
has no rooms pane, and rooms live in the web GUI.

## 6. Stop everything

```bash
$CTW/gui.sh status
$CTW/gui.sh stop <port>            # per daemon; or by hand: kill $(cat $CTW/run/daemon-<port>.pid)
$CTW/tui.sh stop <port>
ss -ltnp | grep -E ':314[0-9]{2}'  # nothing of ours should remain
```

## Traps hit

1. **umask 0002 breaks 14 desktop tests.** Temp files come out group-writable, and
   `desktop/src/internal-*.ts` rejects them. Always run `umask 022` before tests.
2. **`Internal error: directory mismatch … tsconfig.json`** after every
   `--tsconfig-override` run is Bun 1.3.14 noise. It is not a failure.
3. **Symlinked node_modules resolves chat-ui to main.** Use the per-worktree
   `bun install` instead (section 1).
4. **Bun versions.** openmarket-chat uses 1.3.14 (`/usr/local/bin/bun`). The monorepo, the
   daemon and the TUI need 1.4.3 (`~/.local/opt/bun-1.4.3/bun`), so put it first in PATH
   there.
5. **A fresh monorepo worktree has no `apps/dashboard/dist`.** The CLI then dies with
   "Cannot find module …/app.css". Fix it with
   `bun run scripts/ensure-dashboard-dist.ts`; `tui.sh` does this automatically.
6. **The test daemon is your REAL account.** Anything clicked or sent in the GUI or TUI
   posts as @nicholas_trontal in real rooms. Screenshot only: do not send messages, react,
   or create topics or alerts. The daemon also does background work for the account:
   persona-learn (idle, since there is no LLM), 4 copied watches (0 armed), and the
   credential keeper. The librarian and library mirror are switched off in the template.
   Do not set `OM_LIBRARY_DIR`, because that turns two-way library sync on.
7. **Cloned credentials.** Each slot home holds a copy of the same device key (expires
   2026-11-19). If a daemon renews or rotates it, `~/.openmarket` (the `om` CLI) or other
   slots can go stale. If the GUI shows a sign-in panel, recopy:
   `rm -rf ~/.openmarket-chatdev-<port>` and run `gui.sh start` again (it re-clones from
   the template). If the template is stale, re-create it by copying `~/.openmarket`, then
   rerun `om config set agent.librarian.never on` and
   `om config set agent.library_mirror off` with `OM_HOME` set.
8. **Ports.** 31337 is the om default, 31417 belongs to the Mac rig, and 8097 belongs to the
   developer's `bun run dev`. gui.sh refuses all three; use 31470-31479. Each daemon also
   opens a desktop TLS listener on a random high port, which is harmless.
9. **`gui.sh shot` argument order** is `<port> <out> ['#/room'] [wait-ms]`. A bare number in
   the third slot is refused, because it once became the URL path.
10. **The PID from `$!` under `setsid` is not the daemon.** gui.sh records the PID that owns
    the port (`ss -ltnp`), not `$!`.
11. **`~/repos/openmarket` itself** is 3 commits behind origin. It carries untracked rsync
    leftovers from the Mac (`packages/*/<name>/` dirs, `pnpm-lock.yaml`) and stale Mac
    worktrees marked "prunable" in `git worktree list`. Leave them alone; branch fix
    worktrees from `origin/main`.
