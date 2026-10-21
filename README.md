# llm

Every skill, subagent, watcher and scheduled maintenance routine Nicholas runs for the
OpenMarket / Kiyotaka repos, copied from where they actually run. This repo is a snapshot,
not the source of truth: the live copies sit on the laptop and the Mac mini (paths below).
Last synced 2026-10-21.

## Three kinds of agent

Every agent here is one of three kinds. What tells them apart is **what wakes them up**:

| Kind | Woken by | Owns | Ends with |
|---|---|---|---|
| **Routine** | a clock (launchd, a desktop scheduled task) | one run of one job | a report, and an MR when the run found something to fix |
| **Chat agent** | a person posting a bug, request or `!todo` in a room it watches | one reported item, until the reporter has the fix | a reply in the thread; for a bug or change, an MR with before/after screenshots posted back in the thread |
| **Alert agent** | a service's alert firing | one alert class on one service, until it stops firing | the root cause, an MR (or the owning team named with evidence), and the tag that has to be deployed |

Chat and alert agents are **event-only**: a small background shell script (a *watcher*) polls
the room or log and exits only when something needs attention, which wakes the coordinating
Claude session. No timers re-arming every 30 minutes, no polling turns — every wake-up is a
paid turn. The coordinator never does the work itself; it dispatches **one owner agent per
reported item or alert**, and resumes that same agent when the reporter adds detail or the alert
fires again.

### Routines

On a timer. Each run is self-contained: it reads the state, does its job, reports, and exits.
Listed under [What runs, where, when](#what-runs-where-when) below: the twelve code-health
routines on the mini, the nightly scouts, the daily bots, and the desktop scheduled tasks
(`app-data-canary-watch` is a routine that happens to read alerts: it runs on a clock, not on
the alert).

### Chat agents

Activated by naming a room: "monitor http://localhost:31417/rooms#/82eae63a1bd3 and fix what comes
in; repos openmarket-chat and openmarket-internal". That is how the **OpenMarket Chat Agent**
session has run #chat since 2026-10-20 (on the Linux box, state in `~/.claude/chat-todo-watch/`).

| Piece | What it is |
|---|---|
| [`claude/skills/chat-watch`](claude/skills/chat-watch/SKILL.md) | The coordinator, and the only one that posts. Setup asks Nicholas scope / posting / out-of-scope once, builds the real-app environment, triages the backlog. Then every new human post wakes it: vague reports get a question, fixable ones get `!claim` and a fix agent, follow-ups go to that item's agent. It checks the before/after pictures, replies to the reporter with them and the MR link (as Nicholas, prefixed `🤖 agent:`), and posts `!done` once merged |
| [`claude/skills/chat-watch/watchers/chat_room_watch.sh`](claude/skills/chat-watch/watchers/chat_room_watch.sh) | Wakes on every human post in the room; skips agent badges, the coordinator's own 🤖 posts and bare `!claim`/`!done` markers |
| [`claude/agents/chat-agent.md`](claude/agents/chat-agent.md) | The fix agent: one item, never posts. Reproduces in the real running app, fixes in a sibling worktree, proves it with before/after pictures and behaviour checks, opens the MR/PR, drafts the reporter's reply |
| [`claude/skills/chat-watch/live/chat-82eae63a1bd3/`](claude/skills/chat-watch/live/chat-82eae63a1bd3) | The live #chat instance: watcher, `FIX_BRIEF.md`, `ENV.md` (real GUI/TUI on numbered ports), `gui.sh`, `tui.sh`, `shot.mjs`. The template for a new room |
| **om-agent** (`om-agent` repo; plists in `hosts/mini/launchd`) | A different chat agent: a daemon on the Mac mini that only acts on `@om-agent` mentions in #om-reports and #om-agent-test and opens draft MRs |

### Alert agents

| Piece | What it is |
|---|---|
| [`claude/skills/alert-watch`](claude/skills/alert-watch/SKILL.md) | The coordinator: runs one watcher per alert source, dispatches one `alert-agent` per alert class with a 1-hour deadline, reports to Nicholas |
| [`claude/skills/alert-watch/watchers/`](claude/skills/alert-watch/watchers) | The live watchers: `perf_room_watch.sh` and `perf_cycle_watch.sh` (perf-sentinel + the data canaries), `chart_watch.sh` (om-agent's chart probe) |
| [`claude/agents/alert-agent.md`](claude/agents/alert-agent.md) | The owner: is it real → prove the cause at the deployed tag → fix the cause, not the threshold → MR or name the owner → which tag to deploy and what the next cycle must show |
| perf-sentinel-auto-remediator (on the mini) | An alert agent that is a program, not a session: Loki `perf_cycle_fail` → Codex → Draft MR, every 5 min. Lives in its own repo |

### Shared roles: investigation, verification, implementation

These are not a fourth kind; they are steps the other agents lean on.

| Role | Where it lives |
|---|---|
| **Investigation** | Not a standalone agent. It is Stage 1 of `om-task` ([`references/investigation.md`](claude/skills/om-bug-loop/references/investigation.md)): reproduce with a screenshot, root cause at file:line, a verification spec written before any code. `chat-agent` and `alert-agent` follow the same rules. For "investigate, plan only, don't touch code" there is the `ivtg` skill (laptop only, not in this repo). Design questions go to `om-research`. |
| **Verification** | `om-verifier` (the independent gate `om-task` spawns: re-runs the repro on both arms, diffs failures against the merge-base, audits the write-up). Outside the board, the `verify` skill does the same proof for one fix and writes `verify-report.md` for the MR — routines, chat agents and alert agents all use it. |
| **Implementation** | `om-implementer` (Codex skill): house rules for writing the diff against an approved plan. On the board, Codex writes every diff; chat and alert agents write their fixes themselves. |

`om-bug-loop` ties these together for the Kanban board: a card in the `todo` lane →
`om-task` / `om-quickfix` / `om-feature` / `om-research` → `om-verifier` → commits on a batch MR.

## What runs, where, when

Times are local (Asia/Singapore). Weekdays: 0 = Sun … 6 = Sat.

### Laptop (`~/Library/LaunchAgents`, scripts in `~/.local/bin`)

| Job | What it does | When |
|---|---|---|
| `midnight-scout` | Nightly feature-by-feature audit of OM Chat; files findings as cards in the Kanban `todo` lane | Mon–Sat 00:00 (not loaded) |
| `mobile-scout` | Same audit for OpenFloor on the iOS simulator | Mon–Sat 00:00 (disabled since 09-21) |
| `claude-workflow-review` | Reviews how the day's Claude Code + Codex sessions went; writes `~/.claude/workflow-reviews/` and posts to Discord | Mon–Fri 08:47 |
| `mobile-status` | Posts the mobile lane's status from `~/.claude/om-bug-loop/` to OM Chat #chat → topic "mobile" | daily 09:00 |
| `om-kudos` | Kudos bot: thanks one teammate in OM Chat #special-mentions, and the team behind each public launch. See [Kudos bot](#kudos-bot-om-kudos) | daily 10:15, fallbacks 12:15 / 15:15 / 18:15 |
| `om-daily-update` | End-of-day 2-line update to #announcements → "Daily Update" | Mon–Sat 19:30 (paused: `~/.claude/daily-updates/.paused` since 09-21) |
| `om-kanban-rotate` | Rotates the vault Kanban board to a new week + writes the retro | Sun 23:30 |
| `pooper-approver` | Auto-approves every PR link posted in THE POOPERS | always on |

`midnight-scout` and `mobile-scout` both run through `hosts/laptop/bin/midnight-run.sh`,
which reads the skill's `phases` / `preflight` files.

### Desktop-app scheduled tasks (`~/.claude/scheduled-tasks`)

| Task | What it does | When |
|---|---|---|
| `app-data-canary-watch` | Reads perf-sentinel's app-data + CME canary results, classifies each failure (data / app divergence / checker bug), fixes and merges its own checker-fix MRs | Mon–Fri 10:15, 16:15 |
| `train-reads` | Writes the morning train read from the topic-queue doc and yesterday's sessions | Mon–Fri 09:38 |
| `web-port-scout` | Records new web `production` commits in kiyotaka-frontend-app's `docs/web-parity.md`, ships `port` rows in one MR | every 4 h (not in the scheduler as of 10-21) |
| `openfloor-feature-map-tonight` | One-off: build the OpenFloor Feature Map overnight | done |

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

### On demand (inside a Claude session)

- `om-bug-loop`: the Kanban watcher + coordinator and its subagents.
- `chat-watch` and `alert-watch`: the chat and alert coordinators above. Their watchers run in
  the background of that session; live copies and state in `~/.claude/chat-todo-watch/` (#chat, on the Linux box),
  `~/.claude/perf-watch/`, `~/.claude/om-agent-watch/`.

## Kudos bot (`om-kudos`)

A routine that makes good work visible. A lot of work here merges without anyone saying
anything, so the bot says it, specifically, with a real number about who the work helped.
It posts in OM Chat **#special-mentions** (`316c2aa8c358`) as **@om-agent**, never under
Nicholas's name. Source of truth: om-agent repo, `tools/kudos/` (merged in !127, hardened in
!132, statistics sources in !133, plain language and security fixes in !134 and !135). Snapshot here: [`hosts/laptop/kudos/`](hosts/laptop/kudos).

**Two kinds of post**

| Post | When | Who it thanks |
|---|---|---|
| **Weekly kudos** | Mon / Wed / Fri | One person: lots of work in the last 14 days, little recognition for it |
| **Launch kudos** | the day after a launch is announced on the public Discord | The people who built what shipped, found from their MRs |

**How the weekly pick works**

1. **Collect.** Every MR merged in the last 14 days across all ~240 `openmarketxyz` GitLab
   projects, notes on them by other people, commit history of long MRs, and @mentions in
   the openmarket space's chat rooms.
2. **Score effort** (weights Nicholas chose, `score.ts` `effortScore`):
   `2·fixes + 3·issues closed + 1.5·active days + 2·hard MRs + 2·log(1 + MRs) + 1.5·night/weekend days`.
   A *hard MR* has commits on 3+ different days (an MR just left open doesn't count). Night
   is 22:00–07:00 UTC+8. MR count is on a log scale so volume can't decide alone; repos
   touched don't count.
3. **Score recognition:** comments from others, upvotes, chat @mentions, PIC callouts by
   @openmarket.
4. **Pick** the widest gap between effort rank and recognition rank across the team.
5. **Write and check.** A locked-down Claude run drafts the post and may only *read* GitLab,
   PostHog, Sentry and Grafana (Loki/Prometheus for the main, ore, blk and cme clusters).
   **Statistics are the point:** it must try at least three queries across sources for a
   real number ("87 people created 473 wrun alerts since the launch", "this error fired N
   times before the fix, 0 since"); a draft with none gets one more, pointed attempt. A
   number is never invented, and every one is listed with the query that produced it.
   **Plain language:** posts are for the whole team, so they say what got better for
   people ("a crash that hit 7 people, fixed the next day"), never internals (issue IDs,
   error strings, API names), in two or three themes and under 1,200 characters. The routine
   refuses a draft that is too long, mass-mentions, tags someone unknown or excluded, links
   outside our hosts, or contains anything token-shaped.

**Never picked:** Kyle; anyone holding the space's **@QA** role (read live every run; the run
stops if it can't be read); bots; anyone thanked by a weekly post in the last 14 days;
GitLab users without an OM Chat handle in `people.json` (`eusean`, `russell612`).

**Launch posts come from the public Discord only.** Nicholas isn't an admin there, so the
announcement channel is *Followed* into `#om-launches` on his own server, where a read-only
bot (`om-readers`) reads the copies. OM Chat #announcements is not watched for launches.

**Where things live (laptop)**

| What | Where |
|---|---|
| Installed routine | `~/.local/share/kudos/` (outside `~/Documents`: launchd can't read it reliably) |
| Wrapper + schedule | `~/.local/bin/om-kudos`, `~/Library/LaunchAgents/com.nicholas.om-kudos.plist` |
| State (freeze list, Discord cursor, last success) | `~/.local/state/kudos/state.json` |
| Every run's team ranking and the draft with each number's source | `~/.local/state/kudos/drafts/` |
| Log | `~/.local/state/kudos/logs/launchd.out` |
| Discord bot token + channel | `~/.config/kudos/discord.env` (chmod 600) |
| PostHog read key | `~/.config/kudos/posthog.env` (chmod 600): key, project `234431`, `POSTHOG_HOST=https://us.posthog.com` (the project is on the US cloud) |
| Sentry read token | `~/.config/kudos/sentry.env` (chmod 600): `de.sentry.io`, org `trontal-group`; issue lists and single issues only |
| Grafana token | `~/.config/kudos/grafana.env` (chmod 600): `grafana.occ.kiyotaka.dev`; Loki and Prometheus datasources only |

Posting goes over ssh to `~/.local/share/om-routines/routine-say.ts` on the mini, which
holds @om-agent's key.

**Operating it**

```bash
tail ~/.local/state/kudos/logs/launchd.out              # what the last runs did
touch ~/.local/state/kudos/PAUSED                       # pause (rm to resume)
om-kudos --dry-run --weekly                             # draft only, posts nothing
# change it: edit om-agent tools/kudos/, merge, then from the om-agent checkout:
tools/kudos/install.sh --load
```

**Reliability.** Every GitLab page, chat read and Discord read retries on its own. If the
10:15 run fails (asleep, network), the 12:15 / 15:15 / 18:15 slots retry; once a run
succeeds the rest of the day's slots do nothing, and a weekly post never goes out twice in a
day. Lost days so far: 10-19 (GitLab reset a page mid-listing) and 10-21 (timeout on the
first request after wake), both fixed in !132. The token files are read only by
`kudos-fetch`, never by the writer model; a missing file just skips that source.

**History.** #dev-forums Oct 14–16 (4 posts: Big Trades and free-alerts launches,
@kyler_lee, @benjylimmy; the first two carried the builder credit). Moved to
#special-mentions on 10-21; first post there @eamonchin, with PostHog numbers.

## Layout

```
claude/
  skills/
    chat-watch/             chat-agent coordinator, watchers/chat_room_watch.sh, live/ (the #chat instance)
    alert-watch/            alert-agent coordinator + watchers/ (live perf-sentinel + om-agent watchers)
    om-bug-loop/            board watcher + coordinator (SKILL.md, references, templates, scripts)
    web-port-scout/         web → mobile parity scout
    midnight-scout/         nightly OM Chat audit (+ its launchd plist)
    mobile-scout/           nightly OpenFloor audit (+ its launchd plist)
    openfloor-feature-map/  builds the OpenFloor Feature Map
    routine-*/              the twelve mini routines (SKILL.md, phases, optional model)
    verify/                 merge-base vs fix proof the routines put in every MR
  agents/
    chat-agent.md  alert-agent.md          owners dispatched by chat-watch / alert-watch
    om-task.md  om-quickfix.md  om-feature.md  om-research.md  om-verifier.md
    om-play-around.md  om-play-around-mobile.md   dispatched by om-bug-loop / the scouts
  scheduled-tasks/          desktop-app scheduled task prompts
codex/
  skills/om-implementer/    Codex skill: house rules for writing the diff against an approved plan
hosts/
  laptop/bin, laptop/launchd   scripts + plists for the laptop jobs above
  laptop/kudos                 the kudos bot's routine (snapshot of om-agent tools/kudos)
  mini/bin, mini/launchd       routine-run.sh & friends + plists for the mini jobs above
```

## Install

```bash
# laptop: skills + agents + codex
ln -s "$PWD/claude/skills/om-bug-loop" ~/.claude/skills/om-bug-loop
ln -s "$PWD/claude/skills/web-port-scout" ~/.claude/skills/web-port-scout
ln -s "$PWD/claude/skills/chat-watch" ~/.claude/skills/chat-watch
ln -s "$PWD/claude/skills/alert-watch" ~/.claude/skills/alert-watch
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
- **Runtime state**: `~/.claude/om-bug-loop/` (tasks.json, trains, evidence, auth), watcher state (`seq`, `*.known`, `suppressed.log`), chat ledgers (`LEDGER.md`, `baseline.md`, `shots/`),
  `~/.local/state/routines/` on the mini, scout ledgers. Machine-local, recreated as things run.
- **Credentials**: every script reads them from local files (`om login`, glab, SOPS); none are stored here.
- The `.bak-*` / `.REJECTED-*` / `.disabled-*` snapshots from the source directories.
- Stale copies not in use: `~/.codex/skills/om-bug-loop`, `~/.codex/skills/openmarket-task-kanban`,
  and the Aug-19 `routine-*` copies in `GitlabRepos/.claude/skills` (the mini's are live).

Several source files are symlinks into the vault; this repo holds copies as of the sync date, not links.
