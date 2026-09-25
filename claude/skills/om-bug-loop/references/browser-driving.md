# Driving the GUI without hijacking Nicholas's screen

**Nicholas is working while you run.** A headed Chrome launch on macOS activates
the app and takes keyboard focus, so every probe throws a window in his face and
interrupts him. That is never acceptable as a default, and it is never
acceptable silently. Rule, in order:

## 0. The driver: agent-browser by default, Playwright where it cannot reach

**Nicholas, 2026-09-15.** Every dispatch from that date on drives the browser
with **agent-browser** (`agent-browser 0.37.1`, `/opt/homebrew/bin/agent-browser`,
driving the installed `/Applications/Google Chrome.app` 153.0.8010.36 headless)
instead of a hand-written `chromium.launch` script. **Tasks already in flight
when the switch landed — F51 and T179 — finish on Playwright.** Do not port a
half-run measurement.

It was audited against the live `:31417` daemon, a cloned-home daemon on
`:31988`, and a local fixture that logs every write it receives, on 2026-09-15.
What it can and cannot do is the whole rule, so here it is:

| # | capability | verdict | proved by |
|---|---|---|---|
| 1 | zero-login session, `:31417` and a `clone_home` daemon | **yes** | a fresh session with no profile and no cookie opens `/rooms/#/channels` signed in on both ports (`document.cookie` empty, user shown). The daemon injects the credential, exactly as for Playwright |
| 2 | exact viewports 1440×900, 420×900, 390×844, 844×390 | **yes** | `set viewport <w> <h> 2` → `innerWidth/innerHeight/devicePixelRatio` exact, PNGs at 2× |
| 3 | full-page and element screenshots | **yes** | `screenshot --full` → 2880×4956 on a tall page; `screenshot .browse-row <path>` → 2076×74 (a 1038×37 row at 2×) |
| 4 | JS eval returning JSON | **yes** | `eval --stdin` returns the value; `--json eval` returns it structured under `data.result`. Computed style, `document.activeElement`, `getBoundingClientRect` all read; `get box` / `get styles` too |
| 5 | real keyboard and mouse | **partial** | Tab, Shift+Tab, arrows, Enter, `Meta+k`, `Control+a` each deliver exactly one keydown; hover with dwell is real (`:hover` matches, tooltip timer fires); drag reaches `dragover` on an intermediate target and `drop`. **But `press Escape` is broken and `type` is not typing** — below |
| 6 | block non-GET HTTP before interacting | **partial** | `network route <url> --abort` matches URL and resource type only. The same route aborted GET, POST, PATCH and DELETE alike; there is no method predicate |
| 7 | intercept or drop outgoing WebSocket frames | **no** | no command exists. `network route "ws://…" --abort` did not even stop the connection (`readyState` 1 after reload), and an `EDIT_MESSAGE` frame reached the fixture server |
| 8 | isolated parallel sessions | **yes** | two sessions started concurrently get their own daemon and their own temp `--user-data-dir`; localStorage and cookies did not cross |
| 9 | console and network logs | **yes** | `console`, `errors`, `network requests [--method POST] [--filter <s>]`, `network har start/stop` |
| 10 | headless, and nothing left behind | **yes** | Chrome runs `--headless=new`, no window; `close` leaves 0 daemons and 0 Chrome processes; an idle session exits on `AGENT_BROWSER_IDLE_TIMEOUT_MS` |

### What stays on Playwright, and why

**These are safety intercepts. Never weaken one to fit the new tool.**

- **WebSocket frame blocking still runs through Playwright's `routeWebSocket`
  until agent-browser supports it.** A message EDIT is a WS frame, not an HTTP
  request (T179 is exactly that class: ArrowUp in a channel edits a message).
  So any measurement that drives keys, clicks, drags or pastes inside a
  channel, DM or thread on a daemon carrying Nicholas's identity is a
  **Playwright measurement**, with the frame drop installed before the first
  interaction.
- **Blocking writes by HTTP method still runs through Playwright's
  `route` with a `request().method()` check.** OM Chat reads over POST
  (`/rpc/v1/*`, `/api/rooms/rooms/profiles/bulk`), so a URL-only abort cannot
  tell a read from a write. If your probe would block by method, it is a
  Playwright probe.
- **Escape runs on Playwright.** On 0.37.1 the first `press Escape` in a session
  starts an endless stream of trusted `keydown` events (`key: "Unidentified"`,
  `code: "Minus"`, thousands per second) that does not stop on its own or on a
  later Shift. Reproduced 3/3 in fresh sessions; Playwright on the same Chrome
  binary delivers exactly one event. On OM Chat that is a key-handler storm, and
  an Escape teardown is a normal step, so a measurement that needs Escape
  anywhere is a Playwright measurement.
- **Testing keystroke handling runs on Playwright, or on `press` one key at a
  time.** `type <sel> <text>` and `keyboard type <text>` fire only `input`
  events: no `keydown`, no `keyup`. Measured. They behave like the value-setter
  injection in §3c, not like a person typing. `press <key>` is the only verb
  that delivers keydown/keypress/keyup.

A JS-layer guard (an `--init-script` that wraps `fetch`, `XMLHttpRequest` and
`WebSocket.prototype.send`) works on a fixture, and agent-browser's own docs
call that approach best-effort. **It is not an accepted substitute** for the
network-layer intercepts above; it is fine as a second layer, never as the only
one.

### One driver per measurement

A measurement runs **both its arms on the same driver**: never agent-browser on
the base arm and Playwright on the fix arm, or the reverse. Event delivery
differs between them (the Escape stream above is one measured difference), and
a difference between arms must be the diff, not the harness. Decide the driver
when you write the verification spec, from the list above, and record it on
every capture:

```bash
bun ~/.claude/skills/om-bug-loop/scripts/stamp.ts write <file> --arm before --commit <sha> \
  --note "driver=agent-browser 0.37.1 session=T182-base"
```

### Session names are namespaced by ref, like ports and homes

The default session is one browser shared by every agent on the machine, so
**never run without `--session`**. Derive the name from your ref, the way
`:319NN` and `$SCRATCHPAD/om-home-T<NN>` already are: `T182-base` and `T182-fix`
for the two arms, `T182-repro` for a single-arm reproduction, `F60-base` /
`F60-fix` for a feature, `T182-verify-base` / `T182-verify-fix` for
`om-verifier` (never the owner's names, which may still be open),
`T190-pa` for a play-around (its card carries a `T` ref too), and `R12`,
`R12-discord` for research.
Say in your report which sessions you used, and close only sessions you
started.

### Recipe

Every Bash call is a fresh shell, and **a launch setting that differs from the
session's previous command relaunches the browser onto `about:blank`
silently** — measured with `AGENT_BROWSER_IDLE_TIMEOUT_MS` set on one command
and not the next: `get url` came back `about:blank` and the page was gone. So export
the same block at the top of **every** call:

```bash
export AGENT_BROWSER_SESSION=T182-fix AGENT_BROWSER_IDLE_TIMEOUT_MS=900000 AGENT_BROWSER_COLOR_SCHEME=dark
NOSW=$SCRATCHPAD/no-sw.js   # §3b — written once per task
[ -f "$NOSW" ] || printf 'try{navigator.serviceWorker&&(navigator.serviceWorker.register=()=>Promise.reject(new Error("sw blocked")))}catch(e){}\n' > "$NOSW"

agent-browser --init-script "$NOSW" open                       # clean launch, no navigation yet
agent-browser set viewport 1440 900 2
agent-browser open "http://127.0.0.1:319NN/rooms/#/channels"   # never networkidle
agent-browser wait .browse-name                                # a selector you need, not a sleep
agent-browser --json eval 'getComputedStyle(document.querySelector(".browse-row")).backgroundColor'
agent-browser screenshot .browse-row "$EVIDENCE/<task>/row-fix.png"
agent-browser close                                            # always; the idle timeout is the backstop
```

- **Drag through an intermediate target** with `mouse move` to the source,
  `mouse down`, **at least two** `mouse move`s inside every target you need a
  `dragover` on, then `mouse up`. One move per target delivers `dragenter` but
  no `dragover` and no `drop` (measured). `drag <src> <dst>` only passes over
  what lies on the straight line between them.
- **Before you report, prove cleanup**: `env -u AGENT_BROWSER_SESSION
  agent-browser session list` shows none of your sessions. Run it with the
  variable unset — with it set, the list prints your session behind a `→`
  marker even after `close`, which reads as a leak and is not one.

That recipe was run end to end against `:31417` across two separate shells:
viewport `[1440,900,2]`, `prefers-color-scheme: dark` true, **0** service-worker
registrations, and 0 daemons and 0 Chrome processes after `close`.

## 1. Headless by default

agent-browser is headless unless told otherwise; **never pass `--headed` or set
`AGENT_BROWSER_HEADED`**. The viewport and scale factor are one command:

```bash
agent-browser set viewport 1440 900 2
```

For a Playwright measurement (§0), the equivalent:

```js
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
```

Chromium's modern headless renders normally: `requestAnimationFrame` fires,
transitions run, layout and computed styles are real. `deviceScaleFactor: 2`
keeps screenshot crops legible enough to judge a 3px nit.

**Never** call `page.bringToFront()`, and never pass `--start-maximized`,
`--start-fullscreen`, or `--auto-open-devtools-for-tabs`. `bringToFront()`
steals focus even from a window you did not intend to show.

Verified headless against the live daemon on 2026-09-01 — every capability this
pipeline depends on works with no window on screen:

| capability | result |
|---|---|
| full-page screenshot | 199 KB PNG, fully rendered |
| element screenshot | 2529 B idle / 2954 B hovered |
| `.hover()` → pixels actually change | `pixelsDiffer: true` |
| computed style readable | `rgba(255, 255, 255, 0.055)` |
| `requestAnimationFrame` fires | `true` |

That row three is the point: the pixel-identity check that caught the members-
list misdiagnosis works headless. Hover states are real, not simulated.

**But do not compare screenshots by hash at `deviceScaleFactor: 2`.** One
antialiased sub-pixel flips a byte hash, so "the images differ" stops meaning
"a human sees a difference". Decode and diff per pixel, and judge on a
perceptual threshold — **max channel delta ≥5/255, plus what share of pixels
clear it** — which is what separates a real hover from AA noise:

| case | verdict |
|---|---|
| broken member row (dark) | max 1/255, **0 px** ≥5 → invisible |
| fixed member row (dark) | max 12/255, **89%** of px → visible |
| working control | 138/255 |

Those 1/255 pixels sit on the `rounded` corners: a 4px corner mask painting
`#1b1e23` onto `#1b1e23`. At `deviceScaleFactor: 1` the same pair is byte-
identical, which is why the original md5 check was sound and the dsf-2 rerun
looked like it contradicted it. Always say which scale factor a hash claim was
made at.

**Do not use `waitUntil: "networkidle"` on OM Chat.** The app holds a websocket
open, so the network never goes idle and the navigation times out after 45s —
this looks like "headless is broken" and is not. Use `domcontentloaded` plus an
explicit settle (`waitForTimeout`, or better, wait for a selector you need).
The same holds on agent-browser: never `wait --load networkidle`; use
`wait <selector>`.

The "Verified headless" table above is the Playwright audit of 2026-09-01. The agent-browser audit of
2026-09-15 is §0; pixel changes under hover were not re-measured there, only
`:hover` matching and the computed style changing, so re-check the pixels the
first time a hover measurement matters.

## 2. Reading a screen recording — use AVFoundation, not a browser

Nearly every report in ⌗ OM Chat Bugs is a `.mov` with almost no text, so frame
extraction IS the investigation. Do not reach for a browser or for Playwright's
bundled ffmpeg: that build is `--disable-everything` (mjpeg/vp8 only) and cannot
decode H.264, which is what every macOS screen recording is.

Use the native decoder instead — `scripts/extract-frames.swift`
(`AVAssetImageGenerator`), written for the small-ui-nits task:

```bash
swift ~/.claude/skills/om-bug-loop/scripts/extract-frames.swift <movie.mov> <outdir> [interval]
```

It pulled 42 usable frames at 0.1s intervals, faster and sharper than seeking a
`<video>` element, with no codec caveats. Sample densely, then tighter around
anything interesting; the cursor position in a frame is usually the whole clue.

`qlmanage -t` remains fine when you only need ONE poster frame.

## 3. When you genuinely need a real codec in the browser: headless *Chrome*, not Chromium

Bundled Chromium ships without proprietary codecs, so an H.264 `.mov` — every
screen recording in ⌗ OM Chat Bugs — decodes to black frames. Use the installed
Chrome instead, still headless:

```js
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
```

Always verify a sampled frame is not uniformly black before trusting it; a black
frame is the codec telling you it failed, not the video being black.

agent-browser already drives the installed Chrome (`/Applications/Google
Chrome.app`), not bundled Chromium — its own Chrome-for-Testing download timed
out twice on 2026-09-15 and `agent-browser doctor` fell back to the installed
one. So the codec caveat does not bite there; the black-frame check still
applies.

## 3. When you genuinely need headed, put it off-screen

Some paths really do behave differently unhidden — occlusion-throttled
`requestAnimationFrame` is the known one here: the right-slot drawer expands
inside a double rAF (`RightPanels.tsx:352`), and a pane that never renders
leaves it at width 0 with `pointer-events: none`, which reads as a product bug
when it is a harness artifact. If you hit something like that, stay headed but
keep the window off Nicholas's display. **Do this on Playwright.** An off-screen
headed launch was not part of the 2026-09-15 agent-browser audit, and its
`--args` flag splits on commas — which `--window-position=-3000,-3000` contains —
so an untested attempt is exactly how a window lands in front of him. Playwright:

```js
const browser = await chromium.launch({
  headless: false,
  args: ['--window-position=-3000,-3000', '--window-size=1440,900'],
});
```

It renders and composites normally; it is simply not where he is looking. Do not
move it back, do not focus it, and **say in your report that you had to go
headed and why** — a silent headed launch is the thing being complained about.

## 3b. Two traps that silently corrupt an A/B run

Both hit on T8, 2026-09-01, and each made a working fix look broken.

**A service worker will serve you the wrong build.** A before/after run usually
swaps `dist/` under one origin — and the service worker answers a reload from
**precache**, so the "after" arm silently renders the merge-base bundle. Launch
with `serviceWorkers: "block"`, and **re-assert the asset stamp after every
reload** rather than trusting the swap:

```js
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ serviceWorkers: "block" });
```

If an arm's stamp does not match the build you just installed, the measurement
is void — re-run it, do not reason about it.

**On agent-browser there is no `serviceWorkers: "block"`, and a route does not
replace it.** `network route "**/rooms/sw.js" --abort` left `sw.js` registered
and controlling the page — measured, because the worker script's fetch never
passes through the page's interception. What does work is stubbing the register
call before the app runs, which is the `no-sw.js` init script in the §0 recipe:
**0** registrations, `controller: false`, on `:31417`. Assert that
`(await navigator.serviceWorker.getRegistrations()).length === 0` in each arm.

**Concurrent tasks collide on "disposable" resources.** Task owners run from the
same parent-session scratchpad, so a shared default port is not disposable at
all: T8 took `:31999` while T7 was already using it, measured T7's build in one
probe, and **killed T7's daemon at least once** before noticing. Derive both the
port and the scratch namespace from your task ref — `:319<NN>` for `TNN`, and a
`$SCRATCHPAD/om-home-T<NN>` home, and `--session T<NN>-base` / `T<NN>-fix` for
agent-browser (§0) — and say in your report which you used. Never
kill a process on a port you did not start yourself; check first, and if it is
occupied, move rather than reclaim. **Never kill by pattern** (`pkill`,
`killall`, `pgrep | xargs kill`) either — every task's daemon and Nicholas's own
`:31417` share one command line, and a verifier's `pkill -f "bootstrap.ts run"`
took his daemon down on 2026-09-15. Kill only the PID you recorded when you
started it; the recipes are in `openmarket-chat-env.md` §5d (test runs) and §7
(daemons). `:31417` is never yours to stop, restart or kill.

## 3c. A `\n` inside `.type()` on a chat composer SENDS THE MESSAGE

Playwright's `.type()` and `.fill()` replay real key events, and on the OM Chat
desktop composer a bare Enter is **send**, not newline (Shift+Enter is newline).
So a single multi-line string typed into the composer posts to the channel — on
Nicholas's real identity, in a real room, visible to everyone in it.

This happened on 2026-09-08 (T61): a fenced-code probe was typed as one string
containing `\n`, and two messages went to `#frontend` at 17:04. A cloned home
does NOT protect you here — **it isolates the daemon, not the identity.**

Two rules, and the second is the one that actually saves you:

- **Never put `\n` in a string handed to `.type()`/`.fill()` on a composer** —
  nor to agent-browser's `type`, `fill`, `keyboard type` or `keyboard
  inserttext`, whose newline handling on the composer was not audited.
  Type each line separately and press `Shift+Enter` between them explicitly.
  And remember §0: a composer is inside a channel, so a probe that types into
  one on Nicholas's identity is a Playwright probe with the WS frame drop on.
- **Prefer injecting through React's value setter with no key events at all**
  when you only need the composer to *contain* text rather than to receive real
  keystrokes. No key events means no Enter, means no send is even possible. Use
  real typing only when the thing under test is the keystroke handling itself.

If a send does escape: **stop and tell Nicholas.** Deleting messages in a live
channel is a destructive, prod-touching step — it goes to him, never routed
around, and never done because it seems tidier to clean up quietly.

## 4. Do not fake it

If a check genuinely cannot run without a visible, focused window, that is a
finding to report — not a reason to hijack the screen, and not a reason to
claim a real-app proof you did not run.
