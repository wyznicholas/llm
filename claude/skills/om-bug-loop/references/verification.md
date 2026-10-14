# Verification, and shipping onto the train

*A reference for `om-task`. The agent file carries the contract and the decision rules; this file carries the how. If the two ever disagree, the agent file wins and this one is the bug.*

1. Spawn `om-verifier` **BLOCKING** (`run_in_background: false`). Tell it its **final message IS its verdict** — a background verifier's report surfaces to the coordinator instead of to you, and you will wait forever for a message that never arrives. That has happened on three tasks.
2. On PASS, read the verifier's evidence-audit section before you accept the verdict. The `om-evidence-auditor` agent that used to run here was removed 2026-09-08 at Nicholas's request, and the measurement behind that decision is worth knowing: across one batch it returned FAIL roughly 19 times and **never once found a defect in the code** — every finding was in the write-up. It was a write-up gate, not a correctness gate, and the verifier now carries that obligation itself. So the standard has not moved: an overclaim is still a FAIL, and the evidence gets fixed and re-run rather than argued. What changed is that nobody is checking the checker, which means **you** are the last reader of the evidence before Nicholas is.
3. **Refetch `main` BEFORE you spawn the verifier.** A rebase after verification invalidates what was just verified, and you will either re-run it or ship on stale proof. T23 verified, then rebased across **six** commits that had landed under it, and paid **25 minutes** to redo the conflict resolution honestly. Rebase first, verify second.
4. **On FAIL, send it back to Codex** with the failure report appended to the prompt, then re-verify. **This is bounded: exactly one retry** — but only a FAIL that requires a **code change** consumes it. A FAIL on records — a missing header, an unbanked number, an overclaimed sentence — is fixed in the evidence and costs nothing from the budget, because it changes no behaviour and needs no re-implementation.

   That distinction exists because the harsh version produced waste: T23 ran the **full suite itself**, duplicating the verifier, purely because it had spent its retry and could not risk a second FAIL. Defensive over-verification is what a brittle bound buys. The full suite is the verifier's; run yours scoped and trust the split. A second FAIL is terminal — status `failed`, card to `Need Attention`, surface everything. A full-suite regression bounced back to you consumes that same retry. Without the bound this loop runs forever and nobody notices.
4. You and the verifier write to **distinct** evidence paths — `verify-report.md` is yours, `verify-report-<agent>.md` is the verifier's. They have collided and destroyed the second opinion before.

**Before the card can reach `Review`:** before/after screenshots on the same viewport, on the shipped commit and its real merge-base, copied into the vault and embedded with vault-relative full paths — **view every image before embedding it**, a wrong build has been installed as a `before` frame and only looking caught it. A change with genuinely no visual surface says **"No UI surface"** and why. Card note from the template via `kanban.ts note <task> --file <md>`, with `## Work items` one box per plan step **verbatim**; never hand-write between the `om-bug-loop:status` markers. Feature Map entry via `kanban.ts feature <task>`.

Then ship onto your surface's train — **never `gh pr create`, `glab mr create`, or a direct forge call** (2026-09-15). Write your PR/MR section to `$EVIDENCE/<ref>/pr-section.md`, run `train.ts ship <ref> --surface <key> … --test-cmd "<runner prefix>" --test-list "$EVIDENCE/<ref>/scoped-tests.txt"` (one test path per line), re-run your scoped tests on the rebased tip with the command it prints, and ship with `--verified <log>`. That pushes without force, creates or regenerates the batch PR/MR on the forge selected from `origin`, and writes `mrUrl` + `train` into `tasks.json` itself; backfill `branch`/`worktree` the same read-modify-write way, and remove the worktree only after the card reaches `Review`. → `trains.md`


## A rebase that does not change your diff does not need re-verifying

Prove it rather than assuming it: after rebasing, confirm your **source delta is
byte-identical** — compare the patch, or hash the changed blobs on both sides.
If it is identical, re-run **only what the incoming commits actually touched**,
not the whole gate set. T25 and T29 both proved delta identity and then re-ran
everything anyway.

If the delta is *not* identical, the rebase changed your change: treat it as new
work and re-verify properly.
