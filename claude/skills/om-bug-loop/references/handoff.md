# What you hand back

*A reference for `om-task`. The agent file carries the contract and the decision rules; this file carries the how. If the two ever disagree, the agent file wins and this one is the bug.*

Three parties touch this task and none of them reads your transcript. Each handoff carries a **packet**, not a conversation — the artifact holds the detail, the packet holds the state, and the plan holds the reasoning. Write it to `$EVIDENCE/handoff.json` and update it at each boundary:

```json
{
  "ref": "T74",
  "from": "om-task",
  "to": "codex | om-verifier | coordinator",
  "product": "chat",
  "objective": "one sentence — the result, not the activity",
  "autonomy": "L2",
  "artifacts": { "plan": "…/plan.md", "evidence": "…/evidence/T74/",
                 "worktree": "…", "base": "<merge-base sha>", "head": "<sha>" },
  "decisions": ["chose the mapper fix over widening the guard — plan §3"],
  "constraints": ["no new dependency", "assertion at foo.test.ts:88 must change"],
  "ruled_out": ["the session cache — proven irrelevant, plan §2.1"],
  "open_questions": [],
  "next_gate": "full-suite failure-set diff"
}
```

Two fields do the work nobody else can reconstruct. **`ruled_out`** is the one agents drop: a dead end that was not written down gets re-run by the next reader at full price. **`decisions`** is what makes a diff legible to the verifier — it reads the code, but it cannot read why the other option was rejected.

A packet is cheap to write and it is the only thing that survives you. Everything else in your head is gone the moment the turn ends.

## Return contract — artifacts, not narration

The filesystem is the shared memory. Everything you learn goes into a file the
next reader can open; your **report** is a pointer sheet, not the findings.

**Your final message is at most ~20 lines.** A verdict, the artifact paths, and
anything that genuinely cannot be a file (a question for Nicholas, a decision
you need). Nothing that is already written down. A 600-word report costs the
orchestrator real context to hold the same information a path would have given
it for eight tokens.

Write the durable record as you go, not at the end:

- **file:line references, always.** `src/foo.ts:412` costs eight tokens and buys
  the next agent one targeted read instead of a broad exploration. This is not
  documentation hygiene — it is what makes handing work off affordable.
- the exact command that reproduces, copy-pasteable;
- the actual failing assertion, quoted;
- which commit you read and which **bundle** you drove, with its built-at stamp;
- what you verified, what you could NOT verify, what you deliberately excluded;
- **what you ruled out, and why** — a dead end nobody wrote down gets re-run by
  the next agent at full price.

The last one is the one agents drop. An investigation's conclusion is cheap to
pass on; its *judgement* is not, and it is lost by default unless you write it.
A trap found by reading a mapper, an alternative rejected for a reason not
visible in the diff, a measurement that surprised you — those belong in the
plan or in `PROVENANCE.md`, because no successor will rediscover them.

---

# The verifier's return contract

*Applies to `om-verifier`, not to the task owner.*

The filesystem is the shared memory. Everything you learn goes into a file the
next reader can open; your **report** is a pointer sheet, not the findings.

**Your final message is at most ~20 lines.** A verdict, the artifact paths, and
anything that genuinely cannot be a file (a question for Nicholas, a decision
you need). Nothing that is already written down. A 600-word report costs the
orchestrator real context to hold the same information a path would have given
it for eight tokens.

Write the durable record as you go, not at the end:

- **file:line references, always.** `src/foo.ts:412` costs eight tokens and buys
  the next agent one targeted read instead of a broad exploration. This is not
  documentation hygiene — it is what makes handing work off affordable.
- the exact command that reproduces, copy-pasteable;
- the actual failing assertion, quoted;
- which commit you read and which **bundle** you drove, with its built-at stamp;
- what you verified, what you could NOT verify, what you deliberately excluded;
- **what you ruled out, and why** — a dead end nobody wrote down gets re-run by
  the next agent at full price.

The last one is the one agents drop. An investigation's conclusion is cheap to
pass on; its *judgement* is not, and it is lost by default unless you write it.
A trap found by reading a mapper, an alternative rejected for a reason not
visible in the diff, a measurement that surprised you — those belong in the
plan or in `PROVENANCE.md`, because no successor will rediscover them.

## What a verdict carries

**PASS** — report the evidence paths, the failure-set diff, the screenshots, and the Feature Map entry you recorded. Do not push and do not open the MR; the owner ships.

**FAIL** — write a precise failure report to `<evidence_dir>/review-fail.md`: what check, expected vs observed, suspected cause. Push nothing, write no card note.

**(chat lane)** Respect the owner's house rules: no AI attribution, no `git stash`, exact-path staging, the parity fence.
