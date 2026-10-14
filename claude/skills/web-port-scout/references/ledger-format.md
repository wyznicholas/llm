# `docs/web-parity.md`: the web → mobile ledger

Lives in kiyotaka-frontend-app at `docs/web-parity.md`, on `main`. It is the single list
of what web (kiyotaka-frontend `production`) shipped and whether mobile has it. Nicholas
steers by changing a row's **Status** (editing the file, or telling the coordinator in
chat). The scout adds rows every 4 hours and ports or unports rows by status
(Nicholas, 2026-10-12: "create a docs in the kiyotaka-frontend-app … we can decide to
port/unport them anytime … tag the commits along with them so it's easy to backtrack").

## File layout

```markdown
# Web → mobile parity

<intro, then a numbered Contents list linking each ## section>

## What mobile is missing

<"Updated <date>, after run <stamp>." and the scope note (no backfill before 2026-10-08)>
### 1. Being built                <What web has | Owner | Rows | In flight>: every `assigned` row, plus surfaces with no row that Nicholas gave an owner>
### 2. Not planned                <What web has | Rows | Note>: every `skip` row, plus surfaces with no row he said won't be built>
### 3. Built on mobile but switched off   <ported rows hidden behind a mobile constant>
(an `undecided` row, if any, gets a "### Waiting on a decision" section above 1 until he answers)

## How to use

<statuses table, what a run does, trailers, columns>

## Not on mobile yet

| ID | Feature | Size | Status | Web | Mobile | Notes |
|---|---|---|---|---|---|---|
| WP-0041 | <mobile outcome, one line> | major | undecided | [`229df255d9`](<link>) | — | <one line> |

## On mobile

| ID | Feature | Size | Status | Web | Mobile | Notes |
|---|---|---|---|---|---|---|
| WP-0001 | <mobile outcome, one line> | minor | ported | [`9997d4e6d8`](<link>) | !89 · `abc12345` | <one line> |

## Not applicable to mobile

| ID | Web change | Web | Why |
|---|---|---|---|
| WP-0002 | <what web changed> | [`24bc970558`](<link>) | <one line: web-only internals / desktop-only / surface mobile lacks> |

## Scout runs

| Run | Web range | Rows added | MR |
|---|---|---|---|
| 2026-10-08 16:15 | `9997d4e6d8..24bc970558` | WP-0001–WP-0003 | — |
```

**Keeping the tables valid** (Nicholas, 2026-10-13: "make it more readable"; the old file
had new rows inserted between a header and its `|---|` line, so GitLab rendered 18 rows
as one paragraph):
- The `|---|` line comes directly after the header line, always. Insert a new row in ID
  order *below* the separator, never above it.
- Every table is in ID order.
- A row lives in the table that matches its Status: `ported` → **On mobile**; every other
  status → **Not on mobile yet**; nothing to port → **Not applicable**. When a run sets a
  row to `ported`, move it to On mobile in the same edit; an unported row moves back.
- Before committing, check: `grep -c '^| WP-'` equals the old count plus the rows you
  added, and `awk '/^\| ID/{getline n; if (n !~ /^\|---/) print "BROKEN: " $0}' $DOC`
  prints nothing.

**Keeping "What mobile is missing" current.** It is the part Nicholas reads. In the same
commit as the row change:
- a row becomes or stops being `undecided` → "Waiting on a decision";
- a row becomes or stops being `assigned` → section 1 (with its owner);
- a row becomes or stops being `skip` → section 2;
- a Not applicable row says "mobile has no <surface>": a surface already in section 1 or 2
  → append the WP id to its Rows ("seen in …"); a new surface → add it under "Waiting on
  a decision" and ask Nicholas in the reply who builds it, or whether to skip it;
- an owned surface or `assigned` row lands on mobile `main` → set the row `ported` (move
  it to On mobile) and drop its section 1 line;
- update the "Updated <date>, after run <stamp>" line.
- section 1 changes (an owner added, changed or dropped, or an item landed) → also update
  the "Who is building what" table at the top of `AGENTS.md`, in the same commit;
- a new row (any table) touches an owned surface → mention the owner (`@eamon5`,
  `@nicholaswong2`; handles in `AGENTS.md`) in the run MR's description with the WP id, so
  they hear about the web change.
Write it for a newcomer: plain words, no file paths outside section 3's switches.

## Rows

- **ID**: `WP-` + 4 digits, never reused, never renumbered. Next ID = highest in the file + 1,
  across every table.
- **Feature**: the mobile outcome in one line ("Kraken and Bitget logos on every venue
  mark"), not the web subject.
- **Size**: `major` = a user-visible feature or a new surface; `minor` = a fix, a
  tweak, copy, or a dependency bump.
- **Web**: every web commit at 10 chars, each linked to
  `https://gitlab.com/openmarketxyz/frontend/kiyotaka-frontend/-/commit/<full sha>`,
  separated by spaces. A bundle part says `<sha10> part: <name>`.
- **Mobile**: the MR(s) (`!136`) and the commits that landed: a squash SHA for history
  before 2026-10-12, then `git log --grep "Web-Port: WP-0042"` (the trailer is the
  reference; rebases change SHAs).
- **Notes**: one line. The reason for `skip`/`undecided`, the exact question for
  Nicholas on an `undecided` row, his answer once given ("Nicholas 10-12: port later").
  No newlines inside a cell; use `·` between items.

## Statuses

| Status | Meaning | Scout does |
|---|---|---|
| `port` | Port it on the next run | ports it, then sets `ported` |
| `undecided` | Waiting for Nicholas (new feature, a needed backend call, a product question) | nothing; asks in its reply |
| `assigned` | A person builds it by hand; Notes starts "Owner: <name> (Nicholas <date>)" | never ports it (step 7 ships `port` rows only); sets `ported` once a merged mobile commit or MR names the row |
| `ported` | In mobile `main` | nothing |
| `unport` | Take it back out | reverts its commits on the next run, then sets `skip` with "unported <date>" |
| `skip` | Decided not to port | nothing |
| `in progress` | A run is porting or unporting it right now (set by the run, cleared at merge) | treats as taken |

Defaults for a new row (Nicholas, 2026-10-12, "port fixes, ask features"):
- a fix or tweak on a surface mobile already has, or a dependency bump mobile uses → `port`
- a new feature, a new surface, anything needing a backend call mobile doesn't make yet,
  anything that conflicts with mobile `AGENTS.md` or reverses a deliberate mobile
  decision, or anything uncertain → `undecided`, with the question in Notes

Follow the web (Nicholas, 2026-10-13: "just follow the web as much as possible and port the
bugs, major features we can deal with later"): a `minor` row is never `undecided` over a
design choice (where a button goes, which wording, which limit): do what web does, `port`.
Only `major` features (a new surface or screen) and rows needing a backend call mobile
doesn't make stay `undecided`. A major row that hides a bug on mobile (e.g. web data the
phone drops) gets the bug split out as its own `minor` `port` row.
- nothing to port (web-only internals, desktop-only layout, a surface mobile lacks,
  test or docs only) → the **Not applicable** table, no status column

## Commit trailers (every port and unport commit)

```
Web-Port: WP-0042
Web-Commit: a8a07c8c542c4fc97e0f8bc801932686163a6ed7
```

One `Web-Commit:` line per web commit, full SHA. An unport commit is a `git revert` of the
row's commits and carries `Web-Port: WP-0042` and `Unport: true`. Find everything for a
row with `git log --grep "Web-Port: WP-0042"`.
