# llm

Every skill, subagent, watcher and scheduled maintenance routine Nicholas runs for the
OpenMarket / Kiyotaka repos, copied from where they actually run. This repo is a snapshot,
not the source of truth: the live copies sit on the laptop and the Mac mini (paths below).
Last synced 2026-10-14.

## What runs, where, when

Times are local (Asia/Singapore). Weekdays: 0 = Sun … 6 = Sat.

### Laptop (`~/Library/LaunchAgents`, scripts in `~/.local/bin`)

| Job | What it does | When |
|---|---|---|
| `midnight-scout` | Nightly feature-by-feature audit of OM Chat; files findings as cards in the Kanban `todo` lane | Mon–Sat 00:00 (not loaded) |
| `mobile-scout` | Same audit for OpenFloor on the iOS simulator | Mon–Sat 00:00 (disabled since 09-21) |
| `claude-workflow-review` | Reviews how the day's Claude Code + Codex sessions went; writes `~/.claude/workflow-reviews/` and posts to Discord | Mon–Fri 08:47 |
| `mobile-status` | Posts the mobile lane's status from `~/.claude/om-bug-loop/` to OM Chat #chat → topic "mobile" | daily 09:00 |
| `om-kudos` | Daily kudos post; installed by om-agent `tools/kudos/install.sh` (edit there) | daily 10:15 |
| `om-daily-update` | End-of-day 2-line update to #announcements → "Daily Update" | Mon–Sat 19:30 (paused: `~/.claude/daily-updates/.paused` since 09-21) |
| `om-kanban-rotate` | Rotates the vault Kanban board to a new week + writes the retro | Sun 23:30 |
| `pooper-approver` | Auto-approves every PR link posted in THE POOPERS | always on |

`midnight-scout` and `mobile-scout` both run through `hosts/laptop/bin/midnight-run.sh`,
which reads the skill's `phases` / `preflight` files.

### Desktop-app scheduled tasks (`~/.claude/scheduled-tasks`)

| Task | What it does |
|---|---|
| `web-port-scout` | Every 4 h: records new web `production` commits in kiyotaka-frontend-app's `docs/web-parity.md`, ships `port` rows in one MR |
| `openfloor-feature-map-tonight` | One-off: build the OpenFloor Feature Map overnight |

### Mac mini (`ombot@oms-mac-mini`, scripts in `~/.local/bin`, skills in `~/repos/.claude/skills`)

Twelve code-health routines, each run twice a week by `hosts/mini/bin/routine-run.sh <skill>`
(lock, time cap, phases, usage-limit deferral, Discord ping via `routine-ping.sh`).

| Routine | When |
|---|---|
| `crash-fuzz-chrome` | Mon, Thu 06:40 |
| `logic-simplifier` | Mon, Thu 08:20 |
| `useless-test-pruner` | Mon, Thu 12:20 |
| `logic-bugfixer` | Mon, Thu 17:00 |
| `crash-fuzz-desktop` | Tue, Fri 07:40 |
| `ant-shipper` | Tue, Fri 09:40 |
| `shipped-feature-inliner` | Tue, Fri 13:00 |
| `dup-unifier` | Tue, Fri 18:00 |
| `dead-code-removal` | Wed, Sat 11:40 |
| `flaky-test-fixer` | Wed, Sat 13:40 |
| `abstraction-improver` | Wed, Sat 19:00 |
| `abstraction-police` | Wed, Sat 20:00 |

Also on the mini: the `om-agent` bot and its watchdog (`xyz.openmarket.om-agent*.plist`,
both KeepAlive). Only the plists are here; the code is the `om-agent` repo.

### On demand

`om-bug-loop` (the Kanban watcher + coordinator) and its subagents run inside a Claude
session, not on a timer.

## Layout

```
claude/
  skills/
    om-bug-loop/            board watcher + coordinator (SKILL.md, references, templates, scripts)
    web-port-scout/         web → mobile parity scout
    midnight-scout/         nightly OM Chat audit (+ its launchd plist)
    mobile-scout/           nightly OpenFloor audit (+ its launchd plist)
    openfloor-feature-map/  builds the OpenFloor Feature Map
    routine-*/              the twelve mini routines (SKILL.md, phases, optional model)
    verify/                 merge-base vs fix proof the routines put in every MR
  agents/                   subagents om-bug-loop dispatches
    om-task.md  om-quickfix.md  om-feature.md  om-research.md  om-verifier.md
    om-play-around.md  om-play-around-mobile.md
  scheduled-tasks/          desktop-app scheduled task prompts
codex/
  skills/om-implementer/    Codex skill: house rules for writing the diff against an approved plan
hosts/
  laptop/bin, laptop/launchd   scripts + plists for the laptop jobs above
  mini/bin, mini/launchd       routine-run.sh & friends + plists for the mini jobs above
```

## Install

```bash
# laptop: skills + agents + codex
ln -s "$PWD/claude/skills/om-bug-loop" ~/.claude/skills/om-bug-loop
ln -s "$PWD/claude/skills/web-port-scout" ~/.claude/skills/web-port-scout
ln -s "$PWD"/claude/agents/*.md ~/.claude/agents/
ln -s "$PWD/codex/skills/om-implementer" ~/.codex/skills/om-implementer

# laptop: scheduled jobs
cp hosts/laptop/bin/* ~/.local/bin/
cp hosts/laptop/launchd/*.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nicholas.<job>.plist

# mini: routines
cp -R claude/skills/routine-* claude/skills/verify ~/repos/.claude/skills/
cp hosts/mini/bin/* ~/.local/bin/
cp hosts/mini/launchd/com.nicholas.routine.*.plist ~/Library/LaunchAgents/
```

Scripts run on [Bun](https://bun.sh):
`bun test claude/skills/om-bug-loop/scripts/` and `bun test claude/skills/web-port-scout/scripts/`.

## Not included

- **Feature Maps** (`references/features`, `features-mobile`, `features-charts`,
  `features-mobile-charts`). Product docs kept in the Obsidian vault
  (`openmarket/`, `openmarket-mobile/`, `openmarket-charts/`, `openmarket-mobile-charts/` →
  `Feature Map`). Symlink them back into `claude/skills/om-bug-loop/references/`.
- **Runtime state**: `~/.claude/om-bug-loop/` (tasks.json, trains, evidence, auth),
  `~/.local/state/routines/` on the mini, scout ledgers. Machine-local, recreated as things run.
- **Credentials**: every script reads them from local files (`om login`, glab, SOPS); none are stored here.
- The `.bak-*` / `.REJECTED-*` / `.disabled-*` snapshots from the source directories.
- Stale copies not in use: `~/.codex/skills/om-bug-loop`, `~/.codex/skills/openmarket-task-kanban`,
  and the Aug-19 `routine-*` copies in `GitlabRepos/.claude/skills` (the mini's are live).

Several source files are symlinks into the vault; this repo holds copies as of the sync date, not links.
