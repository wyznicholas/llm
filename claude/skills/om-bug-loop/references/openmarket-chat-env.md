# Preparing an openmarket-chat worktree (implementation agents read this first)
> **Lane: `product: chat`.** This file describes `openmarket-chat`, `rooms-client`
> and `kiyotaka-chat-service` only. A `product: chart` task reads
> `references/kiyotaka-chart-env.md` instead — bun, `:31417`, the `OM_HOME`
> clone and `arm-env.sh` are all chat-only and do not apply there.

Verified 2026-09-01 while preparing to-do 6658. Everything here is worktree-local:
nothing below ever writes into `~/Documents/GitlabRepos/openmarket-chat` itself.

## 1. Worktree

```bash
REPO=~/Documents/GitlabRepos/openmarket-chat
WT=~/Documents/GitlabRepos/wt/openmarket-chat-<slug>
git -C "$REPO" fetch origin main --quiet
git -C "$REPO" worktree add -b om-bug-loop/<slug> "$WT" origin/main
```

Sibling of the repo, never nested inside it (the test runner drags nested
worktrees into the suite). `main` is usually claimed by another worktree — always
branch from `origin/main`, never check out `main`.

## 2. node_modules — overlay, never install

**`bun install` cannot succeed on this Mac**: `@openmarket/*` and
`@orangecharts/*` resolve to a private registry the local token cannot reach.
An install also destroys the overlay. Build it with the helper instead:

```bash
. ~/.claude/skills/om-bug-loop/scripts/arm-env.sh
overlay_node_modules "$WT" "$(git -C "$WT" rev-parse HEAD)"
```

**Never mirror `node_modules` entry-by-entry by hand, and never symlink the whole
directory (updated 2026-09-15).** The old recipe here linked every top-level entry,
including the `@openmarket` scope directory, to the shared checkout. The shared
`@openmarket/chat-ui` is a workspace link, `../../packages/chat-ui`, so every
build and test in the worktree compiled **the shared checkout's working-tree
chat-ui, not the worktree's**. Your fix to `packages/chat-ui` was then absent
from your own bundle, and the base arm carried whatever the shared checkout had.
This was proven on T156 (`f6c9b8fa`) and T186 (`c1458c4b`).
`overlay_node_modules` reads the commit's workspaces from `package.json` and
`bun.lock`. It links each workspace package (today `@openmarket/chat-ui` and
`@openmarket/chat-cloud`) to the worktree's own directory. Private packages that
are not in the worktree (e.g. `@openmarket/rooms-client`) still come from the
shared install. Build caches (`.vite`, `.vite-temp`, `.cache`) stay local to the
worktree.

**Before you trust any bundle or test run from the worktree, prove it:**

```bash
# The content check compares against a COMMIT. A fix arm with uncommitted chat-ui edits
# reports those files as mismatches, so run it on the commit you built.
assert_arm_build "$WT" HEAD --json "$EVIDENCE/<task>/arm-assert-<arm>.json"   # exit 0 = PASS
```

It passes only if Vite's own resolver **and** Node's resolve `@openmarket/chat-ui`
inside the worktree, and every tracked file under `packages/chat-ui` at that
commit is byte-identical to the resolved copy. A `FAIL` voids that arm. The
asset stamp alone cannot catch this: the `om-build` meta names the worktree's
commit whatever chat-ui was bundled.

Confirm nothing is missing (never mutates node_modules):

```bash
node -e 'const p=require("./package.json"),fs=require("fs");const d={...p.dependencies,...p.devDependencies};console.log(Object.keys(d).filter(k=>!fs.existsSync("node_modules/"+k)).join("\n")||"(none missing)")'
```

## 3. The stale-rooms-client trap (this WILL bite)

A wall of `TS2307`/`TS2724`/`MISSING_EXPORT` errors naming
`@openmarket/rooms-client` is almost never a broken branch — it is a **stale
built dist**. `tsc` and the bundler read whatever was last BUILT there, so the
version number can match the pin while the code is months behind.

On 2026-09-01 `origin/main` (e7badf93, "Russell/alert card description #670")
imported `releaseRoomAlertTrigger`, which exists **only** on the unmerged
monorepo branch `origin/russell/alert-card-description` (commit `a0e954fe`) —
so stock main did not build at all. Repair, worktree-local:

```bash
MONO=~/Documents/GitlabRepos/openmarket-internal      # note: -internal, ordered first
RCWT=~/Documents/GitlabRepos/wt/mono-rooms-client-<commit>
git -C "$MONO" worktree add --detach "$RCWT" <commit>
cd "$RCWT/packages/rooms-client"
ln -s "$MONO/packages/rooms-client/node_modules" node_modules      # if absent
mkdir -p "$RCWT/node_modules"
ln -s "$MONO/node_modules/picocolors" "$RCWT/node_modules/picocolors"   # dist imports it
PATH="$MONO/node_modules/.bin:$PATH" bun run build                 # tsc is not global
```

Then point **only your worktree** at it. `overlay_node_modules` (§2) already
makes `$WT/node_modules/@openmarket` a real directory of per-package links. So
replace just the one link. Check first that it is a link, so `rm` can never
reach the shared scope:

```bash
[ -d "$WT/node_modules/@openmarket" ] && [ ! -L "$WT/node_modules/@openmarket" ] || { echo "run overlay_node_modules first"; exit 1; }
rm "$WT/node_modules/@openmarket/rooms-client"      # a symlink; removes the link only
ln -s "$RCWT/packages/rooms-client" "$WT/node_modules/@openmarket/rooms-client"
```

Verify afterwards that `ls -ld "$REPO/node_modules/@openmarket/rooms-client"` is
still the original directory — the shared checkout must be untouched.

## 4. Baseline BEFORE any edit

The gate is already red on main; a single run answers nothing. Capture the
baseline on the unmodified worktree, after the environment repair above, and
store it at `~/.claude/om-bug-loop/evidence/<seq>/gate-baseline.txt`:

```bash
git status --porcelain | grep -v '^?? '      # MUST be empty first
bun run lint; bun run typecheck; bun run build; bun tools/check-dist.ts; bun tools/test-fast.ts
```

Observed baseline on e7badf93 with the repair applied: lint red (pre-existing),
2 pre-existing `search-seam.ts` TS errors, **build and check-dist PASS**,
test-fast `11787 pass, 261 fail (261 confirmed)`. Without the repair: build
FAILS and only ~5256 tests run — so a baseline captured on the broken
environment is worthless. Trust `test-fast`'s "confirmed in isolation" list;
the obligation on a fix is **no NEW failures**, never a green gate.

## 5. Committing from `codex exec` (a linked worktree cannot commit by default)

Verified 2026-09-01 on to-do 6658. `codex exec --sandbox workspace-write` grants
writes **inside the workspace directory only**. A linked worktree keeps none of
its git metadata there: `<worktree>/.git` is a one-line pointer file, and the
real index, HEAD and refs live in the PARENT repo under
`<repo>/.git/worktrees/<name>/`. So every write-side git command dies before it
begins:

```text
fatal: Unable to create '/Users/nicholas/Documents/GitlabRepos/openmarket-chat/.git/worktrees/openmarket-chat-reset-button-greyed-out/index.lock': Operation not permitted
```

`git add`, `git commit`, `git checkout` and `git rebase` all fail this way; only
read commands (`git status`, `git diff`, `git log`) work. Codex reports it as a
blocker and leaves the whole change uncommitted in the working tree.

The fix is `--add-dir`, pointed at the common git dir:

```bash
WT=~/Documents/GitlabRepos/wt/openmarket-chat-<slug>
codex exec \
  --sandbox workspace-write \
  --cd "$WT" \
  --add-dir "$(git -C "$WT" rev-parse --git-common-dir)" \
  ...
```

`rev-parse --git-common-dir` resolves to `<repo>/.git` — the parent repo's git
directory, which is what actually needs to be writable. Do not hand-write the
`.git/worktrees/<name>` path: refs, logs and `packed-refs` live one level up in
`<repo>/.git` too, so a commit still fails if only the per-worktree subdirectory
is granted.

Granting `<repo>/.git` does NOT grant `<repo>` itself, so the shared checkout's
working tree stays protected — which is the property the worktree exists for.

## 5b. `git checkout origin/main -- <path>` silently stops being a "before"

Once your fix has **merged**, `origin/main` contains it — so restoring a file
from `origin/main` to build the "before" arm is a **no-op**, and your A/B probes
the fixed file twice. It does not error; it produces two identical results that
look like "the fix changed nothing".

Hit on T9, 2026-09-02, after MR !288 merged mid-task. The fix: check out the
**explicit pre-fix blob** and verify its hash, never a moving ref.

```bash
git checkout <pre-fix-sha>:src/path/File.tsx -- src/path/File.tsx   # or: git show <sha>:<path> >
git hash-object src/path/File.tsx        # must equal the pre-fix blob hash
```

More generally: an A/B arm restored from any branch name is only as trustworthy
as that branch is still. Pin arms to commits, assert the content hash, and if
both arms agree suspiciously, suspect the harness before believing the result.

## 5c. Rendering a component whose real dependency never answers

A component gated on a call the environment cannot serve (the hosted fork's
`fetchRoomsTones`, `if (!answered) return null`) has no DOM to photograph — but
that is not the same as having nothing to show. T9 mounted the **real**
component in the dev server with injected `deps` and a **mutable** stub store,
so `clearTone` genuinely removed the tone and the row displayed the true
consequence rather than a staged one. Two rules that made it honest:

- Import the stylesheet the real call site imports. `settings.css` is NOT
  imported by `styles.css` (only mentioned in its comments), so the first
  render came out unstyled — **view every screenshot before embedding it**.
- Say what the image is NOT. It is a fixture render, not a photograph of the
  shipped hosted app, and the card must say so.

## 5d. `test-fast` currently does not complete here — cause UNKNOWN

As of 2026-09-02, `bun tools/test-fast.ts` in openmarket-chat does not finish on
this machine. Five attempts across T7 and T8, including one at `--shards 3` and
one on a **verifiably clean** machine, with one shard pegged at 99.9% CPU. It
completed in ~60s earlier the same day.

**Do not repeat the disproven theory.** A killed run really does orphan its
shard workers (they reparent to `launchd`, `ppid=1`, holding memory), and that
leak is worth cleaning up on its own account — **but only YOUR run's workers.**
Every owner and verifier on this machine runs `bun test`, so a pattern kill
(`pkill -f 'bun.*test'`, `killall bun`, `pgrep … | xargs kill`) is a cross-task
kill. On 2026-09-15 a verifier's `pkill -f "bootstrap.ts run"` took down
Nicholas's own `:31417` daemon. Kill only PIDs you recorded when you started them.

`tools/test-fast.ts` spawns each shard `detached` — its own process group — and
the runner has no signal handler, so killing the runner, or even the runner's
whole group, leaves the shards running with `ppid=1`. So: launch the run as a
group leader and record its PID; stop it by that PID's group plus its direct
children's groups. macOS has no `setsid`, and the Bash tool's zsh refuses `set -m`
("can't change option"), so take job control from a `bash -c` wrapper — verified
2026-09-15 in both zsh and bash against a throwaway runner with detached children:

```bash
# start — the runner becomes its own group leader; its PID is recorded, not guessed
bash -c 'set -m; cd "$1" && bun tools/test-fast.ts > "$2/test-run.log" 2>&1 & echo $! > "$2/test-run-T<NN>.pid"' _ "$WT" "$S"

# stop — the runner's group, then each shard's group (snapshot the children BEFORE the
# runner dies: once they reparent to launchd nothing ties them to your run by parent).
# The pgid==pid guard is load-bearing: without job control `$!` shares your shell's
# group, and `kill -- -<that pgid>` would signal your own shell.
RUN_PID=$(cat "$S/test-run-T<NN>.pid")
for P in "$RUN_PID" $(ps -A -o pid=,ppid= | awk -v r="$RUN_PID" '$2==r {print $1}'); do
  [ "$(ps -o pgid= -p "$P" 2>/dev/null | tr -d ' ')" = "$P" ] && kill -TERM -- "-$P"
done
kill -0 "$RUN_PID" 2>/dev/null && echo "runner $RUN_PID still alive"   # confirm, by PID
```

If the runner already died before you snapshotted (a tool timeout killed it), its
shards still carry your run's PID in their argv — test-fast names each report
`test-fast-<runner pid>-<shard>-….xml` (read from source, not exercised). Look for
that token with your recorded `$RUN_PID`, confirm `ppid=1` and `pgid==pid`, and kill
those groups one by one. Never widen it to "any `bun test` with `ppid=1`" — another
owner's crashed run looks identical.

But sweeping the orphans and retrying on a clean machine **still did not
complete**, so the leak is not the cause. The cause is undiagnosed. (Check once
and act — do not `pgrep`-poll in a loop.)

Practical consequence: treat a missing whole-suite diff as a real gap and say so
in the report rather than dressing up a substitute as equivalent. What T7 and T8
used instead, and labelled as weaker: every direct importer of a changed module
plus the repo's fences, run on both trees, with the source byte-identical to a
version that *was* whole-suite diffed.

## 6. Cleanup

`git worktree remove "$WT"` after the MR is open. The monorepo rooms-client
worktree can stay — the next task will need it.

---

# Preparing an openmarket-chat-CLOUD worktree

Verified 2026-09-01 while hand-porting to-do 6658 into the hosted fork. Sections
1, 4, 5 and 6 above apply unchanged (sibling worktree off `origin/main`, overlay
never install, `--add-dir "$(git -C "$WT" rev-parse --git-common-dir)"` for
`codex exec`, `git worktree remove` afterwards). What differs:

## `openmarket-chat-cloud/node_modules` IS a symlink — the whole directory

```
$ python3 -c "import os;print(os.path.islink('.../openmarket-chat-cloud/node_modules'))"
True   ->  /Users/nicholas/Documents/GitlabRepos/openmarket-chat/node_modules
```

Not the `@openmarket` scope entry — the entire `node_modules`. So the cloud fork
resolves EVERY dependency out of the daemon fork's tree, and an overlay built
from `openmarket-chat-cloud/node_modules` is transitively the daemon's. Consequences:

- `ls -l node_modules` looks like a normal directory (you are listing through the
  link) and `find . -maxdepth 1 -type l` inside it finds nothing. Only
  `os.path.islink` / `realpath` on `node_modules` itself tells the truth.
- Stack traces and rolldown errors from cloud tests cite paths under
  `openmarket-chat/node_modules`. That is expected, not a broken overlay.
- Anything that SUBSTITUTES a package (a rebuilt rooms-client, say) must de-alias
  the whole `node_modules`, not just `@openmarket`, or it writes into the daemon
  fork. Read-only use is safe.
- The cloud's manifest pins `@openmarket/rooms-client` `0.64.0` while the daemon's
  installed copy is `0.68.0`. That mismatch is the source of several baseline
  `tsc` errors (`nudge`, `RoomPollSummary.revision`) — pre-existing, not yours.
- `@orangecharts/orange-v2-pb-common` is pinned but installed in neither fork.

## Observed baseline on `origin/main` @ `5759bba` (2026-09-01)

| gate | result |
|---|---|
| `bun run typecheck` | **13** errors, red |
| `bun run lint` | 1 error (`src/shared/ui/Tooltip.tsx format`) + 60 warnings, red |
| `bun test` | 7570 pass / 7 skip / **17 fail** / 7 errors, 557 files, ~182s |
| `bun run build` | **FAILS** |

`bun run build` is unusable as a gate here: `MISSING_EXPORT "fromBinary"/"toJson"`
from `@bufbuild/protobuf` in `src/market/decode.ts`, a direct consequence of the
shared-`node_modules` symlink. It fails identically on a clean `origin/main`
worktree, so prove that rather than assuming it.

The full suite is flaky; `(fail)` lines are the readable signal. Extract and diff
the SETS:

```bash
grep -E "^\(fail\)" run.txt | sed 's/ \[[0-9.]*ms\]$//' | sort > fails.txt
comm -13 fail-baseline.txt fail-after.txt     # must be empty
```

`renewal > calls before markConnected keep single-attempt semantics for the doors`
is a known flake — it failed on the baseline and passed on the fix.

## The parity ledger (retired 2026-09-14)

`tools/parity-manifest.json` and `tools/sync-shared.ts` are gone as of
`f190644c` ("one repo for both GUIs, sharing `packages/chat-ui`"): the
copy-and-hash parity machinery between the daemon fork and the hosted fork
retired along with the manifest, the coverage fence and the import-closure
fence. `openmarket-chat-cloud` itself was retired 2026-09-23; the hosted build
now comes from `apps/cloud` in this same repo, importing `packages/chat-ui`
directly rather than copying files into a separate fork. There is no manifest
left to diff or re-pin, and no fence obligation to reason about — a shared-file
edit needs nothing beyond the normal gates.

## Shipping: GitLab

`glab` has worked again since 2026-09-07. The old `invalid_grant` workaround
addressed the retired `openmarket-chat-cloud` fork and must not be used for the
current repository. `train.ts` follows `origin`, pushes the surface branch and
creates or updates the GitLab MR through `glab api`.

There is no `user.email` configured in this repo. The house identity is
`Nicholas Wong <nicholaswong@trontalgroup.com>`; set it per commit with
`GIT_AUTHOR_*` / `GIT_COMMITTER_*` rather than writing repository config.

Every openmarket-chat MR needs a green GitLab pipeline before it can merge.

## Proving a settings/CSS change without a GUI

`NotificationTones` — and anything else gated on the daemon read — renders nothing
on hosted origins, so there is no live surface to probe. Render the component's
markup in headless Chromium against the branch's own sheet chain
(`src/shared/tokens.css`, `tokens-compat.css`, `src/styles.css`, the component's
sheet) and measure `boundingBox()`; two such pages, one per branch, give a real
before/after with numbers. From 2026-09-15 do it with agent-browser — `open` the page,
`set viewport`, then `get box <selector>` or `--json eval` a `getBoundingClientRect()`
(add `--allow-file-access` for a `file://` page; not exercised in the 2026-09-15 audit, so
confirm the sheets actually applied). Playwright, for a measurement that must stay on it, is
at `/Users/nicholas/.claude/skills/testing-harness/node_modules/playwright/index.mjs`.

---

# Proving a VISUAL fix in the real GUI (added 2026-09-01, to-do 9446)

## 7. Serving your own build without touching the shared checkout

The live daemon on `:31417` is a source daemon run from
`~/Documents/GitlabRepos/openmarket-internal` (`bun --watch packages/cli/src/bootstrap.ts run`)
with `OM_ROOMS_GUI_DIR=~/Documents/GitlabRepos/openmarket-chat/dist`. That is the SHARED
checkout's `dist/`, and `OM_ROOMS_GUI_DIR` is fixed at process start — so you cannot
retarget the live daemon without restarting Nicholas's daemon, and you must not overwrite
that `dist/`.

Boot your own daemon instead, on a clone of the home so the account data (and therefore the
logged-in GUI) comes with it.

**Use the helpers. Do not hand-roll either step.** Both costs below used to dominate every
task's wall clock and both are now removed by construction:

```bash
. ~/.claude/skills/om-bug-loop/scripts/arm-env.sh

S=<scratchpad>
CLONE="$S/om-home-T<NN>"                 # name the clone after YOUR ref — the guard port
clone_home "$CLONE"                      # is derived from it, so two owners cannot collide
start_clone_guard "$CLONE"               # T246: read-only relay. Start it FIRST.
BASE_DIST=$(base_dist ea405dd4)         # shared base bundle, built ONCE per commit per batch

set -a; . "$S/om-home/clone-guard.env"; set +a   # both chat planes -> the guard, library -> the clone

cd ~/Documents/GitlabRepos/openmarket-internal
OM_HOME="$S/om-home" OM_BIND=127.0.0.1:319NN \
  OM_ROOMS_GUI_DIR="<your worktree>/dist" bun packages/cli/src/bootstrap.ts run &
echo $! > "$S/daemon-T<NN>-319NN.pid"         # the ONLY handle you may ever kill this daemon by
sleep 22
assert_clone_inert "$(cat "$S/daemon-T<NN>-319NN.pid")" "$S/om-home"; echo "tripwire rc=$?"   # refuses if it can reach him
curl -s http://127.0.0.1:319NN/rooms/ | grep -o 'v=[a-f0-9]*' | head -2 | tail -1   # asset stamp
```

The tripwire verdict is both its exit status and its last line. Never pipe it: a pipe without
`pipefail` is refused and prints `FAIL rc=2 — … NOT RUN`, which is not a pass. To trim the
output, redirect it to a file and read the file.

**If the guard's reads fail, check the date before you work around it.** Until 2026-09-18
evening `clone-guard.ts` forwarded the client's `Host` header to the real origin, so every
proxied read hit the wrong vhost and came back 401, 404 or a connect error — looking exactly
like an auth or routing fault rather than like the guard. That is fixed. `assert_clone_inert`
now runs `clone-guard.ts --selftest` and refuses a guard that cannot forward, so a relay that
cannot serve reads no longer passes as green. **Never bypass the guard to get a read working** —
a read on a clone is a read on Nicholas's account and fires receipts as him.

**Never hardcode the guard port, and never copy another task's.** It is derived from the clone's
name (`om-home-T246` → `33246`), which is the only reason two owners running at once do not end
up sharing one guard. `OMBL_CLONE_GUARD_PORT` overrides it if you genuinely need a fixed port.
A guard also carries the identity of the clone it was armed for, so `assert_clone_inert` refuses
one belonging to a different clone rather than quietly accepting it.

**Do not skip `start_clone_guard` and `assert_clone_inert`** (added 2026-09-18, T246). Without
them the clone is a real client of Nicholas's real account and **every** write it makes — a
library note, a message, a reaction, a setting — lands on it. That is not a hypothetical: on
2026-09-17 a scratch note written only on a clone was pushed as `⇡ pushed note-T122.md r3` and
was in `~/OpenMarket/home/` a second later, on every synced device. `stop_clone_guard
"$S/om-home"` when you stop the daemon.

- **NEVER `rsync` or `cp -R` the home.** It is 347 MB (`om.sqlite` alone is 304 MB); a byte
  copy costs minutes under a loaded box, an APFS clone costs milliseconds and shares blocks
  until written. `clone_home` uses `cp -Rc` and **fails loudly** if the destination is on a
  different volume rather than silently falling back to a slow copy. Measured 2026-09-04:
  **0.072 s for 347 MB.**
- **NEVER build a base bundle yourself.** A build is a deterministic function of a commit,
  so N tasks pinned to one base need ONE build, not N. `base_dist <commit>` returns a
  shared, commit-keyed `dist/`, builds it at most once, and makes concurrent callers wait
  on a lock rather than race. This is the same principle the reviewer already follows by
  serving the owner's `dist/` instead of rebuilding it — it simply now reaches the batch.
- **`base_dist` is safe again (fixed 2026-09-15), but only because of its assertion.**
  From f190644c (2026-09-14) until the fix, it compiled the shared checkout's
  `packages/chat-ui` into every base, so cards from that window say "don't use
  `base_dist`". The fixed helper builds with `overlay_node_modules`, then runs
  `assert_arm_build`. It refuses to cache a build unless `@openmarket/chat-ui`
  resolved inside the build worktree and matched the commit's tree byte for
  byte. It serves a cache entry only if its `BUILD-INFO.json` records that pass.
  **Check it before you measure, and cite it in your provenance:**

  ```bash
  jq '{commit, builtAt, chatUiRealpath, status: .assertion.status}' "$(dirname "$BASE_DIST")/BUILD-INFO.json"
  # commit must be the full base sha, status must be "pass", chatUiRealpath must end in
  # base-dist/<sha>/wt/packages/chat-ui (the build worktree, removed after the build)
  ```

  No `BUILD-INFO.json` next to the `dist/`, or a status other than `pass`, means the
  bundle is void. Rerun `base_dist <sha>`: it renames the old slot `<sha>.UNVERIFIED-<ts>`
  and rebuilds (≈7 s). Never serve a slot whose name has a suffix (`.WRONG-chat-ui-*`,
  `.UNVERIFIED-*`, `.FAILED-*`, `.INCOMPLETE-*`). `base_dist` exits 3 when the
  assertion fails, and the verdict is in `<sha>.FAILED-assert-<ts>/assert.json`.
- **Prefer `:31417` outright for the BASE arm** when its served asset stamp corresponds to
  the merge-base (§7 of SKILL.md gives the three conditions). That removes the base arm's
  build AND its boot entirely. Check the stamp — do not assume — but do check it, because
  booting a second daemon you did not need is the single most expensive mistake available
  here.
- **A cloned home isolates the DAEMON, not the IDENTITY.** This is the trap, and it is not
  obvious: `clone_home` gives you your own process, port, filesystem state and database —
  but the clone carries **Nicholas's credentials**, so every read still hits the real server
  **as him**. Opening a channel or a DM fires server-side read receipts on his real account.
  "Use your own daemon for anything that writes" is therefore FALSE as a guarantee about his
  data; it only protects his daemon and his `dist/`. Measured on T34 (2026-09-04), which had
  to open `#general` and one DM to photograph a panel and correctly disclosed it.
  **Read receipts are the mild form. The general one is that a clone can WRITE** — a note, a
  doc, a message, a reaction, a setting, a grant — and it lands on his real account and syncs
  to every device he owns (T122, 2026-09-17). Since T246 the containment is the guard above:
  `start_clone_guard` puts a loopback read-only relay between the clone and the chat server
  (`OM_ROOM_CHAT_API_URL` / `OM_ROOMS_WS_URL`, which is where all four egress paths resolve),
  and `assert_clone_inert` refuses a clone that can still reach him.
  **"Guarded" means two specific things, and neither of them is "harmless":**
  - **network** — the *chat plane only*. Relay/topics, registry, collab and auth are still live
    on a clone.
  - **filesystem** — a clone's `agent.library_link.*` rows used to carry absolute `walkerRoot`
    paths into his REAL library, so the clone's own daemon wrote there **with no network
    involved**: the relay could not see it and the tripwire passed. `clone_home` now repoints
    those rows, and `assert_clone_inert` refuses any path-bearing settings row naming a path
    outside the clone. A path carried somewhere the product does not treat as a path setting is
    still not covered. **`OM_LIBRARY_DIR` does not override those rows** — setting it looked
    like containment and never was.
  **So:** do not open channels or DMs unless the repro genuinely requires it; never save,
  remove, follow, unfollow, block, post or change a setting on ANY daemon; and if your
  evidence forces a read that marks something, say so explicitly in your report rather than
  burying it.
- **You MUST delete `.om-runner.lock` from the copy.** It is copied holding the LIVE
  daemon's pid, that pid is alive, so the guard refuses to boot: *"another OpenMarket
  daemon already serves ..."*. The lock is reclaimed only when the holder is gone.
  `clone_home` already does this, along with `om.sqlite-shm` and `runner.boot.marker`.
- **Always assert the served asset stamp** (`v=…` in `/rooms/`) matches the `dist/` you
  meant to serve. It is the only proof you A/B'd two different builds; `bun run build`
  stamps a fresh hash each time.
- **Kill only the PID you recorded — never by pattern.** Every owner's daemon and
  Nicholas's own `:31417` all run `bun packages/cli/src/bootstrap.ts run`, so
  `pkill -f "bootstrap.ts run"` (or `killall bun`, or `pgrep … | xargs kill`) kills all of
  them — on 2026-09-15 a verifier did exactly that and took down Nicholas's daemon. The
  recorded `$!`, your clone's `$S/om-home/.om-runner.lock` (`{"pid":…}`), `/healthz`'s
  `pid` and the port's listener are the same process (checked read-only on `:31417`,
  2026-09-15); require them to agree, and never act on `:31417`:

  ```bash
  PORT=319NN; PID=$(cat "$S/daemon-T<NN>-$PORT.pid")
  [ "$PORT" != 31417 ] && [ "$(lsof -ti tcp:$PORT -sTCP:LISTEN)" = "$PID" ] \
    && [ "$(curl -s http://127.0.0.1:$PORT/healthz | grep -o '"pid":[0-9]*' | cut -d: -f2)" = "$PID" ] \
    && kill -TERM "$PID" || echo "refusing: $PORT's listener is not the daemon I started"
  while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done   # kill returns before the process dies
  lsof -ti tcp:$PORT -sTCP:LISTEN || echo "port $PORT free"
  ```
- To swap builds, restart the daemon with a different `OM_ROOMS_GUI_DIR`: stop it with the
  block above and confirm the port is free before rebooting — `kill` returns before the
  process dies and the next probe then talks to the OLD build. Record the new `$!`.
- Kill it as soon as you are done — by its recorded PID. It is a full daemon: it runs
  librarian scans and alert evaluation against the real account.
- **Drive it with agent-browser, one session per daemon** (the default for dispatches from
  2026-09-15; F51 and T179 stay on Playwright). The daemon's zero-login works for it exactly
  as for Playwright: a fresh `--session` with no profile and no cookie came up signed in on a
  `clone_home` daemon at `:31988` and on `:31417` (measured 2026-09-15). Name the session
  after the port's owner — `:319NN`, `$S/om-home-T<NN>`, `--session T<NN>-base|fix` — and
  `close` it before you kill the daemon. What still needs Playwright (WS frame blocking,
  method-based write blocking, Escape, keystroke handling) is in `browser-driving.md` §0;
  none of it is optional on a clone, because **the clone carries his identity**.

## 8. Pixel checks: the byte hash is not enough at 2x

`deviceScaleFactor: 2` (which `references/browser-driving.md` requires) makes an md5 of an
element screenshot useless on its own — one antialiased sub-pixel flips it. On to-do 9446
the merge-base member row was byte-identical at dsf 1 and *different* at dsf 2, and the
dsf-2 difference was 60 pixels of exactly **1/255** on the `rounded` corners: the
antialiasing of a 4px radius mask painting `#1b1e23` onto `#1b1e23`. A hash alone would
have called that "the hover works".

Decode and diff instead. There is **no PNG decoder available on this Mac** — no
ImageMagick, no PIL, and `pngjs`/`sharp`/`pixelmatch` are not in `node_modules`. A
dependency-free reader (zlib + the five PNG filters, ~60 lines of Python) plus a per-pixel
differ is banked at `~/.claude/om-bug-loop/evidence/9446/pngdiff.py`, together with
`probe.mjs` (idle-vs-hover element capture with a `:hover` assertion and the first-opaque-
ancestor readout) and `compose.py` (stacks crops into one before/after strip for the card).
Copy them rather than rewriting. Report **"pixels changed by ≥5/255"** — that is the number
that separates a rendering nit from a change a human can see.

## 9. Setting the theme from a probe

`localStorage['om.chat.theme'] / ['om.chat.contrast']` seeded via `addInitScript` does
**not** take — the app resolves its own stored preference and overwrites it. Hand-setting
`document.documentElement.dataset.theme` after load works, but the app can re-render and
put it back, which yields a run *labelled* dark that *rendered* light. Set the attributes
after the app settles AND re-assert them from a `MutationObserver` on
`data-theme`/`data-contrast`. Then verify by reading a painted pixel, not by trusting the
attribute. High contrast is the second axis: `data-contrast="high"`, not a theme value.

Also: write each theme's captures to its OWN output directory. Four runs into one directory
silently overwrite each other and you end up diffing the last theme while believing it is
the first.

## 10. `test-fast`'s "(N confirmed)" can be a lie, and adding a test file moves the count

`bun tools/test-fast.ts` shards 844 files 8 ways and these suites share a process, so which
files land together changes outcomes. **Adding one test file re-partitions the split.** On
to-do 9446 that alone moved the count 102 → 154 with a three-character source change.

Two things follow:

- The summary line `154 fail (154 confirmed)` is **false** whenever the line above it reads
  `isolation retry skipped: N failing files > cap 40`. When the retry is skipped nothing was
  confirmed in isolation. Read that line first.
- To attribute a delta, run the **source change alone** on the merge-base worktree (apply
  the src edits, no new test file) and compare failure SETS, not counts. On 9446 that gave
  `11999 pass, 102 fail` — the identical 102 entries — proving the source change innocent
  and the test file's shard reshuffle responsible. Then run each newly-listed file alone;
  10 of 11 passed, and the 11th failed identically alone on the merge-base.

## 11. CI on an MR can get FURTHER than `main` does

The pipeline order is Typecheck → Build → Assert bundle layout → Check dist hygiene → Lint
→ Test, and dependent jobs stop at the first failure. `main` has been dying at **Typecheck** on
rooms-client symbols that were never published, so Build/Lint/Test are *skipped* there and
`main` has no lint or test signal at all. An MR that clears Typecheck then dies at **Lint**
on the 56 pre-existing biome errors is not worse than `main` — it is strictly further
along. Compare the GitLab per-job statuses, not the red pipeline badge:

```bash
glab api "projects/openmarketxyz%2Ffrontend%2Fopenmarket-chat/pipelines/<id>/jobs" \
  --paginate | jq -r '.[] | "\(.name): \(.status)"'
```

Then prove the failing step is pre-existing by running it on two same-commit worktrees back
to back (`Found 56 errors` on both, and no diagnostic naming a touched file).

## 12. `main` moves under you

Five commits landed on `main` during one ~1.5h to-do, including a `parity-manifest` sweep
that could have pulled the touched files behind the fence (it did not — check, do not
assume) and a `rooms-client` bump. Before calling an MR done: refetch, rebase, re-run
typecheck/build/check-dist and the focused test.

## Getting a `.md` doc DOCKED on a cloned home (added 2026-09-04, T43)

On a `clone_home` copy the Library shelves read **`Channel 0 / Server 0` in every
space**, so the obvious routes to a document do not work. T43 lost ~25 minutes to five
failed attempts (space shelf, doc search, the ⌘K palette, two different channels)
before finding the one that works. T24 hit the same surface and did not write it down.

**The known-good route:**

1. Open a channel that has documents referenced in it (`#om-agent-test` works).
2. Press **Library** in the right rail.
3. Expand **referenced here**.
4. Click a row.

That docks the doc beside the channel. Do not go looking for it in the space or server
shelves on a cloned home — they are empty there regardless of what the real account has.

## Identifying which build an arm is serving (added 2026-09-04, T42 round 11)

**Do not use `?v=` for identity.** It is a **deterministic content hash of `rooms.js` +
`rooms.css`** (`tools/stamp-asset-versions.ts:39-46`), not a per-boot cache-buster. It
tells you whether two dists are the same or different; it never tells you **which commit**
built one.

Identify an arm by content:

- a **lazy**-chunk change discriminates by chunk filename —
  `ls dist/assets | grep -E 'rooms-(DocPane|LibraryPanel)-'`
- an **eager** change moves no lazy chunk name, so use
  `shasum -a 256 dist/assets/rooms.js`

Assert the value **in-page, per run**, and abort on mismatch.

Worked example of why the eager case matters: a change touching only `rooms.css` content
leaves every hashed chunk name byte-identical across both arms, so the filename cannot
discriminate at all (T47). Hash the served asset that actually changed.

**Unresolved caveat, recorded rather than smoothed over:** one agent twice read different
`?v=` values off what it believed was a single cached dist. The source says the stamp is
deterministic, so the likeliest reading is that it was two different dists — but that was
never explained. The rule above is safe either way because it does not rely on `?v=` for
identity. If you see `?v=` drift on a genuinely unchanged dist, that observation is
unresolved, not refuted.

## NUL bytes make grep skip whole files, silently (updated 2026-09-04, T48)

**`src/components/RightPanels.tsx` contains 2 literal NUL bytes** (raw NUL used as a
string delimiter in the presence code, ~lines 1612-1615), present since `89afc645`.
Plain `grep` and `ripgrep` **silently skip the entire file** — no error, no match, no
warning. T48 was briefly convinced `main` was broken with a dangling `RightPanelDock`
import because of it.

**Always use `grep -a` / `rg --text` in openmarket-chat.** Known NUL-carrying files so
far: `RightPanels.tsx`, `attachment-render.test.ts`, `news.ts`. Assume there are others.

**This is plausibly how the T30 miss happened.** T30 introduced a `labels` prop, believed
`RightPanelDock` was rendered from two places, and shipped — there were three, and the
third was in the very file whose contents a plain grep will not read. A silent skip on the
file you are enumerating call sites in produces exactly that failure.

Pair this with the mandatory **Call-site closure** section in `templates/plan-template.md`:
enumerate by symbol across `src/`, with `-a`, and state the count.

## `zsh` rewrites `$c:path` inside an unquoted expansion (added 2026-09-07, T50)

The agent shell here is `zsh`, where `:` after a parameter expansion starts a
**history modifier**. So this:

```bash
git show $c:tools/parity-manifest.json      # WRONG
```

silently becomes `<sha>ools/parity-manifest.json` — `:t` is consumed as the
"tail" modifier and eats the `t`. There is no error. It returns *a* blob, just
not the one you asked for.

On T50 this produced hashes that disagreed with `git cat-file` and briefly
looked like a genuine content discrepancy in a parity manifest — i.e. it
manufactured a plausible false finding, which is the expensive kind. It cost
time twice in one task.

Always brace and quote:

```bash
git show "${c}:tools/parity-manifest.json"  # RIGHT
```

The general rule: **quote every `$var:...` construction in zsh**, and treat a
hash that disagrees between two methods as a shell bug until proven otherwise.


## Two ways a `grep` over test output silently under-reports (added 2026-09-07, T54)

Both produce a failure **count** that is wrong in the safe-looking direction —
fewer failures than reality — which is exactly the direction that gets a bad
diff waved through.

1. **Anchoring at column 0.** `grep -E '^\(fail\)'` misses the failure lines
   `test-fast` does not print flush-left. T54's owner under-counted 4 where both
   arms actually reported 5, and it took an audit of the evidence to catch it. Use
   `grep -aE '\(fail\)'` — unanchored.
2. **Forgetting `-a`.** A stray NUL byte makes grep treat the stream as binary
   and skip it **silently** (see the NUL section above). Always `-a` on test
   output, not just on source files.

The durable rule: a failure count is evidence, so **derive it twice by different
means** before putting it in a report — and never patch a disagreement in prose,
re-measure it.

## `@openmarket/rooms-client` can be a STALE BUILD of the right version (added 2026-09-07, T49/T54)

`def2146f` (#783) imports `@openmarket/rooms-client/daemon-watches`. The
installed `0.79.0` is a **stale build carrying that same version number** and
lacks the export, so `bun run build` fails with `"./daemon-watches" is not
exported from @openmarket/rooms-client` — on **both** arms, base included, so it
does not look like your change broke anything.

The version number cannot tell you this; only the export can. `arm-env.sh`'s
`base_dist` cannot repair it either. The fix is to build rooms-client from
`openmarket-internal` (T49 used `a9a591dc9`, ~2 s) and relink the worktrees'
overlays — never `bun install`, and never touch the shared checkout.


## A reused worktree can arrive with a STALE INDEX (added 2026-09-07, T49 round 5)

T49's worktree was reused across rounds. It arrived with round **3**'s
`routing.ts` **staged** — working tree correct, index wrong — leaked from a
round-4 verifier flip experiment that staged a revert to measure the base arm.

Any commit at that point would have silently shipped the wiring that **failed
verification**, and nothing in the diff review would have shown it: `git diff`
reads working tree vs index, so a correct working tree looks clean while the
index carries the poison.

Two rules follow:

- **`git status --porcelain` on a reused worktree before you touch it**, and
  read the staged column, not just the unstaged one. Clear anything staged you
  did not stage, and bank the patch before clearing.
- **Run flip experiments in a throwaway clone**, never by staging a revert in
  the worktree you will later commit from. Measuring the base arm must not be
  able to contaminate the fix arm.
