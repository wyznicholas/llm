#!/usr/bin/env bun
// watch-board.ts — the zero-token watcher for om-bug-loop.
//
// Polls the `todo` lane of Kanban.md for unclaimed, routable cards, writes one
// pending file per find, and EXITS — the process exit is what wakes the
// coordinator session. No model is involved in detection.
//
// This replaces watch-todos.ts, which polled ⌗ OM Chat Bugs. Reading a local
// file needs no daemon, no cookie and no network, so the old exit 2 ("daemon
// down") has no meaning here and is not used.
//
// Usage:
//   bun watch-board.ts --once     single poll, prints {new}, exit 0
//   bun watch-board.ts --watch    poll loop; exit 0 = news, 3 = heartbeat
//   --state <dir>          state dir (default ~/.claude/om-bug-loop)
//   --board <path>         board file (default the vault's Kanban.md)
//   --max-per-poll <n>     offer at most n cards per poll (default: all of them)
//   --poll-ms <ms>         seconds between polls in --watch (default 60000)
//
// The two throttles exist because a midnight-scout night can file up to 80
// findings at once. Capping DISPATCH RATE rather than findings keeps the
// rubric the only filter on what gets recorded, and puts the brake where the
// cost actually is. `dispatch-gate.ts` is still the second brake, refusing
// above cores x 1.2.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readTodoLane } from "./board-todos";
import { route } from "./routing";
import { DEFAULT_BOARD, slugify } from "./kanban";

const DEFAULT_POLL_MS = 60_000;
const HEARTBEAT_MS = 14_400_000; // 4h quiet → exit 3 so a dead poller is noticed

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** A malformed throttle must NOT silently fall back to the default: the whole
 *  point of passing one is to slow dispatch, and a typo that quietly restores
 *  full speed is the failure you would not notice until the machine is on
 *  fire. */
function numericFlag(flag: string, fallback: number, min: number): number {
  const raw = argValue(flag);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    process.stderr.write(`${flag} must be an integer >= ${min}, got ${JSON.stringify(raw)}\n`);
    process.exit(64);
  }
  return n;
}
const ONCE = process.argv.includes("--once");
const WATCH = process.argv.includes("--watch");
const BOARD = argValue("--board") ?? DEFAULT_BOARD;
const STATE_DIR = argValue("--state") ?? join(homedir(), ".claude", "om-bug-loop");
const STATE_PATH = join(STATE_DIR, "state.json");
const PENDING_DIR = join(STATE_DIR, "pending");
const MAX_PER_POLL = numericFlag("--max-per-poll", Number.POSITIVE_INFINITY, 1);
const POLL_MS = numericFlag("--poll-ms", DEFAULT_POLL_MS, 1);

const log = (msg: string) =>
  process.stderr.write(`[watch-board ${new Date().toISOString()}] ${msg}\n`);

interface Found { slug: string; title: string; tags: string[]; route: string; lineNo: number }

/** `dispatched` is the COORDINATOR's key. This watcher only reads it; it never
 *  writes `state.json` at all. */
function dispatched(): string[] {
  if (!existsSync(STATE_PATH)) return [];
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")).dispatched ?? []; }
  catch { return []; }
}

function poll(): Found[] {
  if (!existsSync(BOARD)) { log(`board not found at ${BOARD}`); return []; }
  const lane = readTodoLane(readFileSync(BOARD, "utf8"));
  const seen = dispatched();

  const fresh: Found[] = [];
  for (const card of lane) {
    if (card.claimed) continue;
    const owner = route({ title: card.title, tags: card.tags });
    // `#human` is filtered HERE and never recorded in `dispatched`. Recording
    // it would be permanent, so deleting the tag later would never re-fire the
    // card. As a filter the tag is a switch: remove it and the card is
    // eligible on the next poll, with nobody doing anything.
    if (owner === "skip") continue;

    const slug = slugify(card.title);
    const path = join(PENDING_DIR, `${slug}.json`);
    if (seen.includes(slug) || existsSync(path)) continue;
    // Checked AFTER the skip/claimed/seen filters so the cap counts cards
    // actually offered, not cards looked at.
    if (fresh.length >= MAX_PER_POLL) {
      log(`--max-per-poll ${MAX_PER_POLL} reached; the rest wait for the next poll`);
      break;
    }

    mkdirSync(PENDING_DIR, { recursive: true });
    const found: Found = { slug, title: card.title, tags: card.tags, route: owner, lineNo: card.lineNo };
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...found, detectedAt: new Date().toISOString() }, null, 2));
    renameSync(tmp, path);
    log(`new card → ${owner}: ${card.title}`);
    fresh.push(found);
  }
  return fresh;
}

async function main(): Promise<never> {
  if (ONCE) {
    process.stdout.write(JSON.stringify({ new: poll() }) + "\n");
    process.exit(0);
  }
  if (!WATCH) {
    process.stderr.write("usage: bun watch-board.ts (--once|--watch) [--state <dir>] [--board <path>]\n");
    process.exit(64);
  }
  log(`watching ${BOARD} todo lane every ${POLL_MS / 1000}s` + (Number.isFinite(MAX_PER_POLL) ? `, at most ${MAX_PER_POLL} card(s) per poll` : ""));
  const started = Date.now();
  for (;;) {
    const fresh = poll();
    if (fresh.length > 0) {
      process.stdout.write(JSON.stringify({ new: fresh }) + "\n");
      log(`exiting 0 with ${fresh.length} pending card(s)`);
      process.exit(0);
    }
    if (Date.now() - started >= HEARTBEAT_MS) {
      log("exiting 3 — heartbeat (4h with no news)");
      process.exit(3);
    }
    await Bun.sleep(POLL_MS);
  }
}

await main();
