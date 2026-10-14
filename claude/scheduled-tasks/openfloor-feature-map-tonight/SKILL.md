---
name: openfloor-feature-map-tonight
description: One-shot overnight build of the full OpenFloor (openmarket-chat-app) Feature Map into Obisidian/openmarket-mobile/Feature Map
---

Build the complete Feature Map for OpenFloor, the mobile OM Chat app, tonight. Nicholas asked for this in place of tonight's midnight-scout run. Work unattended, ask no questions, and finish by about 08:00 local time.

The full contract is in /Users/nicholas/.local/share/midnight-scout/workspace/.claude/skills/openfloor-feature-map/SKILL.md. Read it first and follow it exactly: entry contract, read-versus-observed rule, emulator rules (never sign in, post, react or change settings), and write no product code, commit nothing, file no cards.

That skill was written for a launchd runner that sets environment variables. Here, you set them yourself:
- ROUTINE_WORK = /Users/nicholas/.local/state/routines/openfloor-feature-map/2026-09-18.work  (mkdir -p it)
- ROUTINE_HANDOFF = /Users/nicholas/.local/state/routines/openfloor-feature-map/2026-09-18.handoff.md
- Output dir: /Users/nicholas/Documents/Obisidian/openmarket-mobile/Feature Map/
- Repo: /Users/nicholas/Documents/GitlabRepos/openmarket-chat-app (read-only)

Steps:
1. Run the preflight: `ROUTINE_WORK=<ROUTINE_WORK> /Users/nicholas/.local/share/midnight-scout/workspace/.claude/skills/openfloor-feature-map/preflight`. If it exits non-zero, post the failure with `/Users/nicholas/.local/bin/scout-report.sh "<message>"` and stop.
2. Run the phases in order: inventory, map-1, map-2, map-3, map-4, map-5, map-6, digest. To keep your own context small, run each phase as its own blocking subagent (Agent tool, subagent_type general-purpose, run_in_background false). Give each one: the SKILL.md path, the phase name, the ROUTINE_WORK and ROUTINE_HANDOFF paths, and the output dir. Tell it to read the handoff first, do only its phase, and append its result line to the handoff before it finishes. A map phase gets about 60 minutes. If one fails or overruns, carry on with the next phase.
3. Always run the digest phase last, even if earlier phases failed. It sends exactly one report through /Users/nicholas/.local/bin/scout-report.sh.
4. Finish by replying with a short summary: features written, how many observed on a device versus source-read only, skipped slugs, and the README path.