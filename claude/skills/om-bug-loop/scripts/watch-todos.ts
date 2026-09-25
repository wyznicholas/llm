#!/usr/bin/env bun
// watch-todos.ts — the zero-token watcher for om-bug-loop.
//
// Polls the local OM Chat daemon's rooms proxy for new *eligible* to-dos in
// the ⌗ OM Chat Bugs topic (open + held by nobody), writes one pending file
// per find, and EXITS — the process exit is what wakes the coordinator
// session. No model is involved in detection.
//
// Protocol details are documented in ../references/api.md; keep them in sync.
//
// Usage:
//   bun watch-todos.ts --once            single poll, prints {new, eligibleNow}, exit 0
//   bun watch-todos.ts --watch           poll loop; exit 0 = news, 3 = heartbeat, 2 = daemon down
//   --state <dir>    override the state dir (default ~/.claude/om-bug-loop)
//   --daemon <url>   override the daemon origin (default http://localhost:31417)
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DAEMON, DaemonClient, PAGE_LIMIT, PAGE_PAUSE_MS, ROOM, TOPIC, type EventsPage } from "./daemon-api";
import { TODO_EPOCH_MS, eligible, foldTodos, parseMarker, type LedgerEntry, type Todo } from "./todo-fold";

const POLL_MS = 60_000;
const HEARTBEAT_MS = 14_400_000; // 4h quiet → exit 3 so a dead poller is noticed
const MAX_BACKFILL_PAGES = 120;
const MAX_FORWARD_PAGES = 120;
const MAX_FAILURES = 10;

interface State {
  cursor: number;
  markers: LedgerEntry[];
  dispatched: number[];
}

// ---------------------------------------------------------------- args

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONCE = process.argv.includes("--once");
const WATCH = process.argv.includes("--watch");
const DAEMON = argValue("--daemon") ?? DEFAULT_DAEMON;
const STATE_DIR = argValue("--state") ?? join(homedir(), ".claude", "om-bug-loop");
const STATE_PATH = join(STATE_DIR, "state.json");
const PENDING_DIR = join(STATE_DIR, "pending");

// Timestamped because the exit-3 heartbeat and an instant crash-loop produce
// IDENTICAL logs otherwise — there was no way to tell a genuine 4h quiet run
// from a watcher exiting immediately, which is exactly the thing you need to
// know before relaunching it.
const log = (msg: string) =>
  process.stderr.write(`[watch-todos ${new Date().toISOString()}] ${msg}\n`);

// Auth, paging and the readHistory rate limit all live in ./daemon-api.ts.
const daemon = new DaemonClient(DAEMON);
const getEvents = (params: Record<string, string | number>) =>
  daemon.events({ limit: PAGE_LIMIT, ...params }) as Promise<{ entries: LedgerEntry[]; hasMore?: boolean }>;

// ---------------------------------------------------------------- state

function loadState(): State {
  if (!existsSync(STATE_PATH)) return { cursor: 0, markers: [], dispatched: [] };
  const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<State>;
  return {
    cursor: raw.cursor ?? 0,
    markers: raw.markers ?? [],
    dispatched: raw.dispatched ?? [],
  };
}

// The coordinator owns `dispatched`; the watcher only ever reads it. Re-read
// it at write time so a coordinator append during the poll is never clobbered.
function saveState(state: State): void {
  mkdirSync(STATE_DIR, { recursive: true });
  let dispatched = state.dispatched;
  if (existsSync(STATE_PATH)) {
    try {
      const onDisk = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<State>;
      if (Array.isArray(onDisk.dispatched)) dispatched = onDisk.dispatched;
    } catch { /* corrupt file: fall back to what we loaded */ }
  }
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...state, dispatched }, null, 2));
  renameSync(tmp, STATE_PATH);
  state.dispatched = dispatched;
}

/** Keep only what the fold needs: topic markers, trimmed to the used fields. */
function keepMarkers(entries: LedgerEntry[]): LedgerEntry[] {
  return entries
    .filter(e => e.topicId === TOPIC && e.type === "post" && parseMarker(e.text) !== null)
    .map(e => ({
      seq: e.seq, ts: e.ts, type: e.type, text: e.text, handle: e.handle,
      topicId: e.topicId, inReplyTo: e.inReplyTo,
      ...(e.attachments && e.attachments.length ? { attachments: e.attachments } : {}),
      ...(e.todoCurrent ? { todoCurrent: e.todoCurrent } : {}),
    }));
}

function mergeMarkers(state: State, found: LedgerEntry[]): void {
  const bySeq = new Map(state.markers.map(m => [m.seq, m]));
  for (const m of found) bySeq.set(m.seq, m);
  state.markers = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

// ---------------------------------------------------------------- polling

/** First run: page backwards until the ledger predates the to-do epoch. */
async function backfill(state: State): Promise<void> {
  let before = Number.MAX_SAFE_INTEGER;
  for (let page = 0; page < MAX_BACKFILL_PAGES; page++) {
    const res = await getEvents({ beforeSeq: before });
    const entries = res.entries ?? [];
    if (entries.length === 0) break;
    const seqs = entries.map(e => e.seq);
    state.cursor = Math.max(state.cursor, ...seqs); // room tip, not just topic
    mergeMarkers(state, keepMarkers(entries));
    const oldest = entries.reduce((a, b) => (a.seq <= b.seq ? a : b));
    if (!res.hasMore || oldest.ts < TODO_EPOCH_MS) break;
    before = oldest.seq;
    await Bun.sleep(PAGE_PAUSE_MS); // readHistory budget is 10 reads/s
  }
  log(`backfill complete: cursor=${state.cursor}, markers=${state.markers.length}`);
}

/** Subsequent runs: forward from the cursor. */
async function forward(state: State): Promise<void> {
  for (let page = 0; page < MAX_FORWARD_PAGES; page++) {
    const res = await getEvents({ sinceSeq: state.cursor });
    const entries = res.entries ?? [];
    if (entries.length === 0) break;
    state.cursor = Math.max(state.cursor, ...entries.map(e => e.seq));
    mergeMarkers(state, keepMarkers(entries));
    if (!res.hasMore) break;
    await Bun.sleep(PAGE_PAUSE_MS);
  }
}

interface PollResult { fresh: Todo[]; eligibleNow: number }

async function poll(): Promise<PollResult> {
  const state = loadState();
  const first = !existsSync(STATE_PATH);
  if (first) await backfill(state); else await forward(state);

  const board = foldTodos(state.markers);
  const open = eligible(board);
  mkdirSync(PENDING_DIR, { recursive: true });
  const fresh = open.filter(
    t => !state.dispatched.includes(t.seq) && !existsSync(join(PENDING_DIR, `${t.seq}.json`)),
  );
  for (const todo of fresh) {
    const payload = { ...todo, room: ROOM, topicId: TOPIC, detectedAt: new Date().toISOString() };
    const path = join(PENDING_DIR, `${todo.seq}.json`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, path);
    log(`new eligible to-do ${todo.seq}: ${todo.title}`);
  }
  saveState(state);
  return { fresh, eligibleNow: open.length };
}

// ---------------------------------------------------------------- entry

async function main(): Promise<never> {
  if (ONCE) {
    const { fresh, eligibleNow } = await poll();
    process.stdout.write(JSON.stringify({ new: fresh, eligibleNow }) + "\n");
    process.exit(0);
  }
  if (!WATCH) {
    process.stderr.write("usage: bun watch-todos.ts (--once|--watch) [--state <dir>] [--daemon <url>]\n");
    process.exit(64);
  }
  log(`watching ${DAEMON} room ${ROOM} topic ${TOPIC} every ${POLL_MS / 1000}s`);
  const started = Date.now();
  let failures = 0;
  for (;;) {
    try {
      const { fresh } = await poll();
      failures = 0;
      if (fresh.length > 0) {
        process.stdout.write(JSON.stringify({ new: fresh }) + "\n");
        log(`exiting 0 with ${fresh.length} pending to-do(s)`);
        process.exit(0);
      }
    } catch (err) {
      failures++;
      log(`poll failed (${failures}/${MAX_FAILURES}): ${(err as Error).message}`);
      if (failures >= MAX_FAILURES) {
        log("exiting 2 — daemon appears to be down");
        process.exit(2);
      }
    }
    if (Date.now() - started >= HEARTBEAT_MS) {
      log("exiting 3 — heartbeat (4h with no news)");
      process.exit(3);
    }
    await Bun.sleep(POLL_MS);
  }
}

await main();
