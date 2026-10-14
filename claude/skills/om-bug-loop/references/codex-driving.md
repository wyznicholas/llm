# Driving Codex

*A reference for `om-task`. The agent file carries the contract and the decision rules; this file carries the how. If the two ever disagree, the agent file wins and this one is the bug.*

**You never write the diff for a plan you wrote.** Every change implementing the plan goes through `codex exec`, including one-line ports and changes you could obviously make faster by hand. **There is no size exception here** — a one-liner is exactly where the exception looks harmless, and granting it once dissolves the rule. The reason is not token cost: you authored the contract, so implementing it yourself means grading your own homework, which is the one thing this pipeline is built to prevent.

**The line is authorship, not size.** Where **no new contract is being authored**, the diff is yours to write by hand, and always was — see the hand steps below. That covers a rebase and its conflict resolutions, a version bump, opening the MR. In those cases the design decision was already made and already verified in an earlier round; you are reconciling someone else's approved work with the tree, not deciding what the fix should be, so there is no homework to grade.

Two obligations when you hand-write a resolution, both firm:

- **Name it as a hand step in your report**, never blurred into the Codex run.
- **If a conflict hunk lands inside the fix's own logic, it stops being mechanical.** Send it to Codex. "Both sides edited the same behaviour" is a design decision wearing a merge conflict's clothes.

Verification is never waived by any of this. A rebase can silently break a fix, and `om-verifier` re-measures either way.

```bash
codex exec --cd "$WORKTREE" --sandbox workspace-write --color never \
  --add-dir "$(git -C "$WORKTREE" rev-parse --git-common-dir)" \
  -o "$EVIDENCE/codex-last-message.txt" "$(cat "$EVIDENCE/codex-prompt.md")" \
  > "$EVIDENCE/codex.log" 2>&1
```

`--add-dir` is **required** — a linked worktree's git metadata lives in the parent repo, outside the sandbox, so write-side git dies with `index.lock: Operation not permitted`.

**That is the ONLY `--add-dir`, and the vault is never a second one.** Codex
*reads* `$PLANS/<REF>/plan.md` (reads are not confined to the workspace, which
is why pointing at the plan instead of restating it has always worked), but it
can write nothing under `~/Documents/Obisidian/`. Keep it that way: a grant
there is a write grant over every note Nicholas owns, renewed on every task.

So **Codex's attempts reach `plan.md` through `-o`, not through the sandbox.**
Point `-o` at the ref's folder and append it under the fence yourself:

```bash
-o "$PLANS/<REF>/codex-last.md"
# then, after the run, in your own call:
cat "$PLANS/<REF>/codex-last.md" >> "$PLANS/<REF>/plan.md"
```

`-o` is written by the Codex CLI, which is not itself sandboxed, so this needs
no grant. The side effect is the property worth having: **Codex cannot edit the
contract above the fence even if it tries**, so "the spec was written before the
code" is enforced by capability rather than by everyone remembering.

**Put `cd` in the same command string**, joined with `&&`. A backgrounded Bash
command whose `cd` sits on its own line runs from the session cwd, so
`test-fast.ts` reports `No test files matched` — indistinguishable from a filter
typo, and it cost T27 a cycle to spot.

**Always redirect stdin**, and never build the prompt file in the same bash call that runs Codex. `codex exec` reads stdin when it is a terminal and will hang there — T26 lost **10 minutes** to exactly that. Write `$EVIDENCE/codex-prompt.md` in one call, run Codex in the next, and append `< /dev/null` to the invocation.

Codex has its own `om-implementer` skill carrying the house rules, installed at
`~/.codex/skills/om-implementer/` as **real files with a local `references/`
folder** — not a symlink into the vault, and deliberately so: a reference that
resolved out to `~/Documents/Obisidian/` would need an `--add-dir` grant, and
under `--sandbox workspace-write` that grant is a WRITE grant over Nicholas's
notes. So your prompt should be short: point Codex at the plan and at that
skill rather than restating them, and do **not** add the vault to its sandbox.

(Corrected 2026-09-11: this paragraph previously described the skill as a vault
symlink and told you to `--add-dir` for it. That had stopped being true.)

Consider one Codex run per plan step group, so each diff is separately reviewable.

**Check the diff's SHAPE, not its contents.** Reading the code line by line is the verifier's job and duplicating it costs you context you will need later. What you check is mechanical and takes one command:

```bash
git diff --stat <base>..HEAD        # files touched, lines moved
```

Compare that file list against the plan's. **A file the plan does not name is scope creep** — either Codex went beyond the contract, or the plan was wrong. Both are yours to resolve before the verifier sees it, and neither is visible in a behavioural test: a seventh file nobody reviewed passes every check that three files would have.

Two other shape-level tells worth a glance at the `--stat` alone: a test file with more deletions than insertions (an assertion may have been removed to make something pass — the plans say amend in place, never delete), and a line count wildly off what the plan implies.

Everything below that — correctness, house conventions, whether the mechanism is right — belongs to `om-verifier`, which reads the contents and is the independent party.

Genuinely non-Codex steps — writing the PR section and running `train.ts ship` (there is no per-task MR to open since 2026-09-15), a version bump, a rebase and its conflict resolutions — are yours, and must be **named as hand steps** in your report rather than blurred into the Codex run.

**Environment**, before anything: read **the environment reference your dispatch prompt names** — `references/openmarket-chat-env.md` for a `product: chat` task, `references/kiyotaka-chart-env.md` for `product: chart`. They differ in package manager, app, ports and gates; never read one lane's and work in the other. Fresh sibling worktree off `origin/main`, never the shared checkout. **Chat: never `bun install`** — private scopes 404 and it destroys the symlink overlay. **Chart: copy `.env` from the shared checkout into the worktree first** — it is untracked, so a fresh worktree has none and vite boots misconfigured in silence. **Capture the baseline BEFORE any edit**; gates are already red on `main`, so the obligation is a failure-**set** diff, never a green gate. Never `git stash`, never `git add -A`, `grep -a`, no AI attribution anywhere. Namespace every scratch path by task ref.

**Your own test runs are scoped only** — the component you changed. **(chat lane)** `bun tools/test-fast.ts --shards 2 <path-filter>`. **(chart lane)** `pnpm vitest run --config vitest.node.config.ts <path-filter>`.

**Scope your own test run by the TRANSITIVE importer closure**, and read
`~/.claude/skills/om-bug-loop/references/test-scoping.md` before you build the
filter — it is four rules long and every one of them was paid for by a task
that shipped a scope one hop too short. In brief: walk the importer graph until
it stops growing; stop at an app root and switch to symbol scoping; add every
construction site of an interface you widened (**fixtures and casts included** —
no importer walk reaches those); add by name any invariant you moved. Then
**say in your report where you bounded it and why**, so a narrow scope reads as
a decision rather than an omission.

 **`--shards` is a `test-fast.ts` flag, not a `bun test` one**: `bun test --shards 2 <path>` does not error, it reads the bare `2` as another path filter and silently runs unrelated files. That is your inner loop and is **not** regression evidence. The full suite belongs to the verifier.

