Implement the approved fix plan below exactly. You are in a dedicated git
worktree on branch {{branch}}; the plan is the contract — do not widen scope.

House rules (non-negotiable):
- Commit on this branch only. NEVER push. NEVER open a PR/MR.
- No AI attribution of any kind in commits or files.
- Never run `git stash` or `git add -A`; stage exact paths.
- **NEVER install dependencies or write a lockfile.** Not `bun install`, not
  `pnpm install`, not `npm install`, not `yarn install`, not `--frozen-lockfile`,
  and not to "repair" a package that looks missing. **(chat lane)** `node_modules`
  here is a **symlinked overlay** shared with the main checkout, so an install in
  this worktree can corrupt a DIFFERENT worktree that other tasks are working in
  right now. Private packages 404 anyway, so the install fails after it has
  already done damage. If a dependency genuinely looks missing or mispinned,
  **stop and say so**; do not repair it.
  (Hit live 2026-09-04: Codex ran `pnpm install --frozen-lockfile` because the
  prompt named only `bun install` — name every package manager, not just the
  lane's own. It exited before mutating anything: luck, not design.)
- **(chart lane)** `pnpm`, never `bun`. `.env` is untracked — the worktree needs
  a copy. `pnpm typecheck` is red on `main` with ~1428 errors: diff the error
  set for the files you touched, never read its exit code as a verdict.
- Repo gate must pass before you declare done:
  {{gate_command}}
- **Run ONLY the tests scoped to the component you changed. Never the whole
  suite.** The full suite belongs to the reviewer, not to you — running it here
  doubles the machine's load for a signal you are not the one who acts on.
  Scope it by path filter. **(chat lane)** `bun tools/test-fast.ts --shards 2
  <filter>`. **(chart lane)** `pnpm vitest run --config vitest.node.config.ts
  <filter>` — `tools/test-fast.ts` is an `openmarket-chat` file and does not
  exist in the chart repos.
  `--shards 2` keeps several agents working at once without each one sizing
  itself for the whole machine (the default is one shard per core, which
  assumes it runs alone).
  **(chat lane)** **`--shards` is a `test-fast.ts` flag, NOT a `bun test` one.** `bun test
  --shards 2 <path>` does not error: bun reads the bare `2` as another path
  filter and silently runs every test file whose path contains a "2". Measured
  on T20 — six paths ran `251 tests across 8 files` with it and `233 across 6`
  without, the extras being `backoff-429.test.ts` and `todo-display-l2.test.ts`.
  If you invoke `bun test` directly, pass files and nothing else.
  Scope by the **TRANSITIVE importer closure**, not direct importers: walk the
  importer graph outward from every file you changed until it stops growing,
  then take every test file in it. Include lazy/dynamic references, not just
  `import` statements. One level is not enough — a change to `RightPanels.tsx`
  broke `topic-list-view.test.ts` (77 pass -> 18 pass / 59 fail) and
  `center-column-boundary.test.tsx` (3 -> 0) because those tests exercise
  `ChatPane`/`TopicListView`, which import `RightPanels`. Two hops out, and a
  one-level scan never saw them.
  This scoped run is your fast inner loop. It is NOT regression evidence and
  must never be cited as proof that nothing else broke.
- If the plan cannot be implemented as written, STOP and write the blocker
  to BLOCKED.md in the worktree root instead of improvising.

The plan:

{{plan_markdown}}
