# Fix brief: #chat (82eae63a1bd3) bug/!todo fixes

You fix ONE reported item end to end and hand back proof. The coordinator posts in the room;
**you never post in any OM room or DM** (`om room say` etc. are off limits to you).

## Environment
Read `~/.claude/chat-todo-watch/ENV.md` first and follow it exactly (worktree setup, gates, `gui.sh`,
`tui.sh`, umask 022 before tests, Bun versions, traps). `baseline.md` has main's known test state.

## Git
- Worktree beside the repo, branched off a fresh `origin/main`: `~/repos/<repo>-<topic>`, branch
  `fix/<topic>`. Never work in the shared checkouts `~/repos/openmarket-chat` / `~/repos/openmarket`.
  Never `git stash`. Never `git add -A`; stage explicit paths.
- Identity: `git config user.email` must be `nicholaswong@trontalgroup.com`, name `Nicholas Wong`
  (set it in the worktree if not). Read the repo's AGENTS.md / CLAUDE.md first; its rules win.
- Commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` unless the repo says otherwise.
- openmarket-chat → GitLab MR (`glab mr create`, target main). openmarket-internal (`~/repos/openmarket`)
  → GitHub PR (`~/.local/bin/gh pr create --repo openmarket-xyz/openmarket-internal`, base main).
  Description ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
  **Never merge.** Not draft. After opening, check it merges cleanly and CI started.
- Code comments carry the WHY (the reported symptom and the cause), matching surrounding density.

## Proof (required, from the ACTUAL running app)
- BEFORE: build/run the merge-base (origin/main) in a second worktree or before your change, on your
  assigned port; AFTER: your branch, same port/viewport, same room/state. Reproduce the reported
  symptom in BEFORE; show it gone in AFTER. Desktop shot always; mobile (390x844) when layout-relevant.
  TUI/CLI items: `tui.sh` captures or terminal output rendered to PNG.
- If BEFORE does not reproduce the symptom, stop and report that instead of guessing a fix.
- Put the images in the MR/PR description. GitLab: upload via
  `curl --header "PRIVATE-TOKEN: $(glab config get token --host gitlab.com)" -F file=@x.png https://gitlab.com/api/v4/projects/<id>/uploads`
  and paste the returned markdown. GitHub: push the PNGs to the orphan branch `pr-screenshots`
  (create it if missing; folder `<topic>/`) and embed
  `https://github.com/openmarket-xyz/openmarket-internal/blob/pr-screenshots/<topic>/<file>.png?raw=true`.
- Privacy: the app is Nicholas's real account. Shots go to a public room, so never capture his DMs or
  private channels' content. Repro in a public channel where possible; otherwise also save a cropped
  version (`<name>-crop.png`) showing only the affected widget, and say which shots contain private content.
- Save final PNGs as `~/.claude/chat-todo-watch/shots/<seq>-before*.png` and `<seq>-after*.png`.
- The test daemons run as Nicholas's REAL account: never send messages, react, create topics, accept
  requests or change settings. Read-state changes needed for a repro (mark read/unread) are OK if you
  restore them afterwards. Stop your daemons/tmux at the end (`gui.sh stop`, `tui.sh stop`).

## Behaviour, not just pixels (Nicholas, 10-20)
Screenshots are not proof that it works. Exercise the real behaviour end to end in the running app
(click it, then confirm the effect actually happened: server state after a reload, data persisted,
other surfaces updated), plus edge cases and the "unchanged" paths around it. For server/CLI/MCP
changes run the built binary, not just unit tests. Hand back a table of each behaviour check: passed or
failed, with evidence. Anything you could not exercise is listed as NOT VERIFIED, never implied.

## Waiting on long runs
Every wait loop needs a hard deadline (e.g. `for i in $(seq 1 40); do …; sleep 15; done`), never a bare
`until grep … ; do sleep; done`, and wait on the process exiting (`wait $pid` / `kill -0`), not only on a
marker it may never write. Start ONE waiter per run, not a new one each time the Bash call detaches.
Before your final message, `pgrep -u nicholas -af '<your marker or worktree path>'` and kill leftovers.
(10-21: a verify agent left 16 marker-waiters looping for 15 h.)

## Gates
Typecheck, lint, build, and the relevant test files (add/extend a unit test for the fix).
openmarket-internal: GitHub CI may not run (org billing, 10-20), so run the PR workflow's gate list from
`.github/workflows` locally, including the generated-file checks (stdio catalog `--check`, TOOLS.md,
export dry run, tool-summary/surface goldens). An MCP tool-text change must regenerate those (10-21: #2086
missed them and the compiled stdio server shipped the old text until #2093). Compare any
failures to `baseline.md`; only new failures count.

## Hand back (final message)
1. MR/PR URL, branch, commit hash; merges cleanly? CI started?
2. Paths of before/after PNGs (and say what each shows).
3. Root cause in two sentences.
4. A 2–4 sentence reply for the reporter, plain language, no jargon, starting "🤖 agent: Fixed in review —".
5. Anything you could not verify, named plainly.
Remove your worktrees once the MR/PR exists (keep the branch).
