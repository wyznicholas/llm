# Claude Work: a second Claude desktop on the laptop

Since 2026-10-22 the laptop runs two copies of the Claude desktop app at once, each signed in
to a different Claude account. The second one is called **Claude Work** and is where the
routines, chat agents and alert agents now live.

| | Main Claude | Claude Work |
|---|---|---|
| Opened by | `/Applications/Claude.app` (Dock icon) | `~/Applications/Claude Work.app` |
| Data folder | `~/Library/Application Support/Claude` | `~/Library/Application Support/Claude-Work` |
| Account | `34e4ed01…` (org `dc7facae…`) | **Nicholas Trontal**, nicholaswong@trontalgroup.com, `d4dc2a25…` (org Trontal, `723e3e24…`) |
| Desktop routines | off (on purpose) | web-port-scout, train-reads, app-data-canary-watch |
| Sidebar groups | — | Alert Agents, Chat Agents, Routines |

## How two copies can run at once

The desktop app is an Electron app, which is Chrome in a wrapper. Everything it remembers
(login cookies, settings, MCP servers, the Code tab's session list and scheduled tasks) lives
in one **data folder**. Launching it with `--user-data-dir=<folder>` points it at a different
folder, so it starts as a fresh install: nobody signed in, no sessions, no settings. The app
also allows one running copy *per data folder* (the lock file sits inside the folder), so a
second folder means a second copy can run next to the first.

The launcher is a one-line AppleScript app ([`launcher.applescript`](launcher.applescript)):

```bash
osacompile -o ~/Applications/"Claude Work.app" launcher.applescript
# Claude's icon instead of the script icon:
cp /Applications/Claude.app/Contents/Resources/electron.icns ~/Applications/"Claude Work.app"/Contents/Resources/applet.icns
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" ~/Applications/"Claude Work.app"/Contents/Info.plist
rm ~/Applications/"Claude Work.app"/Contents/Resources/Assets.car
codesign --force --deep -s - ~/Applications/"Claude Work.app"
```

What the flag does **not** separate:

- **`~/.claude`** is shared. Both copies' Code tabs read the same CLAUDE.md, memory, skills,
  scheduled-task prompts and session transcripts (`~/.claude/projects/`). That is why a session
  can move between the copies: only its small "pointer" file lives in the data folder; the
  conversation itself is in `~/.claude`. (To split it, set `CLAUDE_CONFIG_DIR` in Claude Work's
  Settings. Not done.)
- **The app itself.** Both run `/Applications/Claude.app`, so an update applies to both, and
  that causes the next problem.

## Why it needs a watchdog

The app installs updates quietly: when an update is downloaded, no session is running and the
window has been in the background for 10 minutes, it quits to install and reopen. In Claude
Work that always fails, because the main copy has the same app open and the installer will not
replace it. So Claude Work quit and never came back ("I hide it and it's gone").

[`watchdog.sh`](watchdog.sh) + [`com.nicholas.claude-work-watchdog.plist`](com.nicholas.claude-work-watchdog.plist)
fix that without polling:

1. Right before any update quit, the app writes `<data folder>/update-attempt`
   (`{"fromVersion","toVersion","ts"}`) and deletes it on its next start. A plain Cmd+Q
   writes nothing.
2. launchd watches that one file (`WatchPaths`) and runs the script when it changes.
3. The script ignores a missing or older-than-10-minutes marker, waits for Claude Work to finish
   quitting, gives the app 15 s to reopen itself, and otherwise reopens it with the flag.

So an update quit reopens it about 20 s later, and quitting it yourself leaves it closed.
Log: `~/Library/Logs/claude-work-watchdog.log`.

```bash
mkdir -p ~/Library/Application\ Support/claude-work-watchdog
cp watchdog.sh ~/Library/Application\ Support/claude-work-watchdog/
cp com.nicholas.claude-work-watchdog.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nicholas.claude-work-watchdog.plist
# remove:
launchctl bootout gui/$(id -u)/com.nicholas.claude-work-watchdog
```

The script lives under `~/Library/Application Support`, not `~/Documents`: launchd jobs cannot
read `~/Documents` (macOS privacy rules).

Also seen: once Claude's installer has failed for a version, the next start of Claude Work can
quit again within a minute for the same update. The watchdog brings it back each time; it settles
once the main Claude restarts and both copies are on the new version.

## Where the app keeps things (per data folder)

| What | File |
|---|---|
| Signed-in account | `config.json` → `lastKnownAccountUuid` |
| Code tab sessions (one pointer per session) | `claude-code-sessions/<account>/<org>/local_<id>.json` (title, cwd, model, `cliSessionId` → the transcript in `~/.claude/projects/`, `sshConfig` for SSH sessions, `scheduledTaskId` for routine runs) |
| Desktop scheduled tasks (schedule, on/off, last run) | `claude-code-sessions/<account>/<org>/scheduled-tasks.json` (the prompt is `~/.claude/scheduled-tasks/<id>/SKILL.md`) |
| Sidebar groups and which session is in which | `claude_desktop_config.json` → `preferences.epitaxyPrefs`: `dframe-code-sections` (the groups) and `dframe-group-scopes.<account>/<org>.assignments` (`"code:local_<id>": "<group id>"`) |
| SSH hosts (emu-box) | `ssh_configs.json` |

Cloud routines (claude.ai "routines", e.g. the daily plan and dinner pick) are **not** here: they
are stored on Anthropic's servers per account and can only be recreated from the other account.

## What was moved on 2026-10-22, and how

Quit Claude Work first (it rewrites these files while running), then:

1. **Routines.** Copied the three entries from the main account's `scheduled-tasks.json` into
   Claude Work's (`d4dc…/723e…`), and turned them off in the main account so they don't run
   twice (two web-port-scout runs would open competing MRs).
2. **Sessions.** Copied 22 pointer files from `Claude/claude-code-sessions/34e4…/dc7f…/` to
   `Claude-Work/claude-code-sessions/d4dc…/723e…/`: 7 Alert Agents, 2 Chat Agents, 2 Routines
   (the sidebar groups), plus the 11 past runs of the three routines.
3. **Groups.** Added those sessions to Claude Work's own Alert Agents / Chat Agents / Routines
   groups in `dframe-group-scopes`.
4. **SSH.** Copied `ssh_configs.json` so the emu-box sessions can reconnect.

The main copy still lists the same sessions. Continue each one in **one** copy only: both
write to the same transcript.

`/restore-desktop-sessions` does the session-copy step for the *main* folder only (it hardcodes
`~/Library/Application Support/Claude`).

## Undo

- Routines: turn them back on in the main Claude; restore
  `scheduled-tasks.json.bak-20261022` in Claude Work's `d4dc…/723e…` folder.
- Groups: restore `claude_desktop_config.json.bak-20261022` in `Claude-Work`.
- Everything: remove the watchdog (above), delete `~/Applications/Claude Work.app` and
  `~/Library/Application Support/Claude-Work`.
