---
name: web-port-scout
description: Every 4 hours, read new commits on web kiyotaka-frontend `production`, record each web feature or fix as a row in kiyotaka-frontend-app's `docs/web-parity.md` (fixes on existing surfaces default to `port`, new features to `undecided`), then ship every `port` row and revert every `unport` row in one MR per run, with `Web-Port:`/`Web-Commit:` trailers on each commit, merged after tests and an Android check. Trigger: /web-port-scout [--dry-run] [--from <sha> --to <sha>]
---

# web-port-scout

The ledger is `docs/web-parity.md` in kiyotaka-frontend-app (format:
`references/ledger-format.md`). Nicholas steers by changing a row's Status, in the file or
in chat (2026-10-12: "create a docs in the kiyotaka-frontend-app … we can decide to
port/unport them anytime … create a MR everytime u come back … tag the commits along with
them so it's easy to backtrack"). Each run ships one MR (`references/run-procedure.md`).
Kanban cards are no longer used for web ports.

You never post in the ⌗ mobile topic, never switch a branch in a shared checkout, never
answer an account prompt on Nicholas's devices, and **never use the MacBook Pro**
(Nicholas, 2026-10-10: unstable). You write no product code and touch no device: agents
do (`run-procedure.md`).

`S=~/.claude/skills/web-port-scout/scripts`, `M=openmarketxyz/frontend/kiyotaka-frontend-app`,
`KFA=~/Documents/GitlabRepos/kiyotaka-frontend-app`, `DOC=docs/web-parity.md`.

**Dry run** (`--dry-run`): steps 2–4 only (skip the gate; pass `--from/--to` to `units`),
print the rows you would add. No branch, no MR, no log, never `advance`.

## 0. Unfinished runs

`glab mr list -R $M --output json`, source branches `webport/*`. An open run MR
(`webport/run-*`) or a leftover older port MR is finished first: resume its agent if this
session has it, otherwise start an integrator with `references/finish-procedure.md`. Start
no new rows while a run MR is open. If `glab` fails (auth), stop and reply with the error.

## 1. Gate

`bun $S/scout.ts gate`
- exit 0 `SAME` → no new web commits: if the decisions inbox has "Pending" entries, do step 5
  for them alone (run branch, doc edits); then go to step 7 (rows Nicholas set to `port` or
  `unport` since the last run still ship).
- exit 11 `NOCURSOR` → `bun $S/scout.ts init`, reply "cursor initialised at <sha>", stop.
- exit 2 → reply with the error, stop. Do not advance.
- exit 10 `NEW` → continue.

## 2. Units

`bun $S/scout.ts units > ~/.claude/om-bug-loop/scratch/wps/units.json`. Exit 2 →
stop and report; never guess a range. No units → log `{"unit":"-","verdict":"none",
"reason":"no units"}` and go to step 6.

## 3. Verdict per unit → a row and its status

Judge with agents when there are more than ~6 units (read-only judges, 4–6 units each,
returning rows as JSON; see the 10-09 runs for the prompt shape). Per unit:

- `prefilter: "skip"` → Not applicable, "skip-list paths only".
- `prefilter: "dep-bump"` → does mobile depend on the package
  (`grep '"<package>"' $KFA/package.json $KFA/chart-web/package.json`; chart-web uses
  `kscript`, `indicator-kit`, `titan-charts-next`)? No → Not applicable. Yes, and mobile is
  below that version → a `minor` row, status `port`. If an open `port` row already bumps
  the same package, retarget it to the new version instead of adding a row.
- `judge` → read `git -C ~/Documents/GitlabRepos/kiyotaka-frontend show --stat <sha>` and
  the product diff, then check mobile (grep the equivalent code: judge by whether the bug
  path or surface exists, not by file names). First match wins:
  1. **`undecided`**: it needs a backend endpoint or entitlement mobile doesn't call; it
     conflicts with a mobile `AGENTS.md` invariant; it is a new `major` feature whose phone
     layout isn't obvious (a `minor` design choice follows web instead, `ledger-format.md`); it changes what free/Plus users get in a way mobile chose
     differently; it reverses a deliberate mobile decision. Put the one exact question
     in Notes.
  2. **`port`**: a fix or tweak to a surface mobile has (Feature Map page in
     `~/Documents/Obisidian/openmarket-mobile-charts/Feature Map/`, matched by what the
     user sees). `minor`.
  3. **`undecided`**: a new user-visible web feature (`feat` that adds a surface). `major`.
     A fix to a web feature mobile doesn't have is Not applicable ("mobile has no <x>").
  4. **Not applicable**: nothing user-visible on a phone (desktop-only layout, web-only
     internals, test/docs only). One-line why.
  5. Can't decide, or an error while deciding → `undecided` with the reason.
- A bundle (`production: …`, `prodpick: …`) is split into parts, one row per part.

## 4. Duplicate check (every new `port`/`undecided` row)

1. **The doc**: `git -C $KFA show origin/main:$DOC | grep -i <sha10>` for every web SHA of
   the unit. A unit whose every SHA is already in the doc adds nothing. Old cards still
   count too: `bun $S/scout.ts cites <shas>` (history before 10-12).
2. **Mobile history**: `git -C $KFA log origin/main --since=<firstDate − 14 days> -i
   --format='%h %an %s' --grep=<word>` for two or three feature words, plus
   `--grep "Web-Commit: <sha>"`. Same change found → Not applicable, "ported by <who>
   in <sha>" (or mark an existing row `ported`).
3. **Open mobile MRs** (`glab mr list -R $M --output json`): same feature in flight →
   Not applicable, "in flight as !<iid>".
4. `!claim`s in the ⌗ mobile topic (room 7950af2f4f4a, topic 86675ae4), read only, if
   the rooms tools are granted; otherwise say "rooms check skipped" in the log.

## 5. Write the rows (the run branch)

Worktree `$KFA-wp-run-<YYMMDD-HHMM>` on branch `webport/run-<YYMMDD-HHMM>` off
`origin/main`. Edit `$DOC` per `ledger-format.md`: new rows (next IDs), the Not
applicable rows, a line in "Scout runs", and any status Nicholas gave in chat since the
last run (with "Nicholas <date>: <answer>" in Notes). Chat answers reach a scheduled run
through `~/.claude/om-bug-loop/scratch/wps/decisions-inbox.md`: apply every entry under
"Pending", then move it under "Applied" with this run's stamp. Rows this run will ship (step 7) go
to `in progress`. One commit `docs(web-parity): run <YYMMDD-HHMM>`, push.

## 6. Log, then advance

Entries `[{"unit","verdict","reason","card"?}]` → `bun $S/scout.ts log --entries <file>
--range <from10>..<to10>`, then `bun $S/scout.ts advance <to>`. The verdict is the row's
status (`port`, `undecided`, `n/a`, `duplicate`); put the WP id in `card`. Advance only
after the run branch is pushed with every unit recorded.

## 7. Ship: port and unport rows, one MR

Rows to ship: every `port` and `unport` row in the doc (origin/main plus your run branch),
oldest ID first, all in this run's one MR (Nicholas, 2026-10-12: "the bug fixes, you can attach
them together and test all at once for speed"). Row agents code in parallel (4 live); the
integrator runs one test pass and one Android pass for the whole batch. Rows other rows
depend on (a titan bump) are cherry-picked first. A row that depends on an unmerged change
outside the run waits.

1. Up to **4** row agents live at once (`run-procedure.md` "Row agent"), in ONE message,
   `subagent_type: general-purpose`, `run_in_background: true`, description
   `wp <id>`. Each prompt names the WP id, the row (feature, web SHAs, notes), whether
   it's a port or an unport, and tells it to follow `run-procedure.md` exactly with this
   skill's hard limits. When one reports, start the next row.
2. When every row agent has reported, start the **integrator** (`run-procedure.md`
   "Integrator") with the run branch, the row branches and commits, each row's "what to
   check on a device", and the rows that came back `stuck` (set to `undecided` with the
   finding).
3. No rows to ship, but the run branch has doc changes → open the MR yourself (doc only,
   "No UI surface: docs/web-parity.md only") and merge it per `run-procedure.md` step 7.
   No device check.
4. A cron tick that fires while this session's agents are live runs steps 0–6 only.

`--dry-run` never ships.

## 8. Reply

One short summary: N units · rows added (WP id, title, status) · `undecided` rows that
need Nicholas (id, title, the question) · shipped this run (`!<iid>` merged, or open and
why) · rows still `port` and queued. Nothing more.
