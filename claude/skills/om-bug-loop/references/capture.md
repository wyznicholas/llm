# Capturing evidence in the real app

*A reference for `om-verifier`. The agent file carries the contract and the verdict rules; this file carries the how. If the two ever disagree, the agent file wins and this one is the bug.*

The plan's verification spec names the captures. Take those, both arms, same viewport, and stop there. What follows is how to take one that is worth citing.

2. **Run the repro from the plan's Verification spec.** Every check must **FAIL on the merge-base and PASS on the fix**. Pin arms to explicit commits and assert content hashes — restoring a file from a moving branch is a no-op once the fix has merged, and produces two identical arms that look like "the fix changed nothing".
3. **Real-app proof.** Walk the plan's reproduction steps in the actual GUI. Drive **headless**; Nicholas works at this machine. Never `waitUntil: "networkidle"`. Block the service worker and re-assert the asset stamp after every reload, or a swapped `dist/` is answered from precache and you silently measure the wrong build. **The driver is agent-browser by default for dispatches from 2026-09-15** (`browser-driving.md` §0): the service worker is blocked there by the `no-sw.js` init script, **not** by a route, which leaves it registered. The plan's spec names the driver; both arms use it, and every capture carries `--note "driver=… session=…"`. A step that needs WS frame blocking, method-based write blocking, Escape, or real keystroke handling makes the whole measurement a Playwright one (`serviceWorkers: "block"` as before). Tasks already in flight on 2026-09-15 (F51, T179) stay on Playwright.
4. **Screenshots — capture the plan's declared evidence matrix, and stop there.**
   The plan's Verification spec enumerates the captures by name. Take those,
   both arms, same viewport. **Do not sweep the surface.** A capture that
   cannot fail proves nothing and costs the same as one that can, and an
   unbudgeted sweep is how one task shot **431 screenshots** and ran 80+
   minutes of verification on a three-file diff.
   If the declared matrix is genuinely insufficient to prove the fix, **say so
   as a finding and name the missing capture** — then take it. That is a defect
   in the plan worth recording, not a licence to photograph everything.
   **View every image before citing it.** Do not compare by byte hash at `deviceScaleFactor: 2` — one antialiased sub-pixel flips it; decode and diff per pixel and report **pixels changed by ≥5/255**. Two captures that are byte-identical across different widths mean a capture never happened.
**Run both arms on two daemons at once. Never swap one daemon between arms.**
Boot the BEFORE arm and the AFTER arm on **two ports simultaneously** and drive
them in parallel. Swapping a single daemon means kill, rebuild, restart and a
~13s page boot for every crossing — T23 did that twice and measured **18
minutes** for what it had assumed was a one-minute re-shoot; almost none of the
cost was the captures. Two daemons cost two ports and no wall clock.

It also removes a whole class of error: with one daemon you must re-assert the
asset stamp after every swap or you silently photograph the wrong build, and
that has happened. With two, each arm's stamp is fixed for the life of the run.

On agent-browser the arms are also two **sessions**, `--session <ref>-base` and
`--session <ref>-fix`, driven in parallel. Two sessions are two browsers with
separate storage (measured 2026-09-15); one session navigated between both ports
is the single-daemon swap again in a different place.

**Capture hygiene — the frame must be clean, and *proven* clean.**
Every capture probe starts with the same preamble, before any screenshot. It is
about five lines and it prevents a whole class of wasted re-shoots:

```js
// park the pointer off every interactive element, then let hover state expire
await page.mouse.move(4, 880);
await page.waitForTimeout(900);
// blur anything a previous step focused — an Escape teardown leaves a ring
await page.evaluate(() => (document.activeElement)?.blur?.());
// then MEASURE that the frame is clean, and bank the result in the payload
const hasTooltip = await page.locator('[role="tooltip"], .tooltip, [data-tooltip]:not([hidden])').count() > 0;
```

The same preamble on agent-browser:

```bash
agent-browser mouse move 4 880
agent-browser wait 900
agent-browser eval 'document.activeElement?.blur?.(); "blurred"'
agent-browser --json eval 'document.querySelectorAll("[role=\"tooltip\"], .tooltip, [data-tooltip]:not([hidden])").length > 0'
```

**Do not tear down with `press Escape` on agent-browser** — on 0.37.1 it starts
an endless phantom keydown stream (`browser-driving.md` §0). If a frame can only
be cleared with Escape, that capture belongs to a Playwright measurement.

Record `hasTooltip` (and any equivalent) **in the capture's JSON payload**, not
just in prose. A frame asserted clean is worth nothing; a frame whose payload
says `"hasTooltip": false` is checkable by anyone, including you.

This exists because it has already cost real time. On T23 the first pass left
the pointer resting on the rail toggle, so an "Expand panel" tooltip rendered
over the bar's right end **in both arms** — and in the AFTER frame it sat over
the very Search control the capture existed to prove was now whole. Noticing it,
writing a bespoke re-shoot probe and re-running both arms took **17 minutes**,
against **one minute** for the original five captures. On T18 a `:focus-visible`
ring left behind by an `Escape` teardown made two frames hash differently and
was first misdiagnosed as a mouse-position artifact.

The pattern generalises: **a capture is contaminated by whatever the step before
it left behind** — a hover, a focus ring, an open menu, an in-flight transition.
Tear that down explicitly rather than hoping the next navigation clears it, and
prove the teardown worked rather than assuming it.

5. **Feature Map entry**, then record it with `kanban.ts feature <task> --file <path>`. Four H2s exactly: `## Sub-features`, `## How to get to it (user POV)`, `## Driving it`, `## Gotchas`. "Driving it" names the product's own URL — `:31417` for chat, the task's `VITE_PORT` for chart — and a chart entry belongs in the chart map, which `kanban.ts feature` selects from the task's `product`. The move into `Review` is refused unless it was modified for **this** task.

Write `verify-report-<agent>.md` — **not** `verify-report.md`, which is the owner's. Concurrent writes to one path have destroyed a second opinion before.

