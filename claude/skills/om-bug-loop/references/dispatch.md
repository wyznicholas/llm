# Intake and dispatch

*A reference for the `om-bug-loop` coordinator. `SKILL.md` carries the policy and the decision rules; this file carries the mechanics. If the two ever disagree, `SKILL.md` wins and this one is the bug.*

## Routing — the card's tag decides, before anything else

Four lanes leave this step, and they never converge again. **The watcher has
already decided** and written the answer onto the pending file as `route` — do
not re-derive it from the title.

| tag | `route` | ref | ends in |
|---|---|---|---|
| `#human` | `skip` | — | nothing. Filtered in the watcher; no pending file is ever written |
| `#research` | `om-research` | `R<n>` | a filed architecture doc, and a decision Nicholas makes |
| `#pa` | `om-play-around` | `T<n>` | polish findings filed as new `#bug` cards |
| `#bug` | `om-task` | `T<n>` | its commits on its surface's open batch PR (`trains.md`) |
| *no tag* | `om-task` | `T<n>` | **identical to `#bug`**, not a separate case |

The policy is one function — `route()` in `scripts/routing.ts`, with
`routing.test.ts` behind it. **Change it there, never in a dispatch prompt**: a
rule that lives in a prompt is invisible the next time it misroutes.

There is no text classification and no heuristic. Nicholas's tag is the whole
input, and an untagged card is a defect by policy, not by guess.

Neither owner converts itself. An `om-research` owner that finds a reproducible
defect parks in one line for promotion to `om-task`; an `om-task` owner that
finds two readings parks under SKILL §4. The coordinator re-dispatches — that
way one misroute costs a park, not a wasted build.

## Per pending card

1. Append the slug to `state.json.dispatched` (atomic: write tmp + rename) so the
   watcher never re-offers it, and delete the pending file.
2. The slug and `lineNo` come from the pending file. Do not re-slug the title —
   the watcher's slug is what `dispatched` now holds.
3. Assign the ref from the card's `route`:
   `bun scripts/kanban.ts next-ref` → `T<n>` for `om-task` and `om-play-around`;
   `bun scripts/kanban.ts next-ref --research` → `R<n>` for `om-research`.
   Never pick the number by hand — `next-ref` returns `max(issued) + 1` **within
   that namespace**, so a skipped task burns its number forever (SKILL §6) and
   capturing research can never consume a task number.
4. **Consume the card** — rewrite Nicholas's line into a pipeline card, in place:

   ```
   bun scripts/kanban.ts consume <lineNo> --ref <ref> --slug <slug> [--title "<short>"] [--product chart] [--tier trivial|normal|hard]
   ```

   **`--tier` is your judgement from the card and its note (SKILL §2a)** —
   `om-task` and `om-feature` cards only. The tool applies his `#trivial` /
   `#hard` tag and the category floor on top, records the result, and tells you
   on stderr when the floor raised your call. Omit it when unsure: that is
   `normal`.

   This writes the `tasks.json` entry, stamps the card and rewrites the board
   line, preserving every tag, image embed and wikilink he put there. Do it
   BEFORE spawning: a consumed card with no agent is visible and recoverable; an
   agent working a card with no ref is neither.

   **`--title` when the line's own title is over 60 characters** — which the
   tool will tell you, by refusing. A title is a handle, `<surface>: <symptom>`,
   enough to pick the card out of forty; the brief lives in the note. You are
   the right party to make that cut because you are holding the whole line, and
   a machine cut at sixty characters lands mid-word.

   Cutting loses nothing. The text you replace is written into
   `cards/<slug>.md` under `## Problem` — the same heading
   `$TEMPLATES/card-note-template.md` uses, so the owner extends that note
   instead of re-deriving the brief from a title. A note that already exists is
   never touched: `om-play-around` files one with every finding, and that one is
   richer than anything the line could carry.

   Refusal is atomic — nothing is written, the ref is not burned, and the card
   is still there to consume with a title.

   A pending file with `route: "skip"` is a bug in the watcher, not a card to
   handle — say so rather than dispatching it.

**There is no chat context to read.** Board cards have no reply thread, so the
`topic-context.ts --todo <seq>` step does not apply and must not appear in a
dispatch prompt. The card's own text plus any image Nicholas pasted onto the
line is the whole brief.

5. Spawn the agent named by `route` **and the tier `consume` recorded**:
   `trivial` → `om-quickfix` (prompt below); `normal` → `om-task` / `om-feature`
   with `model: "sonnet"`; `hard` → the same with no `model:` (its frontmatter
   carries Opus). Say the tier in the prompt's first line. For `om-task`, in the background. Tell it plainly that it is at
   **the whole task: investigate, plan, implement, verify, ship — parking only
   on a stop condition.** Give it SKILL §4 and §5 verbatim in the prompt; the
   stop rule is the one thing it must not have to infer. Its prompt embeds:
   - the card JSON from the pending file,
   - the contents of `references/api.md`,
   - **the chat context command** —
     `bun ~/.claude/skills/om-bug-loop/scripts/topic-context.ts --todo <seq> --window 40`
     — with the instruction that **the title is never the whole task**: read
     the reply thread, the surrounding conversation, who else hit it, and any
     maintainer notes ("still making changes to search") before deciding what
     the bug is,
   - locate the code via the global graphify graph plus targeted grep
     (`grep -a` in openmarket-chat — NUL-poisoned files skip silently).
     > **Superseded 2026-09-14 (Nicholas): owners may change any repo the task needs.** The two-tier table below is
     > history. Fix wherever the proven cause lives, one PR per repo, with the deploy order stated and both
     > old/new pairings proven. `openmarket-chat-cloud` stays out of scope unless Nicholas says otherwise.

     **Repo scope was two-tier.** *Fix repos* are where a Codex diff may land,
     and they follow the task's `product`:

     | product | fix repos |
     |---|---|
     | `chat` | `openmarket-chat`, `rooms-client`, `kiyotaka-chat-service` |
     | `chart` | `kiyotaka-frontend` (package `kiyotaka-chart`), `titan-charts` |

     *Read repos* are **anything cloned under `~/Documents/GitlabRepos/`**,
     unrestricted, for tracing a root cause — the user-data backends
     `auth-service-backend`, `tharamine-user-service` and `orange-v2-backend`
     especially, since they sit behind both products.

     **For a `chart` task those three are not optional — they are part of the
     lane.** Watchlist data is *stored* in them (Nicholas, 2026-09-09), so the
     frontend renders rows it does not own: an empty price, a `$0`, a missing
     column can be a storage, serialization or symbol-key defect on the backend
     side and look identical to a render bug from inside `kiyotaka-frontend`.
     A chart investigation that never opened them has not ruled anything out.
     Name them in every `chart` dispatch prompt. Nicholas, 2026-09-09:
     *"if anytime u need to have access to more repos, they are probably already
     cloned, feel free to look at the repo when necessary."* The global graphify
     graph (`~/.graphify/global-graph.json`) already indexes all of them, so
     reading widely is nearly free. Stopping at a repo boundary and writing
     "probably a backend issue" instead of proving it is the failure this tier
     exists to prevent.

     **A message-content fix is never client-only until you have proved it.**
     (Nicholas, 2026-09-09.) A forwarding-message bug was fixed in the client
     and shipped; the server side was never touched, so the forwarded content
     was never persisted — and on the next reload it was **already missing**.
     The render was right and the data was gone.

     So for anything touching DMs, forwards, replies, quotes, attachments or
     message content generally, the investigation MUST cover the write path as
     well as the render path: what is persisted, by which service, in what
     shape, and whether the field you are rendering survives a round trip.
     `kiyotaka-chat-service` and the user-data backends are where that lives.
     "The client renders it correctly" is not a finding about persistence, and
     a plan that only names client files for a content bug is incomplete.

     The verification that catches this is cheap and is now mandatory (`review-gate.md`):
     **reload the app and look again.**

     A fix that must land in a read repo is a **follow-up task**, under the SKILL §7
     second-repo rule. `openmarket-chat-cloud` remains out of scope entirely
     (Nicholas, 2026-09-08).
   - **the environment reference for this task's product** — `chat` reads
     `references/openmarket-chat-env.md`, `chart` reads
     `references/kiyotaka-chart-env.md`. Name the path in the prompt; the agent
     must not pick one by guessing,
   - **the browser driver**: agent-browser, with sessions named from the ref
     (`<ref>-repro`, `<ref>-base`, `<ref>-fix`) the same way ports and homes
     are, and Playwright only for the steps `references/browser-driving.md` §0
     keeps on it. This applies to dispatches from 2026-09-15; **do not tell a
     task already in flight to switch** (F51 and T179 finish on Playwright),
   - **reproduce and screenshot**: drive the real app and capture the bug
     happening → `evidence/<seq>/repro.png`, labeled `own-repro`. For `chat`
     that is the daemon at http://localhost:31417; for `chart` it is
     `pnpm dev` on `VITE_PORT=80NN` in the agent's own worktree — there is no
     shared instance, and local charts default to MOCK data, so a data bug may
     not reproduce locally at all. If repro is infeasible, pull a frame from the
     reporter's video (`qlmanage -t -s 1400 -o <dir> <file.mov>`; ffmpeg is not
     installed here) and label it `reporter-video-frame`, saying why repro
     failed,
   - fill every section of `templates/plan-template.md` and write it to
     `~/.claude/om-bug-loop/plans/<seq>-<slug>.md`. The **Verification spec**
     is written before any code exists — it is what defines "working", not
     Codex.
6. Status `investigating`.


# Tasks Nicholas creates directly

The watcher is not the only way in. When Nicholas describes a bug in chat —
with or without saying "make this a task" — treat it as a task and dispatch it
exactly like a fired to-do. He should never have to go promote a to-do in OM
Chat to get work started here.

**Classify the product before dispatching, and say which you chose.** Every task
carries `product: chat | chart`, in this precedence:

1. **Nicholas said so.** "chart bug:" / "chat bug:" wins outright.
2. **The surface named.** Watchlist, workspace, chart, indicator, alert, symbol,
   scanner, orderbook, market → `chart`. Room, topic, DM, message, space,
   member, thread, doc → `chat`.
3. **Ambiguous → ask.** One question, never a guess.

**The digest states the classification** — "T61 · chart · kiyotaka-frontend" —
so a wrong call costs one word to correct, before an agent has spent forty
minutes in the wrong repo. Intake is unchanged: the watcher still polls ⌗ OM
Chat Bugs only, so chart bugs arrive through this section, not through it.

Differences from the watcher path, and nothing else:

- No `pending/` file and **no `dispatched` entry** — there is no to-do seq to
  suppress, and a manual task must never write one (the watcher would then skip
  an unrelated real to-do at that seq).
- `tasks.json` entry has `id: null` and `source: "manual (Nicholas, in session)"`,
  so the timeline and `status` output can tell the two origins apart.
- Plan path is `plans/manual-<slug>.md` (no seq to name it by).
- The investigator gets the request **verbatim** — his words are the report, and
  the same rule applies as for a to-do title: it is never the whole task.

Everything downstream is identical: investigate → digest → implement → verify
→ ship, parking at any point on a SKILL §4 condition.

**Check whether it was already reported.** A bug Nicholas notices has often
already been raised in ⌗ OM Chat Bugs and simply never promoted (the "blocked
messages on a slow connection" task was reported by @KarlilOP on 2026-08-24
with a screen recording). Tell the investigator to go find it: that gets you a
reporter's video, a date, other people hitting it, and sometimes a maintainer's
note — all of which the request alone lacks. `topic-context.ts --todo` keys off
a to-do create seq, so for a manual task the agent walks history by `beforeSeq`
filtered on the topic instead.


# Dispatching, and the load gate

**You dispatch; you do not prepare.** Worktree creation, the node_modules
overlay, environment repair, the baseline gate run, filling the Codex prompt
and running Codex are all the task owner's job — the **same `om-task`** that
investigated it, carrying straight on from its own digest. It no longer ends
its turn there and no longer needs resuming; you resume it with `SendMessage`
only to **steer** it (SKILL §10) or to release one you parked. Doing
them inline burns the coordinator's context on exactly the work this pipeline
exists to delegate, and a coordinator that is 40 tool calls deep in a build
cannot hold the gate for the other tasks. (Learned the hard way on 2026-09-01,
to-do 6658.)

## The `om-feature` prompt

Same spine as an `om-task` prompt — lane, environment reference, worktree rules,
Codex, verifier — with three differences that matter:

- **`$TEMPLATES/feature-plan-template.md`**, named by path. The six sections are
  ordered so each is answerable only once the one above it is settled, and an
  agent that writes acceptance criteria first will reverse-engineer a problem
  statement to match them.
- **The acceptance-criteria rule, verbatim**: written before Codex sees
  anything, and not edited afterwards. It is the one invariant that is invisible
  in a diff — a criterion quietly rewritten to match what got built looks
  identical to one that was always right, and it is the feature lane's version
  of grading your own work.
- **The Feature Map entry** for the surface being changed, if one exists
  (`Obisidian/openmarket/Feature Map/`). It carries the drive instructions and
  saves a cold exploration; its absence is worth knowing and worth saying.

**Do not name the solution in the prompt.** A dispatch that says *"add a
copy-link button to the message context menu"* has already designed it, and what
comes back is a justification rather than a design — including when the feature
already exists three menus away and the right answer was to surface it. Give the
problem and the surface; let the investigation choose.

**Say nothing about size.** Slicing is `om-feature`'s judgement and size is not a
stop condition. A prompt that says "this is a big one" invites a park that the
stop rule does not permit.

## The `om-quickfix` prompt

Short, because the definition carries the method. It embeds:

- **the card and its note**, the ref, the lane and its environment reference path;
- **the pinned `codex exec` invocation** and the instruction to implement through
  it — the trivial tier is exactly where "I could just fix this by hand" looks
  harmless, so the rule is stated, not implied;
- **`references/trains.md`** and the surface key when the note carries one;
- **the escalation contract, verbatim**: `kanban.ts tier <ref> normal --why "…"`,
  `PROVENANCE.md`, stop, final message `ESCALATED <ref> → <tier>:`. It is not a
  failure, and it is not a park.

Do not tell it the fix is easy or small. The tier already says so, and repeating
it is pressure against the escalation the tier depends on.

**An `ESCALATED` final message is a re-dispatch, not a park.** Re-run the load
gate, then dispatch `om-task` / `om-feature` at the new tier with this extra
line: *"Escalated from `<old tier>`: read `$PLANS/<REF>/PROVENANCE.md` first and
reuse its worktree."* No `Need Attention`, no ping.

## The `om-research` prompt

Shorter than an `om-task` prompt, because the agent's own definition carries the
method and there is no Codex hand-off to spell out. It embeds:

- **the question**, in Nicholas's own words — not your paraphrase of it. The
  phrasing is the requirement here: *"kinda ugly, it should be something like
  discord"* names the comparable, and a tidied version would lose it.
- **the chat context command**, same as a defect —
  `bun ~/.claude/skills/om-bug-loop/scripts/topic-context.ts --todo <seq> --window 40`
  — with the same warning that the title is never the whole task. Who else
  complained, and what they compared it to, is the research brief.
- **the lane** (`chat` | `chart`) and its environment reference path.
- **the browser driver**: agent-browser, sessions named `R<n>` / `R<n>-<product>`,
  per `references/browser-driving.md` §0 (dispatches from 2026-09-15).
- **`$REF/research.md`** — the evidence bar, the comparables, the doc shape.
- **the terminal state, stated plainly**: file the doc, write the card note,
  move the card to `Need Attention`, ask one question, stop. It does not
  implement what it recommends, and it does not promote itself to an `om-task`.
- **the doc's destination**, `Obisidian/openmarket/architecture/`, and the
  reminder that every `[[wikilink]]` needs a vault-root-relative full path.

**Do not name the answer in the prompt.** A dispatch that says "research how
Discord does copy-link, we should probably match it" has already decided, and
what comes back will be a justification rather than a comparison. Give it the
question and the comparable; let it tell you whether matching is right.

### Check the load before dispatching; do not count owners

A fixed cap was the wrong shape and is gone. An owner is a process **family**,
not a process — `codex exec`, test workers, a daemon, headless Chrome (an
agent-browser daemon per session, or a Playwright Chromium), plus
its own sub-agents — and how heavy that family is depends on the stage it is
in. A scoped run at `--shards 2` is nothing like a full suite at `cores-2`. A
count cannot see the difference, and it cannot see Nicholas's own work on the
same machine either. Load can.

```bash
bun ~/.claude/skills/om-bug-loop/scripts/dispatch-gate.ts check --ref T23
```

Exit 0 is GO; exit 1 means **queue the task and leave it in `todo`** with its
status unchanged. Dispatch it when a later check passes. The gate refuses above
`cores x 1.2` on the fifteen-minute average — headroom for Nicholas, measured
against the run queue rather than against a task count.

The fifteen-minute figure is the gate deliberately. The one-minute number is
noise: a single sample of it once read 3.9 while the five-minute average was
36, and that misread was reported as though it were a trend.

**Why this matters at all.** Six owners each running a full suite at `cores-2`
put ~196 processes on a 10-core box at load 36 — 3.6x oversubscribed. At that
ratio a three-minute build takes ten-plus, and the harness watchdog kills an
agent after **600 s with no output**, so agents die *while making progress*.
Three died in one afternoon and ~75 minutes produced 2, 5 and 6 artifacts
between them. Since implementers now run only scoped tests, the same six owners
are far lighter — but that is an argument, not a measurement, which is why the
gate also instruments itself.

**Instrument every dispatch.** `check` writes a line to
`~/.claude/om-bug-loop/dispatch-log.jsonl`. Take a `sample` at peak too, when a
batch is busiest, so the question "how many can we run" is answered from data
next time:

```bash
bun scripts/dispatch-gate.ts sample --ref T23 --note peak
bun scripts/dispatch-gate.ts report      # what the log has learned so far
```

Move the card to `in progress`, set status `implementing`, then spawn a
resume the owner with `SendMessage`, carrying:

- the approved plan path and the evidence dir,
- **the environment reference for this task's product**, by path —
  `references/openmarket-chat-env.md` for `chat`,
  `references/kiyotaka-chart-env.md` for `chart`,
- **(chat lane)** **`scripts/arm-env.sh` and the wall-clock rule** (`agent-watching.md`): `clone_home` never
  `rsync`, `base_dist` never a private base build (and its `BUILD-INFO.json` must
  show the base sha and `assertion.status: pass`; `overlay_node_modules` +
  `assert_arm_build` for any arm the owner builds itself, never a hand-mirrored
  `node_modules`), `:31417` for the base arm when
  its stamp matches. Omitting this is how a one-line diff costs 31 minutes.
  **(chart lane)** none of it applies — that rule is chat-only, and there is no daemon
  and no shared instance to borrow: the owner runs `pnpm dev` on `VITE_PORT=80NN`
  in each of its own worktrees, and reports its build and boot cost as a number
  so the chart lane earns its own baseline,
- the templates: fill `templates/codex-prompt.md` ({{branch}},
  {{gate_command}}, {{plan_markdown}}) → `evidence/<seq>/codex-prompt.md`,
  appending the environment facts it actually found and the explicit
  obligation "**no NEW failures vs. the baseline**, not a green gate",
- the **pinned invocation** (flags confirmed against codex-cli 0.149.1;
  `codex exec` is non-interactive by default — smoke-tested, exit 0):

```bash
codex exec --cd "$WORKTREE" --sandbox workspace-write --color never \
  --add-dir "$(git rev-parse --git-common-dir)" \
  --add-dir ~/.codex/skills --add-dir ~/.claude/om-bug-loop \
  -o "$EVIDENCE/codex-last-message.txt" "$(cat "$EVIDENCE/codex-prompt.md")" \
  > "$EVIDENCE/codex.log" 2>&1
```

All three `--add-dir` flags are load-bearing. The git-common-dir one lets Codex commit in a
**linked worktree** (git metadata lives in the parent repo, outside the sandbox). The other
two make `~/.codex/skills/om-implementer` readable — it symlinks into `~/Documents/Obisidian/`,
so without them Codex reports the skill "not installed" and silently falls back to whatever
the prompt happens to say. Confirmed working on T36 (2026-09-04); T31 and T35 both lost the
skill for want of them.

- the scope boundary: a plan step spanning a SECOND repo is out of scope for
  the Codex run — this worktree cannot reach it; it is a follow-up task, and
  the agent must say so rather than improvise,
  This is the rule that covers `titan-charts`: the app consumes the engine as a
  published package (`@orangecharts/titan-charts-next`), so a chart bug whose
  root cause is in the engine is a finding in the plan and a SEPARATE task, with
  the pin bump as a third — the same shape as `rooms-client` in the chat lane.
- the report contract: worktree path, branch, what Codex changed, the
  baseline-vs-after failure diff, and whether `BLOCKED.md` was written.

Never edit, commit, or switch branches in the shared checkout — a concurrent
session can move it under you. Never `git stash` (shared `refs/stash`). Never
`bun install` in an OM Chat worktree (private packages 404; it destroys the
overlay). Never `git add -A` over a symlinked node_modules.

The task owner continues straight through verification (`review-gate.md`) and shipping on its
own — you do not re-dispatch between stages.

**Shipping means a train, and the prompt must say so.** Since 2026-09-15 no owner
opens its own PR: it writes its PR section to a file and runs `train.ts ship
<ref> --surface <key>`, re-runs its scoped tests on the rebased train tip, and
ships with `--verified`. Its turn ends when its commits are on the open batch PR.
Name `references/trains.md` in every `om-task` and `om-feature` prompt, and pass
the surface key when the card note carries a `surface:` line — an old prompt
that says "open the MR" can get a direct `gh pr create` / `glab mr create`
instead of the GitHub or GitLab surface train.

**Tell it never to park.** An agent that spawns a *background* reviewer and then
ends its turn has stopped mid-arc: the harness reports it "finished" while
nothing is driving the task, and the coordinator has to nudge it awake (hit live
on 6658). A task owner that delegates verification must spawn the reviewer
**blocking** (`run_in_background: false`), so the verdict arrives inside its own
turn. Its turn ends once — at shipped, or at a real question for Nicholas.

A blocker is the agent's to resolve when it needs no human decision and is not
dangerous; only a blocker that genuinely needs Nicholas (an ambiguous
requirement, a destructive or prod-touching step, a second verification
failure) comes back as `Need Attention` + a ping (SKILL §9). "Codex could not
commit because of a sandbox flag" is the agent's problem to fix and record,
not a question for Nicholas.

Known: `codex exec --sandbox workspace-write` cannot commit in a **linked
worktree** — git metadata lives in the parent repo's `.git/worktrees/`, outside
the sandbox, so `index.lock` fails with "Operation not permitted". Pass
`--add-dir "$(git rev-parse --git-common-dir)"` as well. (Hit live on to-do
6658; details in `references/openmarket-chat-env.md`.)

## Do not demand Codex for a conflict resolution

**So do not demand Codex for a conflict resolution in a dispatch prompt.** Three
prompts on 2026-09-07 (T46, T50, T54) told owners to run every conflict through
`codex exec`, overriding the agent's own rule and buying nothing — the design
decision had been made and verified rounds earlier. That was a coordinator
error, not an agent one.

Two things stay firm when a resolution is hand-written: it is **named as a hand
step** in the report, and **a conflict hunk landing inside the fix's own logic
stops being mechanical** and goes to Codex — "both sides edited the same
behaviour" is a design decision wearing a merge conflict's clothes.
Verification is never waived either way.

The reason is not token cost. **Whoever writes the contract must not also write
the code**, or the implementation grades its own homework — the same property

## What every dispatch prompt must carry about writing code

**A task owner never writes the diff itself.** Every code change goes through
`codex exec` — including a one-line port, and including a change the owner
could obviously make faster by hand. Two rules follow, and both are absolute:

- Every dispatch prompt you write MUST carry the pinned invocation and the
  instruction to implement through it. Omitting it is how this drifts: T4 was
  given the flag only in passing, as an aside about committing in a linked
  worktree, and implemented by hand — Nicholas caught it.
- Never grant latitude like "implementing directly is fine for a small one".
  A one-liner is precisely where the exception looks harmless, and granting it
  once dissolves the rule. (Told to T9's owner; retracted the same day.)

*(The `impl-` agent type these rules were written for is gone — one owner runs the whole lifecycle now. The rules are unchanged; only the prompt they go into is.)*
