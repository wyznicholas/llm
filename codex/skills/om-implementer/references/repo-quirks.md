# Repo quirks and the parity fence

*A reference for `om-implementer`. The SKILL carries the contract and the hard rules; this file carries the how. If the two ever disagree, the SKILL wins and this one is the bug.*

> **Staleness warning (2026-09-11):** cloud-fork work stopped 2026-09-08.
> Everything below mentioning `openmarket-chat-cloud` is kept for the record
> but should not come up in a current task. If it does, say so — it means a
> task was scoped into a lane that was retired.

`openmarket-chat` and `openmarket-chat-cloud` are forks that share files by manifest, not by sync. After editing anything the manifest tracks:

```bash
bun tools/sync-shared.ts --diff <path-to-the-other-fork-worktree>
```

From a linked worktree you **must** pass the source path explicitly — the default `../openmarket-chat` does not exist there. Never full-sync, and never `--refresh` without first confirming your files are the only ones off their pin; it re-pins the whole manifest and would silently bless someone else's uncommitted edit.

Say in the commit body which shared files changed. A cross-fork port is a **separate task** — do not reach into the other repo.


## Quirks

- **`grep -a` in `openmarket-chat`.** A stray NUL byte makes plain `grep` skip files silently — including real test files — so a search can come back empty and wrong.
- **A wall of `TS2307` / `TS2724` / `MISSING_EXPORT` naming `@openmarket/rooms-client`** is almost always a stale built `dist` in the dependency, not a broken branch. Report it; do not start rewriting imports.
- **`openmarket-chat-cloud/node_modules` is a symlink — the entire directory** — pointing into `openmarket-chat`. Anything that substitutes a package there writes into the *other* repo. Read-only use is fine.
- **`bun run build` fails on `openmarket-chat-cloud` even on a clean `main`** (`MISSING_EXPORT "fromBinary"/"toJson"`). It is not a usable gate there and not something you caused.

