# om-bug-loop — daemon API & to-do grammar reference

Single source of truth for every script and agent prompt in this skill. If a
script disagrees with this file, the script is wrong. If this file disagrees
with the live daemon, re-verify (§5) and fix this file.

Verified against the live daemon 2026-09-01.

## 1. Daemon facts

- GUI daemon: `http://localhost:31417`
- Room: `b4472fc1fbd3` (#dev-forums)
- Topic: `7f30222f` (⌗ OM Chat Bugs)
- GUI deep link to the topic:
  `http://localhost:31417/rooms#/b4472fc1fbd3/topic/7f30222f`

### Auth — operator cookie

The rooms proxy requires operator proof or an agent badge token. This skill
uses the **operator cookie**, which any GET of the `/rooms` document mints:

```
GET http://localhost:31417/rooms      →  Set-Cookie: om_operator_31417=<token>; HttpOnly; Path=/
```

Send that cookie on every `/api/rooms/...` request. On a `401` whose body is
`{"ok":false,"error":"badge_token_required", ...}`, re-mint the cookie **once**
(single-flight) and replay the request — same behavior as the GUI's operator
re-mint. A second 401 is a real failure.

No token, no badge, no API key is needed or should be used.

### Events REST

```
GET /api/rooms/rooms/<room>/events?limit=200[&sinceSeq=N|&beforeSeq=N]
```

Response envelope:

```json
{ "success": true, "room": "b4472fc1fbd3", "entries": [...],
  "upToSeq": 9416, "hasMore": true, "readOnly": false }
```

Entry fields used here:

| field | meaning |
|---|---|
| `seq` | monotonic room-wide sequence number; the id of an entry |
| `ts` | epoch ms |
| `type` | `post` for user messages (only `post` can carry a to-do marker) |
| `text` | message body |
| `handle` | author handle |
| `userId` | author id |
| `topicId` | owning topic (`7f30222f` for ⌗ OM Chat Bugs) |
| `inReplyTo` | seq of the entry replied to — how lifecycle markers bind to their to-do |
| `attachments` | array of attachment descriptors (see below) |
| `todoCurrent` | daemon-side current `{title, description}` of a to-do create; wins over parsing the create text |

Paging:

- `sinceSeq=N` returns entries **after** N, oldest→newest, `hasMore` true when
  the page was truncated — loop until `hasMore` is false.
- `beforeSeq=N` pages **backwards** (used for the first-run backfill).
- Keep `limit=200`. The events read draws the relay's `readHistory` budget, so
  **never poll faster than 60 s** and never widen the page size.

### Rate limit (verified 2026-09-01 — this WILL bite backfill)

History reads are limited server-side. Exceeding it returns **429**:

```
ratelimit-limit: 10   ratelimit-remaining: 0   ratelimit-reset: 1   retry-after: 1
{"error":"You're reading too fast. Please wait 1 second.","code":"RATE_LIMITED",
 "scope":"readHistory","retryAfter":1,"limit":10,"remaining":0,"resetAfter":1}
```

10 reads per ~1 s window. A first-run backfill pages ~50 times and trips this
immediately, so every read in `scripts/daemon-api.ts` honors `Retry-After` and
retries, and page loops pause `PAGE_PAUSE_MS` (150 ms) between pages. Any new
caller must go through `DaemonClient`, not bare `fetch`.

### Attachments

```
GET /api/rooms/rooms/<room>/attachment-url?key=<urlencoded attachment key>
```

200 with a signed URL for the file. Download it with the same operator cookie.
`scripts/topic-context.ts` does this for every message around a to-do.

Screen recordings: extract a representative frame. **ffmpeg is not installed on
this Mac** (verified 2026-09-01), so the working command is Quick Look's:

```bash
qlmanage -t -s 1400 -o <outdir> in.mov     # writes <outdir>/in.mov.png
ffmpeg -ss 2 -i in.mov -frames:v 1 out.png # preferred, if ffmpeg is ever installed
```

`topic-context.ts` emits whichever of the two will actually run.

### Topics

```
GET /api/rooms/rooms/<room>/topics?includeResolved=true&withState=true&limit=200
```

→ `{success, topics: [{topicId, roomId, name, status, messageCount, ...}]}`.

## 2. To-do grammar

Authority: `openmarket-chat/src/lib/channel-todos.ts`. The port lives in
`scripts/todo-fold.ts`; on divergence, fix the port, not the authority.

A to-do marker is a `post` entry whose **entire trimmed text** is a marker.
Matching is **case-sensitive and exact**. Entries with
`ts < Date.UTC(2026, 7, 4)` (`TODO_EPOCH_MS`) never parse as markers.

**Create** (starts a to-do; the entry's own `seq` is the to-do's id):

```
!todo Title
Description…            ← optional, everything after the first newline
```

**Lifecycle replies** — bare, exact, bound to the create via `inReplyTo`:

```
!claim   !release   !done   !reopen   !cancel   !nudge
```

`!done thanks` is **not** a marker (trailing text disqualifies it).

**Routing replies** — exactly one `@handle` token, handle lowercased:

```
!assign @handle        !unassign @handle
```

`!assign nicholas` (no `@`) and `!assign @a @b` (two tokens) are not markers.

**Content edit reply**:

```
!edit Title
Description…
```

### Fold semantics (what `todo-fold.ts` computes)

- create → `{status: "open", holders: []}`
- `claim` adds the author's handle to `holders`; `release` removes it
- `assign @h` adds `h`; `unassign @h` removes `h`
- `done` → `status: "done"`; `cancel` → `status: "canceled"`
- `reopen` → `status: "open"` and clears `holders`
- `edit` replaces title/description
- `nudge` is a no-op for eligibility
- a lifecycle marker whose `inReplyTo` is not a known to-do create is ignored

**Eligible** (what the watcher fires on) = `status === "open"` **and**
`holders.length === 0`.

## 3. House constraints baked into this pipeline

- Never edit or commit in the shared `~/Documents/GitlabRepos/*` checkouts —
  implementation happens in fresh sibling worktrees under
  `~/Documents/GitlabRepos/wt/<repo>-<slug>`, never nested inside a repo.
- No `git stash` anywhere under GitlabRepos (`refs/stash` is shared).
- No `git add -A` where node_modules is a symlink; stage exact paths.
- openmarket-chat: no AI attribution in commits or files; `grep -a` (NUL-poisoned
  files silently skip otherwise); inspect the GitLab pipeline's per-job statuses
  with `glab api projects/openmarketxyz%2Ffrontend%2Fopenmarket-chat/pipelines/<id>/jobs`.
- openmarket-chat-cloud runs CI on main only; diff tsc error sets locally.
- Design gates already fail on main — always baseline a same-commit worktree.

## 4. File locations

| path | contents |
|---|---|
| `~/.claude/om-bug-loop/state.json` | `{cursor, markers[], dispatched[]}` |
| `~/.claude/om-bug-loop/pending/<seq>.json` | a fired to-do awaiting coordinator dispatch |
| `~/.claude/om-bug-loop/plans/<seq>-<slug>.md` | approved-or-pending investigation plans |
| `~/.claude/om-bug-loop/evidence/<seq>/` | codex.log, verify-report.md, screenshots |
| `/Users/nicholas/Documents/Obisidian/kanban/Kanban.md` | the mirror board |

## 5. Re-verification snippet

```bash
curl -sc /tmp/om-jar.txt "http://localhost:31417/rooms" -o /dev/null \
  && curl -sb /tmp/om-jar.txt \
     "http://localhost:31417/api/rooms/rooms/b4472fc1fbd3/events?limit=1" | head -c 200
```

Expect `{"success":true,"room":"b4472fc1fbd3","entries":[...`.
