# The review gate

*A reference for the `om-bug-loop` coordinator. `SKILL.md` carries the policy and the decision rules; this file carries the mechanics. If the two ever disagree, `SKILL.md` wins and this one is the bug.*

The owner spawns **`om-verifier`** (blocking; no `model:`, its frontmatter
carries sonnet), prompt = filled
`templates/reviewer-prompt.md` ({{task}}, {{worktree}}, {{branch}}, {{plan_path}},
{{codex_log}}, {{evidence_dir}}, {{vault_evidence_dir}}, {{card_note_path}}).
Status `reviewing`.

Spawn every reviewer **BLOCKING** (`run_in_background: false`), and tell it its
**final message IS its verdict** — a reviewer must never try to deliver by
`SendMessage`. A background reviewer's report surfaces to the main session
instead of to the agent that spawned it, leaving the owner waiting on a message
that never arrives, and the reviewer guessing at an address it cannot resolve.
Both happened on T8; the coordinator had to relay the verdict by hand.

### (chat lane) The reviewer serves the owner's `dist/`; it does not rebuild

A build is a deterministic function of a commit, so rebuilding it to review it
proves nothing. The reviewer points `OM_ROOMS_GUI_DIR` at the **owner's existing
`dist/`** for each arm, and the owner therefore must not delete its worktrees
until the review is done.

Share the **artifact**, never the **measurements**. The reviewer's whole value is
re-measuring independently — that is what caught a green suite hiding a broken
right-click, a regression denominator understated by 43%, and a BEFORE frame that
was secretly the wrong build. Reusing numbers destroys the gate; reusing bytes
strengthens it, because a shared asset stamp *proves* both parties measured the
same build rather than two builds believed identical.

**Mandatory guard.** Before trusting a `dist/`, the reviewer asserts its served
asset stamp (`v=…` in `/rooms/`) and confirms it corresponds to the commit under
review. A `dist/` that cannot be tied to a commit is void — rebuild it. Never
serve the SHARED checkout's `dist/` on trust: on 2026-09-02 it was built at 16:19
from `b2c93fd0` while `main` had moved five times past it, and reviewing a stale
bundle of a page that had already been deleted is exactly how T5 died.

What this saves is the **~300 MB `OM_HOME` copy and ~22 s daemon boot per arm**,
not the build — `bun run build` measures 6–26 s here and was never the cost.

### (chat lane) The BASE arm may use Nicholas's own daemon on `:31417`

He runs `:31417` against the shared checkout's `dist/` and pulls frequently
(agreed 2026-09-03), so the base arm no longer needs a daemon of its own. That
halves the boots per task: the FIX arm still needs the agent's own daemon,
because his daemon cannot serve a branch build.

**Three conditions, all mandatory.**

1. **Prove it is the right commit before measuring.** Read the served asset
   stamp (`v=…` in `/rooms/`) and confirm it corresponds to the task's
   **merge-base** — not merely to something recent. `main` moved five times in
   one day, and a base arm served from a *later* commit is not a base arm: any
   difference you then measure could be your fix or could be the commits in
   between. If the stamp does not match, boot your own base daemon as before
   and say so. "He pulls frequently" is a reason to check, not a reason to
   assume.
2. **Never restart it, never kill it, never change its `OM_ROOMS_GUI_DIR`.**
   It is his working environment, and `OM_ROOMS_GUI_DIR` is fixed at process
   start, so "retargeting" it means killing his daemon. Two agents have already
   killed each other's daemons on a shared port; killing his is worse.
3. **Read-only probing only.** That daemon serves his **real account**.
   Screenshots, layout measurement, computed styles and navigation are fine.
   Anything that writes — posting, creating a to-do, marking read, changing a
   setting — touches his live data and must never be done there. If the repro
   requires a write, use your own daemon on your own `OM_HOME` copy.

**The verifier also audits its own evidence, as a separate and explicit pass.**
Having run the checks, it must re-read the plan, its own report and the evidence
dir and answer one more question: *does this evidence actually prove what it
claims?* Running the checks and judging whether the checks mean anything are
different skills, and a mechanical pass will sign off things it never measured.
Two real overclaims were caught this way and both were in the evidence rather
than the code: a truth-table column that was **stipulated rather than measured**,
and a BEFORE render pointing at a worktree that had been deleted, so it no
longer reproduced. A third: a spec that asserted a viewer *existed* but never
where it sat on screen passed every DOM check while the viewer opened
off-screen (T59) — which is why **every image must be opened and looked at**
before it is embedded, not merely captured. An overclaim is a FAIL: the evidence
gets fixed and re-run, not argued.

This pass used to be a separate read-only `om-evidence-auditor` agent. It was
removed 2026-09-08 at Nicholas's request; the obligation did not go with it.

**The mechanical half is now `scripts/verify-lint.ts`**, and the verifier MUST
run it against its own report before delivering a verdict. It fails three
things, each of which the auditor caught for real: a claim with **no artifact
anywhere in its section**, a **cited artifact that does not exist**, and a
**citation into a worktree** rather than the evidence dir — which stops being
re-derivable the moment the worktree is removed at close-out.

Validated against three of yesterday's real reports, and it tracks the
auditor's own verdicts: **clean** on T56, whose auditor passed first time; **12
findings** on T55 and **26** on T46's rebase, whose auditors both FAILed. Among
them a live filename typo and a report's headline suite numbers with nothing
banked behind them.

**Know its limit and do not oversell it.** It cannot tell that a number was
extracted *wrongly* from a real artifact — T54's owner under-counted failures
with a column-anchored grep while citing the correct file, and this lint would
pass that report. That judgement now lands on Nicholas at review time.

**The verifier also stamps its own phase boundaries** with `scripts/phase.ts`
and cites `phases.jsonl` in its timing account. It is the pipeline's largest
single cost — 19-48 min measured — and reported only a total, which is how its
residual once got attributed to build-and-boot: a phase it is explicitly told
not to pay and which costs seconds. Marks are checkpoints, not start/end pairs,
so a retry cannot orphan one; retries get their own mark, because contention
re-runs are the cost we have hearsay about and no data.

Evidence, not claims: code review vs. the approved plan → `/verify` (repro
FAILS on the merge-base, PASSES on the fix; static gate diffed against a
same-commit baseline worktree, because the design gates are already red on
main) → real-app proof in the running GUI → Feature Map entry
(`kanban.ts feature`) → `kanban.ts check <slug> --item "…"` for every plan step
it confirmed landed → card note updated, with the evidence pictures in the MR description (not the note).

**Anything that persists must be re-checked after a RELOAD.** A change that
looks right on screen can be writing nothing at all — the forwarded-message fix
of 2026-09-09 rendered perfectly and lost its content on the next page load,
because only the client half had been fixed. So for any change touching stored
content (messages, DMs, forwards, attachments, watchlists, saved layouts,
settings), the evidence must include an **after-reload capture**, not just an
after capture. If the fix genuinely stores nothing, say so in the report and
name what makes it stateless.

**The Feature Map entry is enforced.** It was the one step of this gate nothing
checked, and twelve shipped tasks produced exactly one entry. The reviewer
records what it wrote — `kanban.ts feature <task> --file <path>` — and the move
into `Review` is refused unless that file exists, has real content, lives in the
map, and was **modified at or after the task's `implementing` stamp**. That last
clause is the point: a task naming a good entry some EARLIER task wrote is the
failure this catches, and existence alone cannot see it.

An entry is four H2s and nothing else: `## Sub-features`, `## How to get to it
(user POV)`, `## Driving it`, `## Gotchas`. "Driving it" names the product's own
URL — `:31417` for chat, the task's `VITE_PORT` for chart. Chart entries live in
the chart map (`references/features-charts` → `openmarket-charts/Feature Map/`);
`kanban.ts` picks the root from the task's `product`.

A fix that touches no user-reachable surface declares that instead —
`kanban.ts feature <task> --none "<why>"` — which is recorded in `tasks.json`
and rendered on the card, so a waiver is visible rather than habitual. It is a
SEPARATE declaration from the note's "No UI surface": a change can be invisible
and still teach the map something, and a visible one still needs its screenshot.

- **PASS** → the reviewer pushes nothing. The **owner** ships: it writes its PR
  section, runs `train.ts ship` onto its surface's batch PR, **re-runs its
  scoped tests on the rebased train tip** — required, because the verifier
  graded the owner's own branch and not the train it lands on — and ships with
  `--verified`, which writes `mrUrl` + `train`. Then report the batch PR +
  evidence to Nicholas, status `shipped`, card → `Review`, remove the worktree
  (`git worktree remove "$WORKTREE"`). → `trains.md`
- **FAIL** → exactly one retry: append `evidence/<seq>/review-fail.md` to the
  codex prompt, re-run codex, re-spawn the reviewer. A **second** FAIL is
  terminal: status `failed`, card → `Need Attention`, surface everything.

The task owner and its reviewer must write to **distinct** evidence paths —
`verify-report.md` for the owner, `verify-report-<agent>.md` for the reviewer.
They ran concurrently on 6658 and the reviewer's independent numbers were
overwritten; the whole point of a second opinion is lost if it lands on the
first one's path.

Known-noise, do not misread — but **verify it rather than reciting it**. The
durable rule is the comparison: run `main`'s workflow at the same base, compare
**per-step conclusions**, and require the PR's failure set to be a **subset**,
never that it be green.

```bash
gh api repos/openmarket-xyz/openmarket-chat/actions/runs/<id>/jobs \
  -q '.jobs[].steps[] | "\(.number) \(.name): \(.conclusion)"'
```

The specific conditions rot fast, and two of them already have. As of
2026-09-02 (T15, measured on PR #715): the Actions budget was **not** exhausted
and `main` did **not** die at Typecheck — both runs went 1–10 green and died at
**Lint**, with `Test` skipped, step for step identical. Earlier the same day
the budget genuinely was exhausted and checks failed in seconds with no steps
run, and before that `main` died at Typecheck on a rooms-client symbol that was
never published (`e95b7eb7`). All three states are real; which one is current is
a measurement, not a memory.

The trap this note exists to prevent: `Test` is frequently **skipped** because
the workflow stops at the first failing step, so a green-looking or red-looking
PR check may carry **no test signal whatsoever**. Every test number in a verify
report must therefore be local.

### (chart lane) both arms are the reviewer's own `pnpm dev`

There is no daemon, no `OM_ROOMS_GUI_DIR`, no prebuilt `dist/` and no shared
instance to borrow, so the two preceding subsections do not apply. The reviewer
runs `pnpm dev` on its own `VITE_PORT` in each of the owner's two worktrees —
base and fix — which the owner keeps until the review is done.

What DOES carry over is the guard, and it is the whole reason those subsections
exist: prove which commit each arm is actually serving, from that worktree's own
HEAD, before you measure anything with it. An arm you cannot tie to a commit is
void either way.

