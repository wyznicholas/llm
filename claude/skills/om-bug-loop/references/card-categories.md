# Card categories — what gets its own card, and what gets grouped

Every card in the `todo` and `Review` lanes has a category. Five categories are **individual**: each card is its own line, with its full note and reproduction steps. The other seven are **grouped**: their cards collapse into one card per category per lane, for example `Review · Keyboard & focus (12)`, and each member shows only a short Problem, Solution and Repro, with no images.

**Why.** Nicholas cannot review 80 cards a day. Grouping is how the board fits his review budget: the kinds of fix where a mistake is cheap and visible get read as a list, and the kinds that can lose data, settle a decision, or hide a whole feature get a card each. His words (2026-09-17):

> "okay let's consolidate things, 4,6,8,10,12 can be considered as cards, and can have repro steps, the rest can be grouped into 1 card, and have a short summary of the problem, solution and repro step that's it (no images needed), if they really need my attention they can be in an individual card, other wise the rest can be grouped together"

**Nothing is deleted.** A grouped card keeps its ref, its `tasks.json` entry and its full `cards/<slug>.md` note, images included. The group card lists it, and the lane just stops showing its line. `kanban.ts` owns the grouping (`categorize`, `consume --category`, `file-finding --category`). → `kanban-tool.md`

## How a category is used now (2026-09-18)

Categories no longer decide whether a finding gets its own card. **Every open MR
has exactly one card** (`kanban.ts traincard`), and a finding is one line on it.
What the category decides is whether that line is marked:

> `- T175 · dialog focus escapes to the page behind · [plan](…) · review !important`

A line carries **`!important`** when its category is **4 raw-data, 6 write-safety,
8 dead-ends, 10 product-decision or 12 pipeline-infra** — exactly the five marked
`grouped: false` below. Those are the classes Nicholas reads himself; the other
seven he takes on trust. This replaces the 2026-09-17 individual-vs-grouped card
split: a category that used to earn its own card now earns a marked line.

The one thing that still earns a card of its own is a **`#high` feature**. Bugs
cap at `#medium`, so only a `#feature` can reach `#high`.

## The attention exception (applies to every grouped category)

A card in a grouped category stays **individual** if any of these holds:

- it is in `Need Attention` (only `todo` and `Review` are grouped at all);
- it has an unanswered line under `## Open questions`;
- its owner or verifier flagged something for Nicholas to decide;
- its fix touches a write path, persistence, auth or a grant or approval value (that is really category 6 wearing another label);
- whoever classified it is not confident of the category.

Record the reason with `kanban.ts categorize <ref> <key> --individual "<why>"`. **When unsure, keep it individual.** A wrongly grouped card is a review Nicholas skips without knowing it.

**Choosing between two categories.** Pick the one the fix is about. If one of the two is individual (4, 6, 8, 10, 12), choose that one.

---

### 1. Keyboard & focus — `keyboard-focus`

Setting: **grouped**

Something cannot be reached or operated from the keyboard, or focus lands in the wrong place: Tab order, focus traps, arrow keys, a control that cannot be focused, focus dropped into the composer.

- **Not 2:** if it can be focused but announces the wrong thing, it is screen-reader semantics.
- **Not 8:** if the action cannot be reached at all, by mouse either, it is a dead end.

Examples: T201 (History Load is mouse-only), T151 (Tab drops focus onto body), T182 (dialog close drops focus in the composer).

### 2. Screen-reader semantics — `screen-reader`

Setting: **grouped**

It looks right but announces wrong or nothing: roles, accessible names, `aria-*` state, live regions.

- **Not 9:** a wrong *visible* label is visual consistency & copy.
- **Not 1:** a control that cannot be focused is keyboard & focus.

Examples: F82 (approval toggle announces no state), F78 (draft dock announces nothing), F63 (peek opening is not announced).

### 3. Layout at a width — `layout-width`

Setting: **grouped**

It breaks at phone or narrow widths, or at a breakpoint: overflow, clipping, overlap, wrapping, a container that does not fit its screen.

- **Not 9:** if it looks wrong at every width, it is visual consistency.
- **Not 5 or 10:** state lost across a breakpoint (a dialog closing on resize) is behaviour, not layout.

Examples: T209 (consent card over the phone tab bar), T208 (big ask grows off the screen), T135 (phone sheet too narrow).

### 4. Raw data leaking into UI — `raw-data`

Setting: **individual**

Ids, handles, raw markup or source text shown where a name or rendered text belongs.

- **Not 9:** wording that is merely awkward is copy. A leak of an internal value is this category.
- **Why individual:** the fixes add reads and resolvers, and on 2026-09-17 several of those reads turned out to persist caches (T185, T229), so they need a real review.

Examples: T210 (room rows show hex ids), T229 (DM peek shows handle, not display name), T185 (raw `!done` and `om://role` text).

### 5. Stale or wrong state — `stale-state`

Setting: **grouped**

Something is not refreshed, or a failure is shown as empty or healthy.

- **Not 6:** a failed *write* that says nothing is write safety.
- **Watch the exception:** a refresh fix that touches an approval or grant path stays individual.

Examples: T192 (failed credential read renders as empty state), T161 (Active now prints heat 0 where there is no data), T203 (approval mode read once at boot; individual because it touches the approval path).

### 6. Write safety — `write-safety`

Setting: **individual**

Silent write failures, races, unconsented writes or sends, spend, a grant or approval value.

- **Takes precedence:** any card whose fix changes what is written belongs here, whatever its symptom looks like.

Examples: T204 (approval toggle fails silently), T205 (approval toggle races), F84 (expiry radiogroup changed the grant expiry value Approve sends).

### 7. Routing & history — `routing-history`

Setting: **grouped**

Deep links, Back and Forward, reload, and a URL that lands on the wrong place.

- **Not 8:** if a route exists but nothing links to it, it is a dead end.

Examples: T193 (re-firing the Front Desk deep link closes the page), T222 (a settings link does not switch pages), F46 (topics URL dies silently in Chat only).

### 8. Dead ends & hidden features — `dead-ends`

Setting: **individual**

An action or piece of information exists but cannot be reached or discovered.

- **Not 1:** if it can be reached by mouse but not by keyboard, it is keyboard & focus.
- **Why individual:** the fixes add doors, meaning new UI and new routes into features, and whether the door belongs there is a product call.

Examples: F67 (Running for you rows are inert), F71 (desk strip is inert), T195 (search miss hides the Wire an agent door).

### 9. Visual consistency & copy — `visual-copy`

Setting: **grouped**

Visual inconsistency and wording: labels, spacing, alignment, colour tiers, copy rules.

- **Not 4:** a raw id or markup in the UI is raw data.
- **Not 2:** a wrong announcement is screen-reader semantics.

Examples: T194 (pane title stays Roster), F86 (DM peek timestamps ragged), T126 (blockquote ragged left edge).

### 10. Product decisions disguised as bugs — `product-decision`

Setting: **individual**

Deliberate behaviour that Nicholas must settle. The card is really a question.

- **Takes precedence:** if the card's real question is "which behaviour do we want?", it belongs here whatever it touches.

Examples: F64 (move the account to the rail), F74 (om composer send button only), F68 (50k paste).

### 11. Findings that weren't real — `not-real`

Setting: **grouped**

The finding turned out stale or false: already fixed, measured against a stale bundle, or could not be reproduced.

- **Not superseded work:** a real bug closed by someone else's fix is categorised by what it was.

Examples: T197, F83, F73.

### 12. Pipeline & test infrastructure — `pipeline-infra`

Setting: **individual**

Pipeline, CI, tests, harness and tooling.

- **Why individual:** a red gate blocks every train, and these fixes change what the gates prove.

Examples: T234 (away-mode test flakes CI), T146 (mobile-shell visual gate), T157 (scan tests miss chat-ui files).

---

## Keeping this current

The categories and their grouped or individual settings decide what Nicholas skips. Keep them right:

1. **A card that fits no category.** Whoever classifies it (owner, `om-play-around`, the coordinator at intake) keeps it individual and uncategorised, and proposes a new category, or a wider definition of an existing one, in their report.
2. **A setting that turns out wrong.** Examples: Nicholas keeps pulling a grouped kind back out into its own card, or a grouped member turns out to have been risky. Whoever notices proposes the flip in their report and names the cards that show it.
3. **Only Nicholas decides a setting.** The coordinator records his decision below, with the date, and updates `CARD_CATEGORIES` in `kanban.ts` in the same change. A test fails if this file and the code disagree. Never flip grouped or individual on your own.

### Decisions

- **2026-09-17** Nicholas set the split: 4, 6, 8, 10 and 12 individual; 1, 2, 3, 5, 7, 9 and 11 grouped, with the attention exception. Grouping is one card per category per lane (`todo`, `Review`).
