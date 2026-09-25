# The watcher, and `start`

*A reference for the `om-bug-loop` coordinator. `SKILL.md` carries the policy and the decision rules; this file carries the mechanics. If the two ever disagree, `SKILL.md` wins and this one is the bug.*

### Running it persistently (tmux)

tmux hosts **Claude**; Claude hosts **the watcher**. Not the other way round:
the wake path is "the watcher process exits → the harness re-invokes the
coordinator", which only fires for a background task owned by the Claude
session. A watcher living in its own tmux pane still writes `pending/*.json`,
but nothing wakes anyone, so the loop goes quiet while looking healthy.

```bash
tmux new -s ombug -c ~/Documents/GitlabRepos
claude
# then: /om-bug-loop start
# detach: Ctrl-b d      reattach: tmux attach -t ombug
```

**Exactly one coordinator at a time.** Two sessions both draining `pending/`
will dispatch the same to-do twice — `dispatched` is a guard, not a lock, and
the second agent may already be spawned before the first writes. Before
starting a coordinator anywhere, confirm no other one is running (`tmux ls`,
and `/om-bug-loop status` in any session you suspect); stop the old one first.

A fresh coordinator needs no handover: `tasks.json`, `state.json` and the board
carry everything, so `start` resumes mid-flight work, and to-dos that arrived
while nothing was running are picked up by the next poll.

```bash
bun ~/.claude/skills/om-bug-loop/scripts/kanban.ts init   # once; refuses if the board exists
bun ~/.claude/skills/om-bug-loop/scripts/watch-board.ts --watch
```

Launch the watcher with Bash `run_in_background`. Say "watching ⌗ OM Chat Bugs"
and **end the turn** — do not poll, do not sleep, do not keep a timer.

**Then check whether anything is already in flight**, because `start` resumes a
pipeline as often as it begins one:

```bash
bun ~/.claude/skills/om-bug-loop/scripts/task-watch.ts
```

- **Live tasks** — a previous session was interrupted mid-flight. Launch the
  agent watcher too (`task-watch.ts --watch`, background), report what it shows,
  and reconcile: an owner from a dead session is gone, so a task in
  `implementing` with a mergeable PR usually needs closing out (`agent-watching.md`) rather than
  resuming.
- **No live tasks** — do not launch it. An hourly heartbeat over an empty
  pipeline is noise. It starts on your first dispatch (`agent-watching.md`).

**Two watchers, two jobs, and they are easy to confuse:**

| script | watches | wakes you when |
|---|---|---|
| `watch-board.ts --watch` | the board's `todo` lane | a new unclaimed, routable card appears |
| `task-watch.ts --watch` | **your own agents** | one crosses 40 min or the hour |

The first is detection; the second is supervision. Running only the first is how
three tasks passed 70 minutes unnoticed in one afternoon.

When the background task finishes, its exit code is the event:

| exit | meaning | do |
|---|---|---|
| 0 | new card(s) in the `todo` lane | handle every `pending/*.json` (`dispatch.md`), then relaunch the watcher |
| 3 | heartbeat, 4h quiet | relaunch silently, say nothing |

There is no exit 2. The old chat watcher had one for "daemon down"; this one
reads a local file and has no daemon, no cookie and no network to lose.

**`#human` cards never reach you.** The watcher drops any card whose tags route
to `skip` before it writes a pending file — no pending file, no ref, no card
rewrite, no wake-up. The line stays exactly as Nicholas wrote it, in his lane.

The skip is a **filter, re-evaluated every poll** — the slug is NOT written to
`state.json.dispatched`. `dispatched` is permanent, so recording it would make
the card invisible forever and deleting the tag would never re-fire it. As a
filter it is self-healing: remove `#human` and the card is eligible on the next
60-second poll, with nobody doing anything.

**A claimed card is never offered either.** A card already in the pipeline's own
format — bold title plus a `cards/<slug>|details` link — is claimed, which is
also why another pipeline's `C<n>` cards fall out with no special case. The
board is its own ledger: what has been consumed is visible on the surface rather
than hidden in `state.json`.

If a card already sits in `pending/` when you start, handle it exactly like a
fresh one.

# File locations, and who owns what

Spec: `docs/2026-09-01-om-bug-loop-design.md`.
Daemon endpoints, auth, to-do grammar, rate limits: `references/api.md` —
read it before writing any daemon call, and hand it to every agent you spawn.

## 1. State machine and file locations

One entry per to-do in `~/.claude/om-bug-loop/tasks.json` (yours alone —
the watcher rewrites `state.json` wholesale on every poll and drops keys it
does not own, so task entries must NEVER live there):

**Never hardcode a vault path into an agent's prompt — derive it.** The kanban
folder moved from `openmarket/kanban/` to the vault root `kanban/` on
2026-09-07, and three dispatch prompts written minutes earlier carried the old
absolute card path with them. `kanban.ts` was unaffected, because every command
resolves `cards/` and `evidence/` from `DEFAULT_BOARD` — which is exactly the
point: a path the tool derives survives a move, and a path you pasted does not.
Tell an agent to reach the card with `kanban.ts` (`note`, `check`, `feature`)
and to locate the board from the tool rather than from a string in its prompt.

Two related fragilities worth knowing, both silent:

- `kanban/Workflow/Agents/*.md` are the **symlink targets** for
  `~/.claude/agents/om-{task,verifier}.md`, and
  `kanban/Workflow/Skills/` for `~/.codex/skills/om-implementer`. Move or
  rename anything under `Workflow/` and those three go dead **with no error
  naming the vault** — the agent types simply stop existing.
- Obsidian resolves `[[…]]` from the **vault root**, so an embed carrying a
  stale folder prefix does not error: it renders as a dead link and *creates a
  stray note* when clicked. After any move, the prefix in every embed has to
  match the real folder exactly — see `kanban/Kanban Rotation.md`, which records
  the 2026-09-07 move and the 478 links repointed in it.

`cursor`, `markers` and the pending files belong to the watcher. In
`state.json` you may touch ONLY `dispatched`, and only while the watcher is
dead (it re-reads `dispatched` from disk before each persist, but every other
key you add there will be dropped). `tasks.json` is entirely yours.

