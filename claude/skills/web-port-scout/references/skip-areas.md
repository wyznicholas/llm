# Web paths with no mobile counterpart

A unit is skipped without judgement only when EVERY file it touches matches one
of these globs (exact list lines only; `scout.ts` ignores prose). Keep it narrow:
anything a mobile user could feel belongs to judgement, not to this list.
wrun, release notes and locales are deliberately absent: mobile runs
Marketplace packages on wrun and has its own release-notes page.

- `docs/**` — web feature docs
- `tests/**` — web tests
- `qa/**` — web QA material
- `.gitlab/**` — web CI
- `.husky/**` — git hooks
- `.claude/**` — agent config
- `.loop/**` — agent loop state
- `.perf-sentinel-remediator/**` — perf bot state
- `.vscode/**` — editor config
- `llm/**` — agent docs
- `tooling/**` — repo tooling
- `scripts/**` — repo scripts
- `dev-fixtures/**` — local dev fixtures
- `src/components/scriptEditor/**` — the desktop script editor IDE
- `src/composables/scriptEditor/**` — script editor state
- `src/utility/scriptEditor/**` — script editor helpers
- `src/constants/scriptEditor/**` — script editor templates
- `src/store/editor-shell.ts` — script editor shell store
- `**/*.spec.ts` — colocated specs
- `**/*.test.ts` — colocated tests
