# llm

The skills and subagents behind **om-bug-loop**, the Kanban-driven bug/feature pipeline for the OpenMarket repos.

## Layout

```
claude/
  skills/om-bug-loop/    Claude Code skill: the board watcher + coordinator (SKILL.md, references, templates, scripts)
  agents/                Claude Code subagents the loop dispatches
    om-task.md             owns a bug from card to shipped commits on a batch PR
    om-quickfix.md         the trivial tier (typos, null checks, copy changes)
    om-feature.md          owns a #feature card
    om-research.md         owns a #research card, ends in an architecture doc
    om-verifier.md         the independent verification gate
    om-play-around.md      plays one OM Chat feature, files findings as cards
    om-play-around-mobile.md  same, for OpenFloor on the iOS simulator
codex/
  skills/om-implementer/ Codex skill: house rules for writing the diff against an approved plan
```

## Install

```bash
ln -s "$PWD/claude/skills/om-bug-loop" ~/.claude/skills/om-bug-loop
ln -s "$PWD"/claude/agents/*.md ~/.claude/agents/
ln -s "$PWD/codex/skills/om-implementer" ~/.codex/skills/om-implementer
```

The scripts run on [Bun](https://bun.sh): `bun test claude/skills/om-bug-loop/scripts/`.

## Not included

- **Feature Maps** (`references/features`, `features-mobile`, `features-charts`). These are product docs kept in the Obsidian vault (`openmarket/Feature Map`, `openmarket-mobile/Feature Map`, `openmarket-charts/Feature Map`). Symlink them back into `claude/skills/om-bug-loop/references/` for the skill to use them.
- **Runtime state** (`~/.claude/om-bug-loop/`: `tasks.json`, trains, evidence, auth). It is machine-local and is recreated as the loop runs.
- The `.bak-*` / `.REJECTED-*` snapshots from the source directories.

Several references in the source are symlinks into the vault; this repo holds copies of those files as of the snapshot date, not links.
