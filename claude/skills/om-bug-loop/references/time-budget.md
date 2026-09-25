# The hour, and where your turn ends

*A reference for `om-task`. The agent file carries the contract and the decision rules; this file carries the how. If the two ever disagree, the agent file wins and this one is the bug.*

**Deliver inside one hour, and have a good reason if you cannot.** The target for a task like this is **30-45 minutes**; an hour is the line past which you owe an explanation. This is a budget you manage from the start, not a number you are graded on at the end.

**Budget the phases up front.** Roughly: setup and baseline ~10 min, Codex ~15, capture ~5, verify ~15, ship ~5. Write your own estimate down when you start, so you can see divergence rather than discover it.

**Checkpoint at ~40 minutes, and it is YOURS to enforce — nobody can enforce it for you.** If you are not close to spawning the verifier by then, stop and decide — do not simply continue and explain later. Either cut discretionary work, or **declare the overrun and its reason now**, in a short interim message, rather than at the end. A coordinator told at 40 minutes can re-scope; one told at 2h30 can only record it.

**The checkpoint is yours because nobody else's can reach you.** A coordinator message drains only at a tool round, and a blocking verifier holds you for tens of minutes — on T32 the 40-minute checkpoint landed ~90 minutes late, every question already answered by events. So: when the clock passes 40 minutes and you are not close to shipping, end your turn with a short interim report — where you are, what is left, your current estimate — and let the coordinator re-scope before you spend another hour. Ending a turn is cheap and fully resumable. An unbroken three-hour turn that reports at the end is not diligence, it is a decision taken away from the person who was supposed to make it.

**What you may cut to protect the hour:** captures beyond the declared matrix, exploratory re-runs, polish on wording, any second look you cannot name a reason for.

**What you may never cut:** the verifier, its evidence-audit pass, the failure-set diff, and evidence for a visible change. **Shipping unverified to make the clock is a far worse failure than being late** — nothing in this rule asks you to trade correctness for speed, and an owner that does has misread it.

**Good reasons to be over**, stated plainly and without apology:

- a **real regression** was found and fixing it cost the time — that is the process working, and it would happen again;
- the surface is genuinely large, and the plan said so before you started;
- `main` moved under you and a rebase invalidated verified work;
- the environment blocked you in a way you could not have anticipated.

**Bad reasons, which are process defects and must be named as such:**

- re-shoots caused by an uncontrolled capture — a stray pointer, a leftover tooltip, an unblurred focus ring;
- duplicating work that belongs to the verifier because you were hedging;
- sweeping an unbudgeted evidence matrix;
- a scoped test run too narrow to catch what the full suite then found.

Every one of those has cost a real task real time, and each already has a rule against it. If you hit one anyway, say so — that means the rule is not working and it needs changing, which is worth more than your individual task being on time.

**If you pass the hour, the account is mandatory and unprompted**, in your final message: minutes per phase read off **artifact timestamps** rather than estimated, the specific event that caused the overrun, which of it was genuinely necessary, what would have prevented the rest, and anything the process made you do that was not worth doing. It is a measurement, not a defence — "it needed the time and would again" is a complete and acceptable answer.


## Your turn ends at "commits on the train, verdicts banked"

**Do not do the coordinator's paperwork.** When `train.ts ship --verified` has
exited 0 — your commits are on your surface's open batch PR, and it has written
`mrUrl` and `train` — the verdicts are banked, the card note is written and the
Feature Map entry recorded — **stop and report**. The coordinator moves the
card, backfills `branch`/`worktree` and sets status; those are its files, and it
does them in seconds. The batch PR's mergeability is the train's, not yours.

This is measured, not tidiness: T27's PR was mergeable while it spent a further
~40 minutes on bookkeeping, and the coordinator then did that bookkeeping in
under a minute. Every task today ended with the code long since correct.

---

# The verifier's phase

*Applies to `om-verifier`, not to the task owner.*

The owner is accountable for delivering the whole task inside **one hour**, and verification is the phase that most often breaks it — on one measured task the retry alone cost **42 minutes**, more than first verification, because you re-derive everything.

So be economical where it costs nothing: run both arms on two daemons at once rather than swapping one, take the declared matrix and stop, and reuse the owner's `dist/` instead of rebuilding. **Do not economise on the measurements themselves.** A verification that misses a regression costs far more than it saved — the whole point of your independence is that you are the last chance before something ships. If doing the job properly puts the task over the hour, do the job properly and say so.


## Over an hour? Report why, unprompted

If your task passes **one hour** of wall clock, you owe Nicholas a timing account in your final message — whether or not anyone asks. His words: *"once any task takes more than 1 hour, it needs to report back to me what is the root cause, what it is taking long on, and how to improve; if it genuinely needs that time, that is fine, if not, then we need to change the process."*

The target for a task like this is **30-45 minutes**. Give:

- **Where the wall clock went**, in minutes per phase, read off **artifact timestamps** rather than estimated: setup, Codex, capture, verify, audit, retry, ship.
- **The root cause of the overrun** — the specific event, not a category. "Verification is slow" is useless; "a stray pointer left a tooltip over the control capture A exists to prove, forcing a bespoke re-shoot" is actionable.
- **Which of it was genuinely necessary.** Catching a real regression is worth its cost. A re-shoot caused by an uncontrolled frame is not. Separate them honestly — an "it needed the time and would again" is a completely acceptable answer and must not be dressed up as a failure.
- **What would have prevented each**, specifically and mechanically enough to become a rule.
- **Anything the process made you do that was not worth doing.** Only you can report this. If a rule cost you time and bought nothing, name it — the process is meant to change when that happens.

This is a measurement, not a defence. Two standing rules already exist because tasks reported this way: the capture-hygiene preamble, and transitive test scoping.

