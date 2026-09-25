<!-- Write prose ONE PARAGRAPH PER LINE — never hard-wrap at a column.
     Obsidian renders a single newline as a real line break, so wrapped text
     shows up chopped at the wrap column instead of reflowing to the pane.
     (Tables, code fences, list items and embeds keep their own lines; this
     rule is about paragraphs. The skill's own docs stay wrapped — they are
     read in a terminal.) -->

# <what a human sees go wrong, not the root cause>

<!-- MAX 60 CHARACTERS: this is the same handle the board card carries,
     `<surface>: <symptom>`, and `kanban.ts` enforces it there. Everything else
     goes below — that is what the rest of this note is for. -->

<!-- om-bug-loop:status -->
**Status** investigating · **To-do** <seq> · **Repo** <repo>

**Detected** <local time> · **Elapsed** <duration>

- [ ] detected
- [ ] investigating
- [ ] planned
- [ ] implementing
- [ ] reviewing
- [ ] shipped

<!-- /om-bug-loop:status -->

**Reported by** <@handle (seq N)>, <re-filed by / no replies / promoted from …>
**Full plan** — `~/.claude/om-bug-loop/plans/<seq>-<slug>.md`

## Problem

<One paragraph, plain words, from the user's side of the glass: what they did,
what happened, and why it is a problem rather than a preference. No file paths,
no CSS selectors, no root cause — that is Solution direction's job.>

<!-- THIS SECTION MAY ALREADY BE WRITTEN. `om-play-around` files a finding as a
     short board line PLUS this note, and `kanban.ts consume` banks a long board
     title here when the coordinator shortens it. Either way the text is from
     the only party that watched the thing happen. EXTEND it — correct it if the
     investigation proves it wrong, and say so — but never replace it with a
     paraphrase of the card title. That direction of information flow is what
     the two-piece card exists to stop. -->

## Reproduction steps

<!-- T cards only (F cards delete this and keep How to try it). Numbered, from a cold app, ending **Expected:** / **Actual:** — kanban.ts refuses a T card into `in progress` without this heading and into Review without a step and an Expected line. -->

1. <From a cold app. Name the URL, the viewport, and the starting state.>
2. …

**Expected:** <what should happen, in the grammar the rest of the app already uses>
**Actual:** <what happens>

## How to try it

<!-- F cards only (T cards delete this). Numbered, from a cold app to the new surface, written from what you actually drove, ending **You should see:** — kanban.ts refuses an F card into Review without it. -->

1. <From a cold app: how to reach the feature.>
2. …

**You should see:** <what on screen proves it works>

## Evidence

<!-- THE FIRST ROW IS ALWAYS "THE THING EXISTING", EMBEDDED — not merely banked.
     An evidence set of only after-states passes the image gate while still
     failing to show the change: `kanban.ts` checks that SOME image is embedded,
     which "has images" satisfies and "shows the before" does not. Two tasks hit
     this on 2026-09-04 — T43 embedded eight after-state pairs and no frame of the
     document it closes, and Nicholas had to ask whether the evidence was
     contaminated. Declaring capture 1 as "the shared setup" is the subtle form of
     the same hole: it reads as scaffolding, so nothing obliges anyone to embed it.
     If the change is a transient, a still frame cannot show it — bank a frame
     sequence and embed at least the pair that brackets the change. -->

**own-repro** — <how it was reproduced: the surface, the viewport, the data used>
<or **reporter-video-frame** — plus WHY a live repro was not possible.>

![[kanban/evidence/<slug>/repro.png]]

<Every embed and wikilink is a VAULT-RELATIVE FULL PATH. A bare `![[repro.png]]`
is ambiguous the moment a second task has one, and Obsidian resolves `[[…]]`
from the vault root, not from this folder.>

<Any measurement that turns "it looks wrong" into a number — a computed-style
table, a timing, a byte count — goes here. It is what makes the digest arguable
instead of impressionistic.>

## Solution direction

<2–3 sentences: root cause with the file and line, then the shape of the fix.
Name what is deliberately NOT touched, and why.>

## Work items

<One unchecked box per step of the APPROVED plan's fix steps, verbatim — this is
the contract, so ticking a box has to mean that step of the plan is done. The
task owner ticks them with:

  bun ~/.claude/skills/om-bug-loop/scripts/kanban.ts check <slug> --item "<text>"

Do not paraphrase the plan here and do not add steps that are not in it: a work
item that does not correspond to a plan step is progress nobody approved.>

- [ ] <plan step 1 — file + what changes>
- [ ] <plan step 2>
- [ ] <plan step 3 — tests>
- [ ] <plan step 4 — parity port / follow-up, if the plan has one>

## Findings

<The interesting things that would otherwise only exist in a terminal report
nobody will read again. Bulleted, one thought each. Typical entries:

- a latent defect found while investigating and deliberately EXCLUDED, with why
  it wants its own to-do rather than a ride-along;
- an environment trap the next agent would otherwise re-discover;
- cross-repo implications — for `chart`, whether the root cause is really in
  `titan-charts` (a separate task, since one worktree cannot reach two repos),
  and for `chat`, whether `rooms-client` needs a release;
- a measurement that surprised you, even when it did not change the plan.>

- <finding>

## Open questions

<Only things that genuinely need Nicholas: an ambiguous requirement, a product
decision the fix forces, a destructive or prod-touching step. Anything an agent
can settle for itself does NOT belong here — it belongs in Findings, already
settled.>

1. <question>
