# Plan: {{title}} (todo {{seq}})

## Problem

{{problem_paragraph}}

<!-- One plain-language paragraph. What a user experiences, not what the code
     does. No jargon, no file names — those belong under Root cause. -->

## Evidence

- **Screenshot:** `{{screenshot_path}}`
- **How obtained:** `{{evidence_kind}}` <!-- own-repro | reporter-video-frame -->
- **Source message:** seq {{source_seq}} by @{{reporter}} — {{source_url}}
  <!-- chat: http://localhost:31417/rooms#/b4472fc1fbd3/topic/7f30222f
       chart / manual: "n/a — reported by Nicholas in session" -->
- **Topic context:** `{{context_path}}` <!-- output of scripts/topic-context.ts -->
- **Other reporters / clarifications:** {{context_notes}}

## Reproduction steps

<!-- Numbered, user point of view, starting from a cold app. Anyone must be
     able to follow these without reading the code. -->
<!-- Copied into the card note's `## Reproduction steps` before the digest,
     with **Observed:** written there as **Actual:** — kanban.ts gates it. -->

1. {{repro_step_1}}
2. {{repro_step_2}}
3. {{repro_step_3}}

**Observed:** {{observed}}
**Expected:** {{expected}}

## Root cause

{{root_cause}}

<!-- file:line references, and the mechanism — why the code produces the
     observed behavior. If the cause is not proven, say so explicitly and say
     what would prove it. -->

## Call-site closure — MANDATORY when the fix turns on a prop, flag, default or guard

<Enumerate EVERY call site repo-wide, by symbol, across `src/` — never by grepping
the one file you are editing. State the count and list them. If the fix changes a
component's behaviour through a prop, say what each caller passes today and what it
will pass after.

This section exists because T30 (2026-09-04) introduced a `labels` prop, wrote in its
own plan "RightPanelDock is rendered from two places", updated two, and shipped. There
were THREE. The third was in a conversation-loading row and took the default, so the
captions T30 removed flashed back on every channel switch — Nicholas found it and had
to report the same bug twice. The miss was silent because the default was the OLD
behaviour: a default that fails OPEN means every site you forget inherits the bug.

So this section also asks the design question, not just the inventory question:
**can the default be inverted so that forgetting gives the SAFE behaviour?** If yes,
do that instead of patching the sites you found — it is the same edit and it closes
the class. If no, say why, and add a structural test that fails when a new call site
appears without the prop.

The same rule covers guards and helpers: if three call sites must pass through one
guard, route them through a single helper so a fourth cannot bypass it, and test that
the helper is the only door.>

- Call sites found: <N>, by `<the symbol-scoped command you actually ran>`
- <path:line> — passes <what> today / <what> after
- Default inverted? <yes, and how / no, and why, plus the structural test that replaces it>

## Fix plan

<!-- Ordered steps against exact files. This is the contract Codex implements;
     anything not written here is out of scope. -->

1. `{{file_1}}` — {{change_1}}
2. `{{file_2}}` — {{change_2}}

**Product:** {{product}} · **Repo:** {{repo}} · **Branch:** `om-bug-loop/{{slug}}` ·
**Worktree:** `~/Documents/GitlabRepos/wt/{{repo}}-{{slug}}`

## Verification spec

<!-- WRITTEN BEFORE ANY CODE EXISTS. Codex never defines "working"; this does.
     Every line must be checkable and must flip: red on the merge-base, green
     on the fix. This section is what /verify runs. -->

- FAILS before / PASSES after: {{check_1}}
- FAILS before / PASSES after: {{check_2}}
- Real-app proof: {{gui_check}} <!-- GUI action + the exact observation that proves it -->

**Evidence matrix — enumerate it here, or the verifier will sweep.**
List the captures, by name, that prove this fix. One before/after pair **per
assertion above**, never one per state that happens to exist. A capture that
cannot fail proves nothing and costs the same as one that can.

| # | capture name | what it proves | arms |
|---|---|---|---|
| 1 | {{name-1}} | {{the assertion it flips}} | before + after |
| 2 | {{name-2}} | {{...}} | before + after |

**Budget: 12 captures total unless you justify more here.** A themed visual
change is at most widths x themes x 2 arms; a behavioural change is usually
3-6 pairs. One task shot **431** screenshots because nothing said otherwise,
and its verification ran 80+ minutes on a three-file diff.

If a surface genuinely needs more — a matrix of themes AND widths AND states —
say so and say why, in this table. An argued 30 is fine; an unbudgeted 400 is
not.
- Repo static gate: `{{gate_command}}`
  <!-- Baseline note: {{baseline_note}} — gates already red on main are diffed
       against a same-commit baseline worktree, not read as pass/fail. -->

## Risk

- **Blast radius:** {{blast_radius}}
- **(chat lane)** **Shared files touched:** {{shared_files}} <!-- parity fence: bun tools/sync-shared.ts --diff -->
- **regression-impact-check:** {{regression_impact}} <!-- required when kiyotaka-frontend is touched -->
- **Rollback:** {{rollback}}
