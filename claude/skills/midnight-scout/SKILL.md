---
name: midnight-scout
description: Nightly 00:00-08:00 feature-by-feature audit of OM Chat. Spawns om-play-around on each feature, which files findings as raw cards in the board's todo lane for the om-bug-loop watcher to pick up. Owns the burn-down ledger; allocates no refs and dispatches no om-task. Trigger: /midnight-scout
user-invocable: true
---

# midnight-scout

You run one **phase** of a night, named by `$ROUTINE_PHASE`. Read
`$ROUTINE_HANDOFF` first; it is the only state that crosses phases.

**Keep the handoff small.** It is re-read on every turn of every later phase,
so a fat handoff reintroduces the quadratic cost the phases exist to avoid.
Decisions and small tables inline; paths to anything large.

Everything is local. **Never contact `oms-mac-mini`.**

Design: `/Users/nicholas/Documents/Obisidian/openmarket/plans/2026-09-09 midnight scout design.md`

## What you own, and what you do not

You own the **burn-down ledger**: which features have been audited, the audit
notes, and the nightly report. That is all.

You do **not** allocate refs, write card notes, spawn `om-task`, or throttle
arcs. `om-play-around` plays a feature and files raw findings into the board's
`todo` lane; the `om-bug-loop` watcher picks each one up within 60 seconds,
allocates its ref, consumes the card and dispatches the work.

**This split is why the refs are safe.** Until 2026-09-11 this skill had its own
allocator (`scripts/refs.sh`) reading the board while the bug loop read
`tasks.json`. T67 and T68 were each assigned to two different tasks, and one of
the duplicates had already shipped as a merged PR. There is now exactly one
allocator — `kanban.ts next-ref`, called only by the coordinator when it
consumes a card — so the collision is impossible rather than unlikely.

**Findings are not capped at the night level.** Eight features at up to ten
findings each is eighty cards, and that is fine: the five-part rubric is the
only filter on what gets recorded. The brake is on *dispatch rate*, not on
findings — the overnight watcher runs `--max-per-poll 1`, so cards leave the
lane roughly one per minute, and `dispatch-gate.ts` still refuses above
`cores x 1.2`.

### The overnight coordinator is a separate session, and it must be running

Cards only go to work while an `om-bug-loop` coordinator is up. The wake path is
*the watcher process exits → the harness re-invokes the coordinator*, which
fires only for a background task owned by a Claude session — so **this routine
cannot launch a useful watcher itself.** A watcher in its own pane writes
`pending/*.json` and nothing wakes anyone.

Before the night starts, a coordinator must be running in tmux:

```bash
tmux new -s ombug -c ~/Documents/GitlabRepos
claude
# then: /om-bug-loop start   (its watcher wants --max-per-poll 1 overnight)
```

If no coordinator is up, the night still works — findings accumulate in `todo`
and are consumed when one starts. Say so in the digest rather than assuming.

## Phase `slice`

Pick tonight's 8 features as one coherent area from
`/Users/nicholas/Documents/Obisidian/openmarket/Feature Map/`, skipping any file
already audited. **The audit stamp is the exact line `**Audited** ` at the foot of
a feature file** — that is the string the audit note writes, so match it verbatim.
Do NOT look for a YAML `audited:` key; the Feature Map files have no frontmatter
and no such key exists. Writer and reader of this stamp are specified here,
together, deliberately: when they were specified apart they drifted and the
dedup ledger silently stopped working.

Check whether a coordinator is up (`tmux ls`, look for a session running
`/om-bug-loop`) and record it. Write to `$ROUTINE_HANDOFF`:

```
slice: <area name>
bundle: <contents of $ROUTINE_WORK/bundle-stamp.txt>
features: <8 filenames, one per line>
coordinator: up | absent
findings: (none yet)
```

## Phases `feature-1` .. `feature-8`

One feature per phase, named in the handoff's `features:` list by position.
**The clock is the authority**: at the top of the hour you move on whether or
not the feature feels finished, and un-audited ground goes in the audit note.

1. Read the feature's map entry — `openmarket/Feature Map/<name>`.
2. Spawn **`om-play-around`** (`subagent_type: "om-play-around"`, blocking, no
   `model:`). Its prompt carries: the feature name, the absolute path to its
   Feature Map entry, and the evidence directory `kanban/evidence/pa-<slug>/`.
   It plays the four passes, applies the rubric and files its own cards.
   **Do not tell it how to play** — its contract owns that, and a second copy
   of the four passes here is how the two drift.
3. When it reports, write the audit note from `templates/audit-note.md` into
   `openmarket/Feature Map/audits/<feature> <date>.md`, using its report for the
   findings list and the ground it did not cover.
4. Stamp the feature file with the output of
   `scripts/stamp.sh <date> <bundle> <commit> <note-wikilink> <n>`. **Use that
   script.** Its text is exactly what the next night's `slice-filter.sh` matches
   on; writing the stamp by hand is how the burn-down silently broke once
   already.
5. Append the findings to `$ROUTINE_HANDOFF` **before ending your turn**, never
   in memory: each phase is a separate process and the handoff is the only
   checkpoint. One line per finding.

If `om-play-around` reports zero findings, that is a result, not a failure —
write the audit note saying so and stamp the feature.

## Phase `digest`

Assemble the night's report from `$ROUTINE_HANDOFF` and deliver it with
`scout-report.sh`. **Exactly one report per night** — the run is judged a no-op
without it.

Report four states, not one:

- features audited, and how many findings each produced;
- cards the coordinator has already consumed (they carry a `T<n>` and a details
  link on the board);
- cards still sitting raw in `todo` — either the watcher has not reached them
  yet or no coordinator was running;
- features where `om-play-around` wanted a reference it could not capture.

**Do not report MR counts as if they were yours.** Whether a finding reached an
MR is the bug loop's business and its own record; claiming it here is how a
night gets reported as more productive than it was.
