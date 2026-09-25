# om-bug-loop Implementation Plan

> **Path note (2026-09-07):** the kanban moved from `Obisidian/openmarket/kanban/` to the vault root, `Obisidian/kanban/`, because every repo uses the board. Every `openmarket/kanban/...` path below is historical — read it as `kanban/...`. The live convention is `kanban/Kanban Rotation.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the om-bug-loop skill: a zero-token watcher that detects new unclaimed to-dos in the ⌗ OM Chat Bugs topic, plus the coordinator playbook that investigates each, gates on Nicholas's approval, implements via headless Codex, and verifies with an evidence-based Opus review.

**Architecture:** A bun watcher script polls the local daemon's rooms proxy (operator-cookie auth) with a `sinceSeq` cursor, folds `!todo` marker events into a board, and exits when a new eligible to-do appears — waking the coordinator session. The coordinator (SKILL.md playbook) dispatches per-task background agents and owns the approval gate. All state is on disk.

**Tech Stack:** bun (scripts + tests), curl-free (bun `fetch`), Claude Code background agents, `codex exec`, existing `/verify` + testing-harness skills.

**Spec:** `~/.claude/skills/om-bug-loop/docs/2026-09-01-om-bug-loop-design.md`

## Global Constraints

- Never edit or commit in the shared `~/Documents/GitlabRepos/*` checkouts; all implementation work happens in fresh sibling worktrees (e.g. `~/Documents/GitlabRepos/wt/<repo>-<slug>`), never nested inside a repo (openmarket-chat's test runner drags in nested worktrees).
- No `git stash` anywhere under GitlabRepos (shared `refs/stash` across worktrees).
- No `git add -A` in worktrees with node_modules symlinks; add paths explicitly.
- openmarket-chat house rules (AGENTS.md): no AI attribution in commits or files; no push without explicit per-instance operator OK — in this pipeline Nicholas's per-task "ok" is that authorization, and the verified MR push is its scope.
- Shared-file edits in openmarket-chat follow the parity fence: `bun tools/sync-shared.ts --diff` before judging, hand-port never full-sync.
- Skill lives at `~/.claude/skills/om-bug-loop/`; runtime state at `~/.claude/om-bug-loop/` (state.json, pending/, plans/, evidence/).
- Kanban mirror: `/Users/nicholas/Documents/Obisidian/openmarket/kanban/Kanban.md` ("Obisidian" spelling is the real path), rendered by the Obsidian **Kanban community plugin** — file format: YAML frontmatter `kanban-plugin: board`, one `## <Column>` heading per column in order `todo`, `todo review`, `in progress`, `Need Attention`, `Review`, `Done`, cards as `- [ ] <text>` lines under their column, and any `%% kanban:settings %%` trailer preserved verbatim. Only the coordinator writes this file, always via `scripts/kanban.ts`. Per-task notes live at `kanban/cards/<slug>.md`, evidence copies at `kanban/evidence/<slug>/` (inside the vault, so embeds render).
- Daemon facts (verified 2026-09-01): GUI daemon `http://localhost:31417`; room `b4472fc1fbd3` (#dev-forums); topic `7f30222f` (⌗ OM Chat Bugs). Operator cookie `om_operator_31417` is minted by any GET of `/rooms` (Set-Cookie on the document response) and must be re-minted on 401 `badge_token_required`. Events REST: `GET /api/rooms/rooms/<room>/events?limit=200[&sinceSeq=N|&beforeSeq=N]` → `{entries, upToSeq, hasMore}`; entries carry `seq, ts, type, text, handle, userId, topicId, inReplyTo, attachments, todoCurrent`.
- To-do grammar (authoritative: `openmarket-chat/src/lib/channel-todos.ts`): a to-do is a `post` entry whose ENTIRE trimmed text is a marker. Creates: `!todo Title\nDescription…`. Lifecycle replies (linked by `inReplyTo` → create seq), exact text: `!claim`, `!release`, `!done`, `!reopen`, `!cancel`, `!nudge`; routing: `!assign @handle`, `!unassign @handle` (one token, lowercased); content: `!edit Title\nDescription…`. Case-sensitive, exact match. Entries with `ts < Date.UTC(2026, 7, 4)` never parse as markers (TODO_EPOCH_MS).

---

### Task 1: Scaffold + API reference

**Files:**
- Create: `~/.claude/skills/om-bug-loop/references/api.md`
- Create: `~/.claude/om-bug-loop/` (dirs: `pending/`, `plans/`, `evidence/`)
- Already exists: `~/.claude/skills/om-bug-loop/docs/` (spec + this plan)

**Interfaces:**
- Produces: `references/api.md`, the single place every later script and agent prompt points at for daemon endpoints, auth, and grammar.

- [x] **Step 1: Create runtime dirs**

```bash
mkdir -p ~/.claude/om-bug-loop/pending ~/.claude/om-bug-loop/plans ~/.claude/om-bug-loop/evidence ~/.claude/skills/om-bug-loop/references/features ~/.claude/skills/om-bug-loop/scripts ~/.claude/skills/om-bug-loop/templates
```

- [x] **Step 2: Write `references/api.md`** with exactly the "Daemon facts" and "To-do grammar" content from Global Constraints above, expanded with these verified extras: attachments resolve via `GET /api/rooms/rooms/<room>/attachment-url?key=<urlencoded key>` (200, returns a signed URL); topics list via `GET /api/rooms/rooms/<room>/topics?includeResolved=true&withState=true&limit=200`; the events read draws the relay's `readHistory` budget, so scripts keep `limit=200` and never poll faster than 60s; response envelope is `{success, room, entries, upToSeq, hasMore, readOnly}`.

- [x] **Step 3: Verify the reference is honest**

Run:
```bash
curl -sc /tmp/om-jar.txt "http://localhost:31417/rooms" -o /dev/null && curl -sb /tmp/om-jar.txt "http://localhost:31417/api/rooms/rooms/b4472fc1fbd3/events?limit=1" | head -c 200
```
Expected: `{"success":true,"room":"dev-forums","entries":[...`

---

### Task 2: `todo-fold.ts` — pure marker fold (TDD)

**Files:**
- Create: `~/.claude/skills/om-bug-loop/scripts/todo-fold.ts`
- Test: `~/.claude/skills/om-bug-loop/scripts/todo-fold.test.ts`

**Interfaces:**
- Produces:
  - `TODO_EPOCH_MS: number`
  - `parseMarker(text: string | undefined): Marker | null` where `Marker = { op: "todo"|"edit"|"claim"|"release"|"done"|"reopen"|"cancel"|"nudge"|"assign"|"unassign"; title?: string; description?: string; targetHandle?: string }`
  - `foldTodos(entries: LedgerEntry[]): Map<number, Todo>` where `LedgerEntry = { seq: number; ts: number; type: string; text?: string; handle: string; topicId?: string; inReplyTo?: number; attachments?: unknown[]; todoCurrent?: { title?: string; description?: string } }` and `Todo = { seq: number; ts: number; title: string; description: string; createdBy: string; status: "open"|"done"|"canceled"; holders: string[]; attachments: unknown[]; eventSeqs: number[] }`
  - `eligible(board: Map<number, Todo>): Todo[]` — `status === "open"` and `holders.length === 0`
- Consumes: nothing (pure; port of the grammar in `channel-todos.ts`).

- [x] **Step 1: Write the failing tests**

```ts
// todo-fold.test.ts
import { describe, expect, test } from "bun:test";
import { TODO_EPOCH_MS, eligible, foldTodos, parseMarker } from "./todo-fold";

const T = TODO_EPOCH_MS + 1_000_000;
const post = (seq: number, text: string, extra: object = {}) =>
  ({ seq, ts: T + seq, type: "post", text, handle: "reagan", ...extra });

describe("parseMarker", () => {
  test("create with title and description", () =>
    expect(parseMarker("!todo Fix reset button\nGreyed out after failed upload")).toEqual({
      op: "todo", title: "Fix reset button", description: "Greyed out after failed upload" }));
  test("bare lifecycle ops exact-match only", () => {
    expect(parseMarker("!done")).toEqual({ op: "done" });
    expect(parseMarker("!done thanks")).toBeNull();
  });
  test("assign takes exactly one @handle, lowercased", () => {
    expect(parseMarker("!assign @Nicholas")).toEqual({ op: "assign", targetHandle: "nicholas" });
    expect(parseMarker("!assign nicholas")).toBeNull();
    expect(parseMarker("!assign @a @b")).toBeNull();
  });
  test("ordinary text is not a marker", () => expect(parseMarker("fixed it!")).toBeNull());
});

describe("foldTodos", () => {
  test("create opens an eligible todo", () => {
    const board = foldTodos([post(10, "!todo Emoji burst lags")]);
    expect(board.get(10)).toMatchObject({ status: "open", holders: [], title: "Emoji burst lags" });
    expect(eligible(board).map(t => t.seq)).toEqual([10]);
  });
  test("claim then release returns to eligible", () => {
    const entries = [post(10, "!todo X"), post(11, "!claim", { handle: "nicholas", inReplyTo: 10 })];
    expect(eligible(foldTodos(entries))).toHaveLength(0);
    entries.push(post(12, "!release", { handle: "nicholas", inReplyTo: 10 }));
    expect(eligible(foldTodos(entries))).toHaveLength(1);
  });
  test("assign holds it; unassign of that handle frees it", () => {
    const entries = [post(10, "!todo X"), post(11, "!assign @elven", { inReplyTo: 10 })];
    expect(eligible(foldTodos(entries))).toHaveLength(0);
    entries.push(post(12, "!unassign @elven", { inReplyTo: 10 }));
    expect(eligible(foldTodos(entries))).toHaveLength(1);
  });
  test("done and cancel close; reopen reopens unheld", () => {
    const entries = [post(10, "!todo X"), post(11, "!done", { inReplyTo: 10 })];
    expect(foldTodos(entries).get(10)!.status).toBe("done");
    entries.push(post(12, "!reopen", { inReplyTo: 10 }));
    expect(eligible(foldTodos(entries))).toHaveLength(1);
  });
  test("todoCurrent wins over parsed text; edit updates content", () => {
    const board = foldTodos([
      post(10, "!todo Old title", { todoCurrent: { title: "New title" } })]);
    expect(board.get(10)!.title).toBe("New title");
    const edited = foldTodos([post(10, "!todo Old"), post(11, "!edit Newer", { inReplyTo: 10 })]);
    expect(edited.get(10)!.title).toBe("Newer");
  });
  test("pre-epoch and non-post entries never fold", () => {
    const board = foldTodos([
      { seq: 1, ts: TODO_EPOCH_MS - 1, type: "post", text: "!todo Ancient", handle: "x" },
      { seq: 2, ts: T, type: "system", text: "!todo Systemish", handle: "x" }]);
    expect(board.size).toBe(0);
  });
  test("lifecycle op replying to a non-todo is ignored", () => {
    const board = foldTodos([post(10, "hello"), post(11, "!done", { inReplyTo: 10 })]);
    expect(board.size).toBe(0);
  });
});
```

- [x] **Step 2: Run tests, verify they fail**

Run: `cd ~/.claude/skills/om-bug-loop/scripts && bun test todo-fold.test.ts`
Expected: FAIL — cannot resolve `./todo-fold`

- [x] **Step 3: Implement `todo-fold.ts`**

```ts
// Pure fold of OM Chat "!todo" ledger markers into a board.
// Grammar port of openmarket-chat/src/lib/channel-todos.ts — that file is
// the authority; on divergence, fix THIS copy.
export const TODO_EPOCH_MS = Date.UTC(2026, 7, 4);

export type MarkerOp =
  | "todo" | "edit" | "claim" | "release" | "done"
  | "reopen" | "cancel" | "nudge" | "assign" | "unassign";
export interface Marker { op: MarkerOp; title?: string; description?: string; targetHandle?: string }
export interface LedgerEntry {
  seq: number; ts: number; type: string; text?: string; handle: string;
  topicId?: string; inReplyTo?: number; attachments?: unknown[];
  todoCurrent?: { title?: string; description?: string };
}
export interface Todo {
  seq: number; ts: number; title: string; description: string; createdBy: string;
  status: "open" | "done" | "canceled"; holders: string[];
  attachments: unknown[]; eventSeqs: number[];
}

const LIFECYCLE = ["claim", "release", "done", "reopen", "cancel", "nudge"] as const;

function parseContent(trimmed: string, op: "todo" | "edit"): Marker | null {
  const prefix = `!${op}`;
  if (!trimmed.startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length);
  if (!/^\s/.test(rest)) return null;
  const body = rest.trim();
  const nl = body.indexOf("\n");
  const title = (nl < 0 ? body : body.slice(0, nl)).trim();
  if (!title) return null;
  const description = nl < 0 ? "" : body.slice(nl + 1).trim();
  return { op, title, ...(description ? { description } : {}) };
}

function parseTargeted(trimmed: string, op: "assign" | "unassign"): Marker | null {
  const prefix = `!${op}`;
  if (!trimmed.startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length);
  if (!/^\s/.test(rest)) return null;
  const tokens = rest.trim().split(/\s+/);
  if (tokens.length !== 1) return null;
  const token = tokens[0] ?? "";
  const handle = token.replace(/^@/, "").toLowerCase();
  if (!handle || token.toLowerCase() !== `@${handle}`) return null;
  return { op, targetHandle: handle };
}

export function parseMarker(text: string | undefined | null): Marker | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("!")) return null;
  for (const op of LIFECYCLE) if (trimmed === `!${op}`) return { op };
  return (
    parseTargeted(trimmed, "assign") ?? parseTargeted(trimmed, "unassign") ??
    parseContent(trimmed, "edit") ?? parseContent(trimmed, "todo")
  );
}

export function foldTodos(entries: LedgerEntry[]): Map<number, Todo> {
  const board = new Map<number, Todo>();
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  for (const e of sorted) {
    if (e.type !== "post" || e.ts < TODO_EPOCH_MS) continue;
    const m = parseMarker(e.text);
    if (!m) continue;
    if (m.op === "todo") {
      board.set(e.seq, {
        seq: e.seq, ts: e.ts,
        title: e.todoCurrent?.title ?? m.title ?? "",
        description: e.todoCurrent?.description ?? m.description ?? "",
        createdBy: e.handle, status: "open", holders: [],
        attachments: e.attachments ?? [], eventSeqs: [e.seq],
      });
      continue;
    }
    const target = e.inReplyTo === undefined ? undefined : board.get(e.inReplyTo);
    if (!target) continue;
    target.eventSeqs.push(e.seq);
    const hold = (h: string) => { if (!target.holders.includes(h)) target.holders.push(h); };
    const free = (h: string) => { target.holders = target.holders.filter(x => x !== h); };
    switch (m.op) {
      case "claim": hold(e.handle.toLowerCase()); break;
      case "release": free(e.handle.toLowerCase()); break;
      case "assign": hold(m.targetHandle!); break;
      case "unassign": free(m.targetHandle!); break;
      case "done": target.status = "done"; break;
      case "cancel": target.status = "canceled"; break;
      case "reopen": target.status = "open"; target.holders = []; break;
      case "edit":
        target.title = m.title ?? target.title;
        target.description = m.description ?? target.description;
        break;
      case "nudge": break;
    }
  }
  return board;
}

export const eligible = (board: Map<number, Todo>): Todo[] =>
  [...board.values()].filter(t => t.status === "open" && t.holders.length === 0);
```

- [x] **Step 4: Run tests, verify they pass**

Run: `cd ~/.claude/skills/om-bug-loop/scripts && bun test todo-fold.test.ts`
Expected: all tests PASS

---

### Task 3: `watch-todos.ts` — the zero-token watcher

**Files:**
- Create: `~/.claude/skills/om-bug-loop/scripts/watch-todos.ts`
- Test: `~/.claude/skills/om-bug-loop/scripts/watch-todos.test.ts` (cursor/pending logic against an in-process fake daemon)

**Interfaces:**
- Consumes: `foldTodos`, `eligible`, `TODO_EPOCH_MS`, `parseMarker` from `./todo-fold`.
- Produces (CLI): `bun watch-todos.ts --once` (single poll, prints JSON `{new: Todo[], eligibleNow: number}` and writes pending files; exit 0); `bun watch-todos.ts --watch` (loop: poll every 60s; on new eligible to-do write `~/.claude/om-bug-loop/pending/<seq>.json` and EXIT 0; after 4h with no news EXIT 3; after 10 consecutive poll failures EXIT 2); `--state <dir>` overrides the state dir (tests use it).
- Produces (files): `pending/<seq>.json` = the full `Todo` plus `{room, topicId, detectedAt}`; `state.json` = `{cursor: number, markers: LedgerEntry[], dispatched: number[]}` (markers = only marker entries in the topic — a few KB; `dispatched` is APPENDED BY THE COORDINATOR, the watcher only reads it).

- [x] **Step 1: Write the failing tests** — spin a `Bun.serve` fake daemon in-process serving `/rooms` (Set-Cookie) and `/api/rooms/rooms/:room/events` from a mutable in-memory ledger; cases: (a) first run with empty state backfills to epoch and writes one pending file per eligible todo, exit 0; (b) run with `dispatched:[seq]` writes nothing for that seq; (c) `sinceSeq` incremental poll picks up a `!claim` and stops treating the todo as new; (d) 401-once then success (cookie re-mint path). Use `--once --state <tmpdir> --daemon http://localhost:<fakePort>` (add `--daemon` flag for testability).

```ts
// watch-todos.test.ts — shape (implement fully in this task):
import { afterAll, beforeAll, expect, test } from "bun:test";
// fake daemon: ledger array served with sinceSeq/beforeSeq/limit semantics
// matching references/api.md; first request without cookie answers 401
// {error:"badge_token_required"}; GET /rooms sets om_operator cookie.
// Each test: run Bun.spawnSync(["bun", "watch-todos.ts", "--once", "--state", dir,
// "--daemon", origin]) and assert on exit code, stdout JSON, pending/ contents.
```

- [x] **Step 2: Run tests, verify they fail** (`bun test watch-todos.test.ts` — module missing)

- [x] **Step 3: Implement `watch-todos.ts`**

Requirements the code must satisfy (mirror `references/api.md`):
- Constants: `DAEMON` (default `http://localhost:31417`, `--daemon` overrides), `ROOM=b4472fc1fbd3`, `TOPIC=7f30222f`, `POLL_MS=60_000`, `HEARTBEAT_MS=14_400_000`, `PAGE_LIMIT=200`, `MAX_BACKFILL_PAGES=120`, `MAX_FAILURES=10`.
- Cookie: keep the `om_operator_*` cookie from `GET ${DAEMON}/rooms`; on any 401 with body `error=="badge_token_required"`, re-mint ONCE and replay (single-flight, like the GUI's operator-remint).
- First run (no `state.json`): page back with `beforeSeq` until the oldest entry's `ts < TODO_EPOCH_MS` or `hasMore=false` or `MAX_BACKFILL_PAGES`; keep only entries where `topicId===TOPIC && parseMarker(text)!==null`; set `cursor` to the newest seq seen in the FULL room (not just topic).
- Subsequent polls: `GET events?sinceSeq=${cursor}&limit=200`, loop while `hasMore`, advance cursor to max seq, append new topic markers (dedupe by seq).
- After each poll: `board = foldTodos(state.markers)`; `fresh = eligible(board).filter(t => !state.dispatched.includes(t.seq) && !exists(pending/${t.seq}.json))`; write each as pending JSON; if any, print them and exit 0 (in `--watch`) — `--once` always exits 0 after one poll, printing `{new, eligibleNow}`.
- Persist `state.json` after every successful poll (atomic: write tmp + rename). Never write `dispatched` (read-only to the watcher).
- `--watch` exits: 0 = news, 3 = heartbeat (4h quiet), 2 = 10 consecutive failures (daemon down). Log one line per state change to stderr, silence otherwise.

- [x] **Step 4: Run tests, verify they pass** (`bun test watch-todos.test.ts`)

- [x] **Step 5: Live smoke against the real daemon**

Run: `bun ~/.claude/skills/om-bug-loop/scripts/watch-todos.ts --once`
Expected: exit 0; JSON with `eligibleNow` ≥ 0 and `new: []` or listing genuinely unclaimed open to-dos (cross-check by eye against the Todos panel in the GUI at http://localhost:31417/rooms#/b4472fc1fbd3/topic/7f30222f). `~/.claude/om-bug-loop/state.json` exists with a numeric cursor near the room tip (~9400+).

---

### Task 4: `topic-context.ts` — the investigation lever

**Files:**
- Create: `~/.claude/skills/om-bug-loop/scripts/topic-context.ts`

**Interfaces:**
- Consumes: `parseMarker` from `./todo-fold` (to label marker entries in output); cookie/paging helpers may be copied from watch-todos or extracted to `./daemon-api.ts` if both need them (implementer's choice; if extracted, watch-todos tests must still pass).
- Produces (CLI): `bun topic-context.ts --todo <createSeq> [--window 40] [--out <dir>]` → prints markdown: the to-do (title/description/creator), its source message (the create's `inReplyTo`, when the to-do was promoted from a report), every reply in its thread, and the `--window` surrounding topic messages (timestamps, handles, text); downloads every attachment on those messages via `attachment-url` into `--out` (default `~/.claude/om-bug-loop/evidence/<createSeq>/context/`), naming video files so a frame can be extracted (`ffmpeg -ss 2 -i in.mov -frames:v 1 out.png`).

- [x] **Step 1: Implement it** — page `beforeSeq` from the room tip collecting `topicId===TOPIC` entries until the window around `createSeq` is covered (or 150 pages); resolve+download attachments with the minted cookie; emit markdown to stdout.

- [x] **Step 2: Live verification**

Run: `bun ~/.claude/skills/om-bug-loop/scripts/topic-context.ts --todo <seq of any past to-do from Task 3's board> --window 10`
Expected: markdown containing the to-do's title, at least one neighboring message recognizable from the topic transcript (e.g. ReaganC's upload-reset report), and downloaded attachment files with nonzero size in the out dir.

---

### Task 4b: `kanban.ts` — board mirror (TDD)

**Files:**
- Create: `~/.claude/skills/om-bug-loop/scripts/kanban.ts`
- Test: `~/.claude/skills/om-bug-loop/scripts/kanban.test.ts`

**Interfaces:**
- Produces (CLI):
  - `bun kanban.ts init` — writes the board skeleton to Kanban.md ONLY if the file is empty/absent (never clobbers an existing board): frontmatter `---\nkanban-plugin: board\n---`, then the six `## <Column>` headings from Global Constraints, blank line between columns.
  - `bun kanban.ts upsert <slug> --column <col> --title <text>` — creates or moves the card `- [ ] **{title}** `[[cards/{slug}|details]]` #om-bug-loop` to `<col>` (idempotent: one card per slug, matched by the `[[cards/<slug>|` link; a move preserves the card text unless `--title` is given).
  - `bun kanban.ts note <slug> --file <md>` — writes/overwrites `kanban/cards/<slug>.md` from the given markdown file.
  - `--board <path>` overrides the board path (tests use a temp vault).
- Produces (library): `moveCard(markdown: string, slug: string, column: string, title?: string): string` — the pure transform the CLI wraps; preserves all unrelated lines byte-for-byte including `%% kanban:settings %%` trailers and cards created by hand.
- Consumes: nothing from other tasks.

- [x] **Step 1: Write the failing tests** — cases: init on empty file produces the six columns in order; init refuses a non-empty file (exit 1, file untouched); upsert into `todo` adds a card under the right heading; upsert again with `--column Review` moves the same card (no duplicate) and leaves a hand-written card and the settings trailer untouched; slugs that collide as substrings (`search`, `search-filter`) do not cross-match.

- [x] **Step 2: Run tests, verify they fail** (`bun test kanban.test.ts` — module missing)

- [x] **Step 3: Implement** — parse by lines: split on `^## ` headings; a card is any line matching `^- \[.\] .*\[\[cards/<slug>\|`; move = delete from old column, append under target heading (before the next heading). Atomic write (tmp+rename).

- [x] **Step 4: Run tests, verify they pass**

- [x] **Step 5: Live init** — run `bun kanban.ts init`; open check: `head -12 /Users/nicholas/Documents/Obisidian/openmarket/kanban/Kanban.md` shows the frontmatter and the six headings; also `mkdir -p .../kanban/cards .../kanban/evidence`.

---

### Task 5: Templates

**Files:**
- Create: `~/.claude/skills/om-bug-loop/templates/plan-template.md`
- Create: `~/.claude/skills/om-bug-loop/templates/codex-prompt.md`
- Create: `~/.claude/skills/om-bug-loop/templates/reviewer-prompt.md`

**Interfaces:**
- Produces: the three prompt/document skeletons SKILL.md references by path. Placeholders use `{{double_braces}}` and are filled by the coordinator with sed-level substitution (no templating engine).

- [x] **Step 1: `plan-template.md`** — sections in this exact order: `# Plan: {{title}} (todo {{seq}})`, `## Problem` (plain-language paragraph), `## Evidence` (screenshot path + how obtained: `own-repro` or `reporter-video-frame`; source message link `http://localhost:31417/rooms#/b4472fc1fbd3/topic/7f30222f`), `## Reproduction steps` (numbered, user POV), `## Root cause` (file:line references), `## Fix plan` (ordered steps, exact files), `## Verification spec` (bullet list: each check phrased as "FAILS before / PASSES after: <command or GUI action + expected observation>"; plus the repo static gate command), `## Risk` (blast radius; regression-impact-check output when kiyotaka-frontend is touched).

- [x] **Step 2: `codex-prompt.md`**:

```markdown
Implement the approved fix plan below exactly. You are in a dedicated git
worktree on branch {{branch}}; the plan is the contract — do not widen scope.

House rules (non-negotiable):
- Commit on this branch only. NEVER push. NEVER open a PR/MR.
- No AI attribution of any kind in commits or files.
- Never run `git stash` or `git add -A`; stage exact paths.
- openmarket-chat shared files: run `bun tools/sync-shared.ts --diff` after
  editing anything the parity manifest tracks, and say in the commit body
  which shared files changed.
- Repo gate must pass before you declare done:
  {{gate_command}}
- If the plan cannot be implemented as written, STOP and write the blocker
  to BLOCKED.md in the worktree root instead of improvising.

The plan:

{{plan_markdown}}
```

- [x] **Step 3: `reviewer-prompt.md`**:

```markdown
You are the verification gate (run as Opus). Philosophy: evidence, not
claims — a change is not done until it is proven in the real running app.
Work through ALL of the following and paste artifacts, not assertions.

Inputs: worktree {{worktree}} (branch {{branch}}), approved plan
{{plan_path}}, codex log {{codex_log}}, evidence dir {{evidence_dir}}.

1. Code review the diff against the approved plan: correctness, scope creep,
   house conventions (read the repo's CLAUDE.md/AGENTS.md first).
2. Run the /verify skill using the plan's "Verification spec" section as the
   repro: every check must FAIL on the merge-base and PASS on the fix; run
   the repo static gate, diffing error sets against a same-commit baseline
   worktree where main is already red. Save verify-report.md to the
   evidence dir.
3. Real-app proof: build the GUI, get it served by the local daemon
   (om-build / testing-harness know how), walk the reproduction steps from
   the plan in the actual GUI, and save before/after screenshots into
   {{evidence_dir}}. The bug must be visibly gone.
4. Feature Map upkeep: create or update
   ~/.claude/skills/om-bug-loop/references/features/<surface>.md for the
   surface you drove (what it is, how a user reaches it, how you drove it,
   gotchas discovered).
5. Evidence package for the Review card: copy the decisive before/after
   screenshots into {{vault_evidence_dir}} and, when the fix concerns
   motion or timing (animation, transitions, streaming), also record the
   fixed behavior as a short video/GIF (testing-harness's browser can
   capture one) and copy it there too. Then write the card note to
   {{card_note_path}}: problem, repro steps, what changed, MR link,
   verify-report link, and the evidence EMBEDDED with ![[...]] syntax.
6. Verdict:
   - PASS: push the branch, open the MR (never Draft), check merge status
     and rebase-resolve conflicts, then report: MR URL, verify-report path,
     screenshot paths, card note path, Feature Map entry touched.
   - FAIL: write a precise failure report (what check, expected vs observed,
     suspected cause) to {{evidence_dir}}/review-fail.md and report it. Do
     NOT push anything and do NOT write a card note.
Respect the same house rules given to the implementer (no AI attribution,
no stash, exact-path staging, parity fence).
```

---

### Task 6: SKILL.md — the coordinator playbook

**Files:**
- Create: `~/.claude/skills/om-bug-loop/SKILL.md`

**Interfaces:**
- Consumes: everything above by path.
- Produces: the user-invocable skill (`/om-bug-loop`).

- [x] **Step 1: Pin the codex invocation** (the one flag-set the playbook will hardcode)

Run: `codex exec --help | head -40`
Expected: confirms `--cd <dir>` (working dir), a non-interactive default, and a sandbox/approval flag. Record the exact chosen invocation in SKILL.md as, e.g.:
```bash
codex exec --cd "$WORKTREE" --sandbox workspace-write "$(cat "$PROMPT_FILE")" > "$EVIDENCE/codex.log" 2>&1
```
(If flags differ, adjust here and in SKILL.md — this step exists precisely to pin them from the installed CLI, not from memory.)

- [x] **Step 2: Write SKILL.md** with frontmatter `name: om-bug-loop`, `description: Watch the ⌗ OM Chat Bugs topic for promoted to-dos; investigate, plan, gate on approval, implement via Codex, verify with evidence. Trigger: /om-bug-loop [start|status|stop]`, `user-invocable: true`; body covering, in order:
  1. **State machine** (verbatim from spec §1) and file locations.
  2. **start**: `bun scripts/watch-todos.ts --watch` via Bash `run_in_background`; report "watching" and end turn. On the background task finishing: exit 3 → relaunch silently; exit 2 → tell Nicholas the daemon looks down, stop; exit 0 → handle every `pending/*.json` then relaunch.
  3. **Per pending to-do**: move seq into `state.json.dispatched` (append; the watcher never re-fires it), delete the pending file, spawn a background agent named `bug-<slug>` whose prompt embeds: the todo JSON, `references/api.md`, the `topic-context.ts` invocation for chat context (spec §3 — read the surrounding conversation, never trust the title alone), repro-then-screenshot instructions (testing-harness for driving the GUI; ffmpeg frame-extract fallback labeled `reporter-video-frame`), and the `plan-template.md` sections to fill, writing to `~/.claude/om-bug-loop/plans/<seq>-<slug>.md`.
  4. **Digest** (Nicholas's template, verbatim): when the agent returns, send in chat — **Problem** (one paragraph) / **Screenshot** (SendUserFile, labeled own-repro or reporter-video-frame) / **Repro steps** (numbered) / **Solution direction** (2–3 sentences + plan file link). Mark `awaiting-approval`. Then STOP for that task.
  5. **Approval vocabulary**: "ok <slug>" → implement; "skip <slug>" → status `skipped`; "change the plan: …" → re-spawn investigator with the feedback. One approval releases exactly one task; nothing is ever batch-approved.
  6. **Implement**: create sibling worktree `~/Documents/GitlabRepos/wt/<repo>-<slug>` (branch `om-bug-loop/<slug>` off fresh main), `bun install --frozen-lockfile` when node_modules is absent, fill `codex-prompt.md`, run the pinned codex invocation from Step 1 in background; on exit check for `BLOCKED.md` (surface it and stop the task) else proceed.
  7. **Verify**: spawn background agent `review-<slug>` with `model: opus`, prompt = filled `reviewer-prompt.md`. On PASS → report MR + evidence to Nicholas, status `shipped`, clean up the worktree. On FAIL → exactly one retry: append `review-fail.md` to the codex prompt, re-run codex, re-spawn reviewer; second FAIL → status `failed`, surface everything.
  8. **Kanban mirror** (every transition, always via `bun scripts/kanban.ts upsert <slug> --column <col>`): watcher fired → `todo`; digest posted → `todo review`; approved → `in progress`; agent question / dangerous step (anything destructive, schema-touching, prod-touching) / BLOCKED.md / second verify failure → `Need Attention` with the question appended to the card note; reviewer PASS → `Review` (only after the reviewer confirmed the card note with embedded evidence exists — a Review card without evidence is a pipeline bug); `Done` on Nicholas saying "done <slug>", on him dragging the card, or when the watcher's board fold shows the source to-do marked `!done` in OM Chat. Run `kanban.ts init` once at `start`.
  9. **Need Attention pings**: on every transition INTO Need Attention, besides the card, tell Nicholas in chat what is needed and send a push notification (PushNotification tool) with the slug + one-line question. Never sit silently in Need Attention.
  10. **Steering relay**: if Nicholas addresses an agent ("tell bug-<slug>: …", or answers a Need-Attention question), forward it verbatim to that agent via SendMessage (agents keep their context); move the card back out of Need Attention once unblocked.
  11. **status / stop**: print the state table (with kanban column per task) / kill the watcher task and stop.
  12. **Never**: edit shared checkouts, stash, batch-approve, push from the codex stage, post into OM Chat, or edit Kanban.md except through kanban.ts.

- [x] **Step 3: Validate skill loads** — start a throwaway session (`claude -p "/om-bug-loop status" --max-turns 3` or invoke via Skill tool) and confirm the skill resolves and reports an empty state table rather than erroring.

---

### Task 7: End-to-end acceptance

**Files:** none new (this proves the assembly).

- [x] **Step 1: Start the loop** — invoke `/om-bug-loop start`; confirm watcher runs (`state.json` cursor advances within ~2 min while bots post in #dev-forums).
- [x] **Step 2: Fire a real task** — ask Nicholas to promote one real untriaged report from the topic into a to-do (candidates from 8/24–8/28: emoji-reaction animation lag; "blocked" messages on slow connections; `from:@user` search returning nothing after filter clear). No synthetic test post into the production topic.
- [x] **Step 3: Watch the pipeline** — within ~60s the watcher exits, the coordinator spawns `bug-<slug>`, and a digest with problem/screenshot/repro/solution lands in chat. Nicholas approves ("ok <slug>"). Codex implements in the worktree; the Opus reviewer produces verify-report + before/after screenshots and opens the MR.
- [x] **Step 4: Acceptance check** — all of: MR open and conflict-free; verify-report shows FAIL-on-base/PASS-on-fix; screenshots show the bug gone; a Feature Map entry exists under `references/features/`; `state.json` shows the task `shipped`; the watcher is running again; AND the Kanban card walked `todo → todo review → in progress → Review` with the Review card's note embedding the evidence, viewable in Obsidian.

---

## Self-review notes

- Spec coverage: §1 shape→Tasks 3/6; §2 trigger→Tasks 2/3; §3 investigate (incl. chat-context requirement)→Tasks 4/6.3; §4 digest→6.4; §5 codex→5.2/6.6; §6 verify/Feature Map/retry→5.3/6.7; §6b kanban mirror→Tasks 4b/5.3(evidence package)/6.8–6.10/7.4; §7 cadence→3; §8 exclusions honored (no OM Chat posting anywhere); §9 constraints→Global Constraints + reviewer prompt.
- The fold intentionally simplifies one grammar corner: real `release` semantics vs. any-holder removal — acceptable because eligibility only needs "held by nobody", and a wrong holder list errs toward NOT firing (safe direction). Documented in todo-fold.ts header comment.
- `dispatched` is written by the coordinator and read by the watcher; both treat state.json atomically (tmp+rename) and the watcher is dead while the coordinator handles pending files, so there is no concurrent-writer window.
