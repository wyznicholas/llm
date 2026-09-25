# Feature plan: {{title}} ({{ref}})

<!-- The six sections are ordered so each is answerable only once the one above
     it is settled. Write them in order; do not fill acceptance criteria first
     and reverse-engineer a problem to match. -->

## 1. Problem statement

{{problem_paragraph}}

<!-- What someone CANNOT DO today, in plain words. No file paths, no solution.
     "There is no way to send someone a link to a specific message" — not
     "add a copy-link button", which is already an answer.

     If the card arrived phrased as a solution, recover the problem behind it
     and say so here. The stated solution is often not the best one, and this
     is the only section where that can still be noticed. -->

**Who hits this:** {{who}}
**Today they:** {{current_workaround}} <!-- the workaround, or "cannot" -->

## 2. Architecture changes

<!-- file:line for everything that EXISTS TODAY. New things get a shape, not a
     line number. "No architecture change" is a legitimate and common answer
     for UX polish — write it and move on rather than padding. -->

**How the surface works today:** {{current_mechanism}}
**What moves:**

| what | where | new or changed |
|---|---|---|
| {{thing_1}} | `{{file_1}}` | |

**New contracts / state / endpoints:** {{new_contracts}}
**Migrations, version bumps, re-pins:** {{migrations}}

**Blast radius:** {{blast_radius}}
<!-- Who else reads what you are changing. Whether rooms-client consumers or a
     backend are dragged in. A feature naming only client files has usually not
     looked at the write path — and a render that works over a value never
     persisted is the failure this line exists to catch. -->

## 3. User flow

<!-- Numbered, from a COLD APP, user point of view. This occupies exactly the
     slot a defect's reproduction steps occupy: om-verifier walks these in the
     real GUI. A flow that cannot be followed from a cold app is worse than no
     flow. -->
<!-- Copied into the card note's `## How to try it` — corrected against the
     build you drove, ending **You should see:** — before Review; kanban.ts gates it. -->

1. {{flow_step_1}}
2. {{flow_step_2}}
3. {{flow_step_3}}

**Entry point:** {{entry_point}} <!-- how a person finds this at all -->
**Ends when:** {{terminal_state}}

**Unhappy paths — name each, or say it cannot occur and why:**

| path | what happens |
|---|---|
| empty | {{empty}} |
| loading | {{loading}} |
| error | {{error}} |
| no permission | {{no_permission}} |
| narrow / mobile | {{narrow}} |

## 4. Solution chosen

{{approach}}

**Rejected, and why:**

| alternative | why not |
|---|---|
| {{alt_1}} | {{why_not_1}} |

<!-- At least one. A plan presenting a single option has not designed anything;
     it has described the first idea that arrived.

     If any part of this already exists in the codebase — built, unreachable,
     off by default, or mislabelled — say so HERE. That is the cheapest possible
     outcome and it is found by grepping the surface, not by building. -->

**Already exists:** {{existing}} <!-- or "nothing — this is new" -->

## 5. Acceptance criteria

<!-- WRITTEN BEFORE ANY CODE EXISTS, and NOT EDITED AFTERWARDS. This is the
     verification spec: om-verifier runs every line against the merge-base and
     against the fix.

     Each one must be:
       observable — someone outside the code can see it happen
       binary     — it passed or it did not; never "feels responsive"
       failing today — a criterion that cannot fail on the merge-base is not a
                       criterion, and the verifier reports it as a finding
                       against this plan.

     Write them as the thing you would demo. -->

- FAILS today / PASSES after: {{criterion_1}}
- FAILS today / PASSES after: {{criterion_2}}
- FAILS today / PASSES after: {{criterion_3}}

**Real-app proof:** {{gui_check}}
<!-- The GUI action plus the exact observation that proves it. This is the user
     flow above, walked. -->

**Picture matrix — enumerate it here, or the verifier will sweep.**
A feature's proof is what it looks like, so every step of the user flow that
changes the screen needs a capture. One pair per acceptance criterion, plus the
flow itself.

| # | capture name | what it shows | arms |
|---|---|---|---|
| 1 | {{name_1}} | {{criterion it demonstrates}} | before + after |

**Budget: 12 captures unless justified here.** A feature with four flow steps
and three criteria is 7-10, not 40.

**Repo static gate:** `{{gate_command}}`
<!-- Gates already red on main are diffed against a same-commit baseline
     worktree, never read as pass/fail. -->

## 6. Risk

- **What could break:** {{risk}}
- **What this deliberately does NOT do:** {{non_goals}}
- **(chat lane) Shared files touched:** {{shared_files}} <!-- parity fence -->
- **regression-impact-check:** {{regression_impact}} <!-- required when kiyotaka-frontend is touched -->

## Slices

<!-- Only when the feature is bigger than one MR. Slice 1 must be USABLE ON ITS
     OWN — a slice that ships nothing a person can see is a stage, not a slice.
     Ship slice 1; file the rest as #feature cards in todo, each linking here.

     Delete this section if it all fits in one MR. -->

| # | slice | usable on its own? | shipped as |
|---|---|---|---|
| 1 | {{slice_1}} | yes | this MR |
| 2 | {{slice_2}} | | `#feature` card |
