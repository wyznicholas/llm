# Linting your own report before you deliver it

*A reference for `om-verifier`. The agent file carries the contract and the verdict rules; this file carries the how. If the two ever disagree, the agent file wins and this one is the bug.*

You are the pipeline's largest single cost (19-48 min measured), and until now you reported only a total. That gap got filled by guesswork: a coordinator subtracted your suite time from your total and attributed the residual to build-and-boot — a phase you are explicitly told not to pay, and which costs seconds. Nearly a day of tooling was almost aimed at it.

So mark your boundaries as you cross them:

```bash
bun ~/.claude/skills/om-bug-loop/scripts/phase.ts mark "$EVIDENCE" "setup"
bun ~/.claude/skills/om-bug-loop/scripts/phase.ts mark "$EVIDENCE" "base suite"
bun ~/.claude/skills/om-bug-loop/scripts/phase.ts mark "$EVIDENCE" "fix suite"
bun ~/.claude/skills/om-bug-loop/scripts/phase.ts mark "$EVIDENCE" "repro flip + captures"
bun ~/.claude/skills/om-bug-loop/scripts/phase.ts mark "$EVIDENCE" "static gates"
bun ~/.claude/skills/om-bug-loop/scripts/phase.ts mark "$EVIDENCE" "report"
bun ~/.claude/skills/om-bug-loop/scripts/phase.ts mark "$EVIDENCE" "done"      # closes the last phase
```

A mark is a **checkpoint, not a start/end pair** — pairs get orphaned by retries, checkpoints cannot. A phase runs to the next mark, so always end with `done`. **Mark a retry too** (`"base suite (retry 2)"`), because retries under machine contention are the one cost we have hearsay about and no data.

Render it with `phase.ts report "$EVIDENCE" --md` and paste that table into your report's timing account. `phases.jsonl` is a bankable artifact, so cite it — a timing account with no artifact behind it now fails the lint below.


## Lint the report

`om-evidence-auditor` is retired. The half of its job that was mechanical is now a script, and running it is **mandatory before your verdict**:

```bash
bun ~/.claude/skills/om-bug-loop/scripts/verify-lint.ts "$EVIDENCE/verify-report-om-verifier.md" --evidence "$EVIDENCE"
```

It fails on three things, all of which the auditor caught for real: a **claim with no artifact anywhere in its section** (the exact shape of "mergeable" asserted in prose), a **cited artifact that does not exist** (it caught a live typo — `baseline-reverify-om-verifier.txt` for `test-baseline-reverify-om-verifier.txt`), and a **citation into a worktree** rather than the evidence dir, which stops being re-derivable the moment the worktree is removed.

Fix findings by **banking the artifact or deleting the claim** — never by rewording around the check. And know its limit: it cannot tell that a number was extracted *wrongly* from a real file. T54's owner under-counted failures with a column-anchored grep while citing the correct artifact, and this lint would pass that report. Deriving a headline number twice by different means is still on you.


## Self-audit — run this against your own draft

An adversarial pass reads your report next. Across one batch it ran ~24 times and returned **FAIL ~19 times**, and **never once found a defect in the code** — every finding was in the write-up. Those failures are enumerable, so check for them yourself first. Each round trip you save is a serialized hop off the task.

Go through your finished draft and answer these about **every claim in it**:

1. **Did I measure this number, or carry it?** Anything inherited from the owner, from an earlier arm, or from a previous run of your own is carried. Say which. A carried figure is not wrong, but presenting it as measured is.
2. **Does every artifact I cite still stand up?** If it was produced against a worktree or build you have since deleted, it cannot be re-derived — re-run it, or copy its inputs into the evidence dir so it stands alone.
3. **Every "identical" / "unchanged" / "byte-identical" claim — did I hash it?** Eyeballing two outputs is not a comparison. Bank both hashes.
4. **Every count and every set — can I reproduce the command that produced it?** Run it again and diff. This is where a denominator silently understates its own coverage: one report claimed 40 related test files when the honest set was **70**, because the selection missed every test reached through a dynamic import.
5. **Are any two captures byte-identical across states that should differ?** That is not a coincidence, it is a **capture that never happened** — a file named for a cell it never covered. One report cited a "retry" image that was byte-identical to a different width's crop.
6. **Does each load-bearing artifact carry its provenance inside the file?** Arm, commit, blob hash, stamp — in a header, not asserted in prose beside it. The file carrying your central claim is the one that most often lacks it.
7. **Is every figure backed by an artifact?** A ratio or a timing that exists only in a sentence has no evidence behind it.
8. **Is every assembled number's composition stated?** If a total is a sum, a filtered subset, or a merge of two runs, say so. A true number assembled in an undisclosed way still misleads.
9. **Did I apply each correction everywhere?** Before fixing a claim, **list where it appears** — your report, the card, the PR body, the plan, the artifact itself — and fix every one. T27 corrected a false lint sentence in its card and left it live on the PR, so the next audit pass failed on a document it had already fixed elsewhere. Its own words: *"fixing records in two places without a checklist of where a claim appears is a real defect in how I work."* Report, card note, PR description, and the artifact itself. One report was fixed in a single document while the card and the live PR description still carried the wrong claim.
10. **Is everything I could not run labelled a gap?** A missing check that reads as a passing one is the worst failure here. Name it and say why.
11. **Did a correction of mine overshoot?** A fix to a flawed claim can land on a new wrong claim. Re-check the replacement, not just the removal.

**Emit an artifact manifest, not a sentence claiming completeness.** End your report with a table of **figure -> file**: every number you cite, and the artifact it came from. Prose asserting "every figure is backed" is itself an unbacked claim, and that same sentence shape has failed audit twice on one task — 15 minutes of remediation over two passes, for a claim a table would have discharged in one line.

**State in your report that you ran this**, and name anything it caught. A self-audit you claim but did not perform is itself an overclaim, and an audit is about artifacts rather than assurances.

**This pass is now the last one.** The separate read-only `om-evidence-auditor` that used to re-read your report was removed 2026-09-08, so nothing downstream will catch an overclaim you leave in. Give it the adversarial reading the auditor would have: for each figure you cite, name the artifact it came from, and ask whether the check you ran actually establishes the claim you made from it. A spec that asserts a thing *exists* but never where it sits on screen passes every DOM check while the feature is broken — that is a real T59 finding, and **every image must be opened and looked at**, not merely captured.

