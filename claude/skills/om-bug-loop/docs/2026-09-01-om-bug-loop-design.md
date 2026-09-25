# om-bug-loop — Design Spec (2026-09-01)

> **Path note (2026-09-07):** the kanban moved from `Obisidian/openmarket/kanban/` to the vault root, `Obisidian/kanban/`, because every repo uses the board. Every `openmarket/kanban/...` path below is historical — read it as `kanban/...`. The live convention is `kanban/Kanban Rotation.md`.

Automated pipeline that watches the **⌗ OM Chat Bugs** topic
(`room b4472fc1fbd3`, `topic 7f30222f` on the :31417 daemon), investigates each
promoted to-do, gates on Nicholas's approval, implements via headless Codex,
and verifies with an evidence-based Opus review before shipping an MR.

Verification philosophy follows @poteto's "Verification is all you need"
(pstack Pt. 1): agents close their own loop by proving changes in the **real
running app** with artifacts (screenshots, verify-report), guided by an
incrementally-grown Feature Map — adapted here onto the existing
`testing-harness` and `/verify` skills rather than rebuilt from scratch.

## 1. Shape

- A skill at `~/.claude/skills/om-bug-loop/`. Detection is a **dumb watcher
  script** (zero Claude tokens); the coordinator session only wakes on real
  events: **event → dispatch → gate → report**.
- All heavy work runs in named background agents (visible in the agents
  panel); the coordinator chat is the control surface.
- **One agent owns a task from approval to shipped MR** — worktree,
  environment, Codex, its own reviewer subagent, the MR. It reports at the
  digest and at the end, and nowhere in between. The coordinator never
  inspects an intermediate artifact (codex.log, BLOCKED.md, a gate diff, a
  CLI flag): a blocker needing no human decision belongs to the agent.
  Corrected 2026-09-01 after the coordinator did ~15 tool calls of worktree
  and environment work inline on to-do 6658 and left the next to-do
  un-dispatched as a result.
- State (two files, two writers — learned in the first live run: the watcher
  persists `state.json` wholesale every poll and drops foreign keys):
  `~/.claude/om-bug-loop/state.json` = watcher's `{cursor, markers, dispatched}`
  (coordinator may append to `dispatched` only while the watcher is dead);
  `~/.claude/om-bug-loop/tasks.json` = coordinator's, one entry per to-do:
  `{id, slug, status, planPath, worktree, branch, mrUrl, retries, seenAt}`
  with `status ∈ new | investigating | awaiting-approval | implementing |
  reviewing | shipped | failed | skipped`.
  Crash-safe: a fresh loop resumes entirely from these files.
- Artifacts: `~/.claude/om-bug-loop/plans/`, `evidence/<id>/`.

## 2. Trigger — watcher script, not a model loop

`watch-todos` (bash/bun, launched by the coordinator as a background process):

- Polls the topic's to-dos every **60 s** with a plain HTTP GET against the
  daemon (badge token as `Authorization: Bearer` — discovery step: extract or
  mint the badge token the om-chat MCP server uses; fallback if impossible:
  slower Claude-side polling via the MCP tools).
- Diffs to-do ids against `state.json` itself (jq — no model involved).
- On finding a new eligible to-do: writes `pending/<id>.json` and **exits**;
  the process exit re-invokes the coordinator, which handles the event and
  relaunches the watcher.
- Self-exits every ~4 h even with no news (heartbeat), so a silently dead
  poller is noticed and restarted rather than waited on forever.
- Cost profile: Claude tokens are spent only on real events (plus ~6
  heartbeat turns/day); detection latency ≤ 60 s.

A task fires only when ALL hold:

1. It is a promoted **to-do** (someone ran "add a to-do"), not a plain report.
2. Not finished and not canceled.
3. Nobody is "on it" (unclaimed).
4. Its id is not already in `state.json`.

Plain chatter, replies, reactions, and unpromoted reports are ignored.
Promotion to to-do remains the team's human curation act.

## 3. Investigate → plan

Per fired to-do, spawn a background agent named `bug-<slug>` (general-purpose,
read-only intent). Method (ivtg-style):

1. Pull the report message + attachments via the badge, **plus the
   surrounding topic context**: the reply thread, nearby messages, and
   reactions around the report (who else hit it, clarifications, maintainer
   notes like "still making changes to search", related earlier reports).
   The to-do title alone is never the whole task. If a screen recording is
   attached, download it and extract a representative frame (ffmpeg).
2. Locate the code — query the global graphify graph (covers all 17 repos)
   plus targeted grep. Repo scope: **openmarket-chat, openmarket-chat-cloud,
   rooms-client, kiyotaka-chat-service**.
3. Reproduce the bug against the local :31417 daemon using the
   testing-harness patterns; capture a screenshot of the bug happening.
   If repro is infeasible, fall back to the reporter's video frame and say so.
4. Write `plans/<id>-<slug>.md`:
   - Problem (restated plainly)
   - Evidence (screenshot path, message link, video frame)
   - Reproduction steps (numbered, user POV)
   - Root cause
   - Fix plan (files + ordered steps)
   - **Verification spec** — written before any code exists: the exact
     checks that must FAIL now and PASS after (feeds `/verify` and the
     real-app proof). Codex never defines "working"; the approved plan does.
   - Risk / blast radius (regression-impact-check where kiyotaka-frontend
     is touched)

The coordinator then posts the **approval digest** in chat and marks the task
`awaiting-approval`.

## 4. Approval digest (Nicholas's template — verbatim requirement)

The coordinator must show, per task:

1. **Problem statement** — one paragraph, plain words
2. **Screenshot of the problem** — sent as a file (own repro preferred;
   reporter's video frame as fallback, labeled as such)
3. **Reproduction steps** — numbered
4. **Solution direction** — 2–3 sentences (root cause + fix shape), with a
   link to the full plan file

Approval is **per-task and explicit** ("ok <slug>", "skip <slug>",
"change the plan: …"). Nothing advances without it; one approval releases
exactly one task. "Change the plan" re-runs the investigation agent with the
feedback.

## 5. Implement — Codex headless

- `codex exec` in a **fresh sibling worktree** of the target repo
  (never the shared GitlabRepos checkout — standing rule).
- Prompt = approved plan file + house constraints:
  - no `git stash` (shared refs/stash across worktrees)
  - no `git add -A` near node_modules symlinks
  - respect the fork parity fence (hand-port shared files, never full sync)
  - branch naming `om-bug-loop/<slug>`
- stdout/stderr captured to `evidence/<id>/codex.log` for the reviewer.
- Codex commits on its branch but does NOT push or open the MR — shipping is
  the verifier's job, after evidence.

## 6. Verify — Opus review agent (the poteto step)

Background agent pinned to `model: opus`. Evidence, not claims:

1. **Code review** of the diff against the approved plan (scope creep,
   correctness, house conventions).
2. **`/verify`**: repro from the plan's verification spec must FAIL on the
   merge-base, PASS on the fix; repo static gate green (diffed against the
   known-red baselines where main is already failing) → `verify-report.md`.
3. **Real-app proof**: `bun run build`, serve through the :31417 daemon,
   drive the bug's user path in the actual GUI (testing-harness);
   screenshots to `evidence/<id>/` and sent to Nicholas.
4. **Feature Map upkeep**: `~/.claude/skills/om-bug-loop/references/features/`
   holds poteto-style entries (what the feature is, how a user reaches it,
   how to drive it, gotchas). Each verified fix appends/updates the entry for
   the surface it touched — the map is grown by the work, not by a one-off
   cataloging run.
5. Verdict:
   - **pass** → push branch, open MR (never Draft), check merge status and
     rebase-resolve conflicts, report to coordinator with MR link + evidence.
   - **fail** → failure report goes back to ONE more `codex exec` round,
     then re-verify. Second failure → mark `failed`, surface everything to
     Nicholas. No unbounded loops.

## 6b. Kanban mirror (Obsidian)

Every task is mirrored as a card on
`/Users/nicholas/Documents/Obisidian/openmarket/kanban/Kanban.md`
(Obsidian Kanban plugin; the loop owns the file's structure — columns
`todo`, `todo review`, `in progress`, `Need Attention`, `Review`, `Done`).

- Column mapping: watcher fired → **todo**; digest awaiting approval →
  **todo review**; approved/implementing/verifying → **in progress**;
  agent question, dangerous step, BLOCKED.md, or second verify failure →
  **Need Attention** (the "waiting on Nicholas" queue — the card carries
  the question); verification PASSED + MR open → **Review**; **Done** is
  moved by Nicholas, by "done <slug>" in chat, or automatically when the
  source to-do is folded `!done` in OM Chat.
- A card is one line (title + slug) linking a per-task note
  `kanban/cards/<slug>.md`. The note is written **at the digest step**, not
  at Review: the board is where the approval decision is made, so the plan
  must be reachable from it while the card sits in `todo review`. The
  reviewer later updates the same note with the fix, MR link and
  after-evidence. Review cards MUST embed before/after screenshots, plus a
  GIF/video when the fix is motion-related.
- Evidence is copied into the vault (`kanban/evidence/<slug>/`) because
  Obsidian cannot embed files outside it.
- Every wikilink and embed uses the **vault-relative full path**
  (`[[openmarket/kanban/cards/<slug>|details]]`). Obsidian resolves `[[…]]`
  from the vault root, never from the board's folder, so a bare
  `[[cards/<slug>]]` renders dead and on click creates a stray note outside
  the kanban folder; bare `![[repro.png]]` collides across tasks. Both were
  live bugs on 2026-09-01, now enforced by `cardTarget()` in kanban.ts.
- Single writer: only the coordinator edits Kanban.md (via
  `scripts/kanban.ts`, idempotent add/move). Agents report; the
  coordinator moves cards.
- Need Attention transitions also notify Nicholas directly (chat message
  + push notification), so the column never waits silently.

## 7. Cadence & reporting

- Detection: watcher script, 60 s poll, zero tokens (see §2). The coordinator
  session holds no timer of its own; it reacts to watcher exits and to
  background agents completing.
- Coordinator reports state transitions only: new digest awaiting approval,
  MR shipped (+evidence), or a failure needing attention.

## 8. Out of scope (v1)

- Posting status back into the OM Chat topic (follow-up; external posting
  needs its own approval flow).
- A standalone `control-om` CLI lever — testing-harness covers app driving;
  extract a CLI in phase 2 only if verify agents keep rewriting the same
  probes.
- Auto-picking-up unpromoted reports or stale-report escalation.
- Parallelism limits beyond natural agent isolation (revisit if to-dos
  arrive in bursts).

## 9. Known constraints baked in

- openmarket-chat GitHub Actions budget is exhausted — a red PR check there
  means nothing; rely on local gates + /verify.
- openmarket-chat-cloud runs CI on main only; diff tsc error sets locally.
- Design gates already fail on main — always baseline a same-commit worktree.
- grep needs `-a` in openmarket-chat (NUL-poisoned files).
