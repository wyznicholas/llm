# Investigating a task

*A reference for `om-task`. The agent file carries the contract and the decision rules; this file carries the how. If the two ever disagree, the agent file wins and this one is the bug.*

**The title is never the whole task.** A to-do title, or a sentence Nicholas typed, is where the task begins, not what it is. Read the reply thread, the surrounding conversation, who else hit it, any maintainer note. For a promoted to-do:

```bash
bun ~/.claude/skills/om-bug-loop/scripts/topic-context.ts --todo <seq> --window 40
```

**Reproduce it and be certain what you photographed.** Capture the bug happening → `evidence/<task>/repro.png`, labelled `own-repro`. If live repro is genuinely impossible, pull a frame from the reporter's video (`qlmanage -t -s 1400 -o <dir> <file.mov>`; ffmpeg is not installed here), label it `reporter-video-frame`, and say why.

**(chat lane)** The `:31417` daemon serves a prebuilt `dist/` that can lag `main` by hours. **Assert its asset stamp** and record it; if it lags the commit you care about, build and serve your own rather than reasoning about a stale bundle. A task once died because a measurement was taken against a stale bundle of a page that had already been deleted. **(chart lane)** there is no daemon and no prebuilt bundle — you run `pnpm dev` in your own worktree, so the equivalent question is which commit that worktree is on.

Drive **headless** — Nicholas works at this machine and a headed launch steals his focus. Never `bringToFront()`. Never `waitUntil: "networkidle"` (the app holds a websocket open; it times out at 45s). Read `references/browser-driving.md` first.

**Drive with agent-browser, session `<ref>-repro`** — the default for every dispatch from 2026-09-15 (F51 and T179, already in flight, stay on Playwright). Its §0 lists what still needs Playwright: WS frame blocking, method-based write blocking, Escape, and real keystroke handling. **Name the driver in the Verification spec** when you write it, per measurement, from that list — the verifier runs both arms on the driver you named, and a spec whose repro presses Escape or types into a channel on agent-browser is a spec the verifier has to reject.

**Write the plan** from `~/.claude/skills/om-bug-loop/templates/plan-template.md`. Two sections carry the weight:

- **Root cause** — file:line and the mechanism. If it is not proven, say so and say what would prove it. If the behaviour is deliberate rather than a defect, say that: reversing a decision and fixing a bug are different tasks.
- **Verification spec** — written now, before any code exists. It defines "working", and neither you nor Codex may redefine it later. Every check must **FAIL on the current tree and PASS on the fix**, and must name any existing assertion that has to change. A spec that cannot fail today is not a spec.

**Declare the evidence matrix in the spec.** Enumerate, by name, the captures that prove this fix — one before/after pair **per assertion**, never one per state that happens to exist. Budget 12 total unless you argue for more in the plan. You are the only party who knows which states are load-bearing; if you leave it unsaid the verifier has no choice but to sweep the surface, and one task shot 431 screenshots and spent 80+ minutes verifying a three-file diff because nothing bounded it.

Where the requirement admits two readings, recommend one and state the alternative in the digest so Nicholas can overrule it in a word. Where the change could create a hole — a route that disappears, an affordance only some rows have, a keyboard path that breaks — check it and say so. That check has already caught a change that would have made some people unblockable.

**Post the digest, then keep going.** Four elements and nothing else: problem statement (one paragraph, plain words, no file paths), screenshot path with its label, numbered reproduction steps from a cold app, and solution direction (2–3 sentences plus the plan path). Move the card to `in progress` with status `planned`, and continue into Stage 1b.

**Write your provenance into the plan before you move on** — which commit you read, which bundle you drove and its built-at stamp, what you verified, what you could not, what you excluded. Transcripts vanish. If yours does, that plan is what lets a successor pick up cheaply instead of starting over. This is not tied to ending a turn; it is tied to having learned something, which you now have.

