# The board, and `kanban.ts`

*A reference for the `om-bug-loop` coordinator. `SKILL.md` carries the policy and the decision rules; this file carries the mechanics. If the two ever disagree, `SKILL.md` wins and this one is the bug.*

Every transition, always through
`bun ~/.claude/skills/om-bug-loop/scripts/kanban.ts upsert <slug> --column <col>`
— never by editing Kanban.md directly, and never by any agent.

| event | column |
|---|---|
| something worth doing, that nobody has started | `backlog` |
| watcher fired | `todo` |
| digest posted / implementing / reviewing | `in progress` |
| a stop condition fired (SKILL §4), dangerous step, BLOCKED.md, second verify failure | `Need Attention` |
| reviewer PASS, and the owner's commits are on an open batch PR | `Review` |
| the batch PR **merged** — **every** ref on it, via `train.ts landed` (`trains.md`) — Nicholas says `done <slug>`, he drags the card, or the to-do is `!done` in OM Chat | `Done` |
| the task turns out not to be work: the surface is gone, the bug does not exist, or Nicholas says `skip` | `Withdrawn` |


```

Set it at capture with `--priority`, or change it later with `priority` — which
rewrites the board tag *and* `tasks.json` in one call, for the same reason the
status block is machine-owned: a tag that disagrees with the record is worse
than no tag.

**Every card we create carries `#openmarket`** (his instruction, 2026-09-07),
emitted by `cardLine` ahead of the priority so a card reads
`… #openmarket #low`. The board now lives at the vault ROOT and serves **every
repo**, not just the OM Chat work — so without a project tag it stops being
filterable the moment a second project files a task. `PROJECT_TAG` in
`kanban.ts` is the single definition; do not hand-write the tag.

This is not the tag that was removed. `#om-bug-loop` named the **pipeline** and
told a reader nothing they could not see from the card's own link;
`#openmarket` names the **project**, which is the axis a shared board actually
needs to be sliced on.

**The `#om-bug-loop` tag is gone** (dropped at his request the same day).
Nothing parsed it — `BOARD_CARD` keys on the `[[…cards/<slug>|` link — so a
card's one tag is now its priority, which is the thing worth filtering a board
by. Other pipelines keep their own tags: `C` cards carry `#codex-task-kanban`,
and both tags coexist on a line, space-separated. **A tag written without a
separating space (`#low#codex-task-kanban`) is read by Obsidian as one tag**,
so the card silently has neither — worth checking after any hand edit.

### `backlog` — real cards for work nobody has started

`backlog` holds work that **should happen but has not started**. Both Nicholas
and the coordinator write to it, and that is deliberate: he asked for a place to
drop things any time, and for you to add anything you see that ought to be done
(2026-09-07).

**A backlog item is a CARD, not a line** (his correction, same day: *"they should
be tasks, not just titles… like actual details cards"*). It gets a ref, a
`tasks.json` entry, and a note with real content — because a bare title is
unreadable six weeks later, and the whole point of a backlog is that it outlives
the conversation that produced it.

```bash
kanban.ts backlog "<title>" --file <note.md>      # note body you wrote
kanban.ts backlog "<title>"                       # stub from templates/backlog-card.md
```

It reserves the ref, writes `cards/<slug>.md`, files the card under `## backlog`
with a `[[…|details]]` link, and stamps it. `--slug` overrides the derived slug.
Idempotent on the slug: capturing the same thing twice prints the existing ref
and changes nothing.

**Write the note properly.** Four sections, and the second is the one that gets
skipped: *What this is · Why it matters · Where to look · What "done" looks
like.* "Where to look" is what saves the next reader the rediscovery — files,
symbols, a to-do seq, an evidence path. If "why it matters" is honestly *not
much*, say so; that may mean deleting the card.

Adding one **needs no approval**, because capture commits nobody to anything —
the entry sits at status `backlog`, no agent is dispatched, and the cost of a
wrong one is a line Nicholas deletes. What you may NOT do is **promote** one.
A card leaves `backlog` only when he says so, and promotion is the ordinary intake (`dispatch.md`)
path: status `new`, `upsert … --column todo`, then dispatch.

Three properties the tool enforces, so none is anyone's job to remember:

- **The ref is reserved at capture, in `tasks.json`, before anything renders
  it.** `nextRef` derives the next number from `tasks.json` alone, so a ref
  written onto the board *without* an entry would be handed out again later and
  two cards would silently share it. Capture writes the entry, or writes no ref.
- **No pipeline checklist and no elapsed clock on a backlog card.** Both would
  lie: six unchecked stages read as "in flight at stage zero", and an elapsed
  that grows for six weeks reads as an overrun rather than as something nobody
  has picked up. `statusBlock` renders ref, status and **Captured** only.
- **No stage, no note gate.** `backlog` has no `COLUMN_STAGE` entry, so landing
  there stamps nothing and claims no progress, and `list` never reports it as
  drift.

**Rotation never touches it.** The Monday ritual empties only `Done` and
`Withdrawn`, and `backlog` is explicitly exempt — it is the one column with no
week. It is also stripped from the weekly *snapshot* (never from the live board)
so a standing list does not smear itself across every archive. See
`kanban/Kanban Rotation.md`.

`Withdrawn` is not a failure lane and it is not `Done` — it is the honest record
of work that should not happen, kept separate so "what did we ship" stays a
truthful count. A withdrawn task keeps its ref forever (never reused) and its
card must say **why** in the first line of the note: what was believed, what
turned out to be true, and what the misleading evidence was. T5 is the model —
it died because a measurement was taken against a stale `:31417` bundle of a
page that had already been deleted, and that lesson is worth more than the
plan was.

A **dangerous step** is anything destructive, schema-touching, or
prod-touching — it goes to Need Attention rather than proceeding.

### The title is a handle; the note is the brief

`TITLE_MAX = 60`, in `kanban.ts`, and it is the only knob — raising it there
raises it for every producer.

Nicholas monitors this pipeline **from the board**, and an Obsidian Kanban lane
draws each card as a single bold line. Every producer had the same escape hatch
until 2026-09-14: with nowhere else to put a finding before an owner existed,
the title became the brief. T128 shipped a 560-character title carrying three
evidence paths, a reference surface, a fix and an `alt:` — and its `|details`
note did not exist. The lane was a wall of prose in front of empty notes.

Two gates close that, and both **refuse rather than truncate** — a machine cut
at sixty characters lands mid-word and throws away the half that said what
broke, whereas refusing hands the cut back to an LLM that is already holding the
finding:

| command | who runs it | what it does |
|---|---|---|
| `kanban.ts file-finding "<short title>" --file <body.md> [--tags "#low #bug"] [--slug <s>] [--parent <ref>]` | a **reporter** (`om-play-around`), or any owner filing a follow-up | writes `cards/<slug>.md` from the body, then appends a RAW unclaimed line to `## todo`. No ref, no bold, no `|details` link — the watcher only picks up unclaimed lines |
| `kanban.ts consume <lineNo> --ref <r> --slug <s> --title "<short>"` | the **coordinator** | renders the handle on the line and banks the long original into `cards/<slug>.md` under `## Problem` |

`file-finding` is the one that matters most, because it removes the reason the
title ever grew. It slugs the title with **`slugify`, the same function
`watch-board.ts` calls on the same title**, so the note the reporter writes and
the card the coordinator creates later land on one name by construction. That
is the whole trick: writing a note at a name you picked yourself produces a note
the card never links to.

It refuses three things, each loudly: a title over the cap, a body under 80
characters (the same threshold `noteProblem` gates the `in progress` move on —
better to fail while the reporter still has the finding in hand), and a slug
that already has a note. That last one is the collision case: two findings
agreeing in their first five words would share a slug AND a note, and the second
would silently overwrite the first. The fix is one distinguishing word.

Writing a note is **not** claiming a card. Claimed is a line shape — bold title
plus a `cards/<slug>|details` link — and `file-finding` never writes one.

`consume` banks under `## Problem` on purpose: it is the same heading
`templates/card-note-template.md` opens with, so an owner **extends** the note
rather than replacing it, and nothing the reporter observed is lost. A note that
already exists is never overwritten.

### The card note is live, and three parties own different parts of it

Nicholas monitors a task **from the board**, not from a terminal. So the note
has to answer "when did this start, how long has it taken, what is left, what
did you find" whenever he opens it. A note written once is a note that lies —
this pipeline has already shipped two versions of that bug — so the parts that
go stale are machine-owned and re-rendered on every transition.

| region | owner | written by |
|---|---|---|
| between `<!-- om-bug-loop:status -->` and `<!-- /om-bug-loop:status -->` | **the tool** | `kanban.ts` only — regenerated wholesale, never hand-edited |
| the note body (Problem → Solution direction) | the **investigator** | once, at the digest; the reviewer updates it at `Review` |
| `## Work items` boxes | the **task owner** | `kanban.ts check`, one box per completed plan step |
| `## Findings`, `## Open questions` | whoever learns the thing | appended as it is learned |

Everything outside the markers survives byte-for-byte. Everything inside is
regenerated from `tasks.json` — so it is never wrong, and never anyone's job to
remember.

**Stamping is automatic on `upsert`.** A single coordinator command moves the
card, records the stage the column proves, and refreshes the note:

```bash
kanban.ts upsert <slug> --column "in progress"   # move + record + re-stamp
```

It skips the note silently when the note does not exist yet (the `todo` column
legitimately precedes it) and when the slug has no `tasks.json` entry — this
tool never invents task entries. It never skips a note that does exist.

The rendered header leads with the ref:

```
**T5** · **Status** planned · **Product** chat · **Repo** openmarket-chat
```

A task with no `ref` (an entry predating refs) renders the header without it —
nothing breaks, the field is simply absent.

New commands. `<task>` is a **ref or a slug**, everywhere:

| command | what |
|---|---|
| `kanban.ts stamp <task>` | re-render the status block from `tasks.json`. Idempotent; safe to run any time |
| `kanban.ts stage <task> <stage>` | record a stage `upsert` cannot infer — `investigating` and `reviewing` have no column of their own — then re-stamp |
| `kanban.ts check <task> --item "<text>" [--undone]` | tick/untick one `## Work items` box by substring. Refuses a no-match or an ambiguous match, listing the candidates — a wrong guess must fail loudly, never tick a neighbour |
| `kanban.ts feature <task> --file <md>` \| `--none "<why>"` | record the Feature Map entry this task wrote, or declare it has no surface to record. Additive across calls; gates the move into `Review` (§7) |
| `kanban.ts list` | one line per task, ordered by ref: `T5  planned  small-ui-nits  <column>  <title>`. Backs `/om-bug-loop status` (§11) |
| `kanban.ts file-finding "<title>" --file <md> [--tags "#low #bug"] [--parent <ref>]` | file a finding as a RAW `todo` line plus its card note. No ref, no claim — see above. **`--parent <ref>` makes a follow-up inherit its parent's priority** when `--tags` names none; an explicit priority still wins, the play-around cap still applies, and an unknown ref refuses rather than falling back to `#low` |
| `kanban.ts backlog "<title>" [--file <md>] [--slug <s>]` | capture a real backlog CARD: reserves a ref, writes `cards/<slug>.md`, files it under `## backlog`, stamps it. Idempotent; the one write that needs no approval |
| `kanban.ts next-ref` | the next ref to issue (SKILL §6) |
| `kanban.ts review-skip …` | **retired 2026-09-17**, replaced by category grouping; refuses with a pointer to `card-categories.md` |

`--no-stamp` (on `upsert`) and `--now <iso>` exist for tests; `--tasks <path>`
points at a different `tasks.json`, and `--features <path>` at a different
Feature Map.

`list` reads each task's **column from the board**, never from `tasks.json` —
reading it back from `tasks.json` could only confirm what `tasks.json` already
said, and would never catch a hand-dragged card. A row whose status is *behind*
what its column proves, or whose card is missing from the board entirely, is
marked `⚠ drift: …`. A status *ahead* of its column is ordinary in-flight work
(the investigator records `investigating` while the card is still in `todo`) and
is not flagged.

Stage stamps are **append-only** and status moves **forward only**, so replaying
a transition is always safe and can never rewrite when work began. Elapsed runs
detected → now while a task is live, and freezes at the `shipped` stamp once it
ships.

Every card has a note from `in progress` onward (SKILL §3). At `Review` the reviewer
UPDATES that note with the fix, the MR link and the after-evidence — a Review
card whose note still shows only the problem is a pipeline bug, not a
formatting nit.

**If Nicholas can SEE it, show it — in the MR.** Every finished change with a visual
surface ships **before/after screenshots in its MR description**, never in the
card note (Nicholas, 2026-09-22: "drop it in the card notes, pictures should
still exist in the MRs"). The same
viewport, named so the pairing is obvious, taken on the shipped commit and its
real merge-base. Numbers in a report are not the same as looking at the thing:
T7 shipped an entirely visual fix (a replaced screen, a new button, a restored
member count, a deleted label) with no images at all, and Nicholas had to ask.
A change with genuinely no visual surface — a relay verdict, a wire type — says
so in its MR section with the phrase **"No UI surface"** and why, rather than
quietly omitting evidence.

**`kanban.ts` enforces all three**: a move into `in progress` or `Review` is
refused unless `cards/<slug>.md` exists and has real content, and a move into
`Review` additionally requires a Feature Map entry actually touched for THIS task (`review-gate.md`).
`in progress` is deliberately NOT image- or Feature-Map-gated — the fix does not
exist yet when the digest lands, only the repro evidence. Note existence is not
enough — Obsidian writes a **0-byte note** when someone clicks a link to a
missing one, which is exactly how the empty-card bug reappeared on 2026-09-01
after being "fixed". Write the note, then move the card; if the tool refuses,
the note is the thing to fix, never the guard. Evidence lives in `kanban/evidence/<slug>/` inside the vault,
and every embed and wikilink uses the **vault-relative full path**: Obsidian
resolves `[[…]]` from the vault root, so `[[cards/<slug>]]` is a dead link that
creates a stray note outside the kanban folder when clicked (fixed in
`cardTarget()`, 2026-09-01 — never hand-write a card line).

`Done` is Nicholas's column. Move a card there only on the triggers above.


### The review-skip tick (retired)

**The review-skip tick is retired.** On 2026-09-17 Nicholas decided that grouping cards by category replaces the `✓` tick. Do not reintroduce it; `kanban.ts review-skip` refuses. Lines that still carry a `✓` are parsed correctly, and the tool strips the tick the next time it re-renders the line.

### Categories and grouped cards: the board fits Nicholas's review budget

Every `todo` and `Review` card has a category (keys, definitions and the
grouped/individual setting: `card-categories.md`). Five categories stay individual. Cards in the other seven
collapse into **one group card per category per lane**, because Nicholas cannot
review 80 cards a day (2026-09-17). A card that needs his attention stays
individual whatever its category.

```
- [ ] **Review · Keyboard & focus (12)** [[kanban/cards/group-review-keyboard-focus|details]] #openmarket #group
```

```bash
kanban.ts categorize T201 keyboard-focus --summary s.json      # joins the lane's group if eligible
kanban.ts categorize T203 stale-state --individual "touches the approval path"
kanban.ts categorize T203 stale-state --grouped                # drop the exemption
kanban.ts consume <lineNo> --ref T9 --slug <s> --category layout-width --summary s.json
kanban.ts file-finding "<title>" --file body.md --tags "#low #bug" --category layout-width --summary s.json
```

`s.json` is `{"problem": "…", "solution": "…", "repro": ["…", "…"]}`: one or
two sentences each, 1–8 short steps, no images. The group note shows exactly
those three parts per member, in ref order. In `todo` the solution is labelled
**Solution direction**; in `Review` each member also shows its PR.

- **What is stored.** In `tasks.json`: `category`, `summary`, `groupExempt`
  (why it stays individual), and, while grouped, `groupedIn` (the group id,
  `group-<todo|review>-<key>`), `groupedLine` (the member's exact board line,
  so ungrouping is lossless) and `title`. A group card has **no** ledger entry.
  Its line and its `cards/group-….md` note are rendered from the members on
  every command, and its note is never hand-edited (`note` refuses it).
- **Who joins.** A card joins automatically when all of these hold: it is in
  `todo` or `Review`, it is a `T` or `F` card, its category is grouped, it has a
  valid summary, and it has no `groupExempt`. Otherwise it stays individual.
  With no `--category`, a card stays individual and uncategorised; the tool
  never guesses.
- **Every path still works for a grouped ref.**
  - `upsert` to another column (the `train.ts landed` and `drop` moves)
    restores the member's own line in that column and decrements the group
    count; an empty group card disappears.
  - `upsert` into a grouped lane (the `train.ts ship` move) joins the group.
  - `priority` updates the stored line.
  - `list` shows the group's column with `[group-…]` and no drift.
  - `watch-board` sees a group line as claimed and never offers it.
  - The weekly rotation carries group lines over like any card.

### Priority: everything is `low` until someone says otherwise### Priority: everything is `low` until someone says otherwise

Every task carries a priority — `low`, `medium` or `high` — as a `priority`
field in `tasks.json`, rendered in the status block and as the card's **only**
tag on the board. **The default is `low`**, and it applies to every task
regardless of origin (Nicholas, 2026-09-07: *"assign all tasks with the #low,
and any task coming from me is low, unless specified"*).

So: a task he asks for in session is `low`. A task the watcher fires is `low`.
You never mark something `medium` or `high` on your own judgement — escalation
is his call, stated explicitly. The point of a default this aggressive is that
nothing is silently important, so a `#high` card on the board means someone
actually decided.

**A play-around card tops out at `#medium` unless it is a `#feature`**
(Nicholas, 2026-09-17: *"for the bugs/tickets it creates from play around, it
can never reach #high, only #feature can"*). Dispatch runs by priority, and the
night before six play-around bugs were filed `#high` (T201, T202, T203, T204,
T206, T208) and went ahead of everything else in the queue. Cards Nicholas
writes by hand are never capped.

It is code, carried by an origin marker rather than by anyone remembering:

| step | what happens |
|---|---|
| `file-finding` | writes `<!-- om-bug-loop:source om-play-around -->` as the note's first line, and rewrites a non-feature `#high` to `#medium` on the raw line, saying so |
| `consume` | reads the marker from the note and records `origin: "om-play-around"` in `tasks.json`; a non-feature `high` is capped to `medium` in the ledger and on the line, **even when `--priority high` is passed** |
| `priority <task> high` | refuses a play-around card that is not a feature (an `F` ref or a `#feature` tag) and writes nothing. It checks `origin`, then the note marker for entries older than the field |
| `note` | keeps the marker line when a replacement body leaves it out |

Origin is never inferred from a title, a tag or an evidence folder name. The
exception is Nicholas's to make by hand: he edits the board line. That changes
the board only. Dispatch reads the ledger, which stays at `medium`.

```bash
kanban.ts priority T51 high      # ref or slug; re-renders the card line too

# The board is shared

Kanban.md carries cards from more than one pipeline, told apart by their ref
prefix and their tag:

| prefix | tag | owner |
|---|---|---|
| `T<n>` | `#om-bug-loop` | **this pipeline** — yours to dispatch, move, stamp and close out |
| `C<n>` | `#codex-task-kanban` | another pipeline |

**A `C` card is not your work.** Do not dispatch an agent at it, do not move it
between columns, do not stamp it, do not write its note, and do not report it as
a live task or as drift — it belongs to the codex-task-kanban pipeline, and a
card sitting in a column for days is that pipeline's business, not a stall for
you to chase.

This cuts one way only: it is about **who acts**, not about what you may read.
If he asks you about an `H` card, answer him. And if he explicitly hands one
over — naming it and asking for work on it — that is an instruction, and it
overrides the default the way any instruction does.

Nothing enforces this in code, and nothing needs to: `tasks.json` is the sole
input to dispatch, `list` and `next-ref`, so a card this pipeline never created
is already invisible to all three. The rule exists because the *board* is the
shared surface — reading it and deciding to be helpful is how an `H` card gets
touched.

### Cloud-fork work has stopped (2026-09-08)

`openmarket-chat-cloud` is no longer a destination. Nicholas: *"we don't need
to do cloud forks anymore."* A fix to `openmarket-chat` is the whole job.

This replaced a standing pre-approval that dispatched hosted-fork hand-ports
without a gate, and it is worth knowing what went with it: roughly a third of
this pipeline's task refs were `cloud-port-*` follow-ups, so the parity fence,
the twin-fork baseline dance, and the CI-on-main-only blind spot are all
retired along with them.

If a task genuinely cannot be done without touching the cloud fork, that is a
question for Nicholas, not an assumption to act on. He can name the fork
explicitly and override this at any time.

