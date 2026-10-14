#!/usr/bin/env bun
// task-watch.ts — what the coordinator should be looking at without being asked.
//
// The coordinator's failure mode is reactive: it waits for a completion
// notification, and a task that is quietly overrunning looks identical to one
// that is progressing. Nicholas had to chase three tasks past the hour before
// anyone noticed. A habit does not fix that; a command does.
//
// Two independent signals, because they mean different things:
//   ELAPSED  — how long the task has been alive. Budget is 60 min, target 30-45.
//   QUIET    — how long since it last wrote an artifact. A long quiet stretch is
//              usually a test run or a build, NOT a hang — one task was silent
//              11 minutes running a visual subset and was perfectly healthy.
//              Treat it as "look", never as "dead".
//
// Usage:  bun task-watch.ts            # one shot
//         bun task-watch.ts --quiet-after 15 --over 60
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { DEFAULT_BOARD, DEFAULT_TASKS, STAGES } from "./kanban";

/** Slugs whose card sits in `Need Attention` — parked on a question for
 *  Nicholas, not overrunning. Without this the watcher counts a parked task's
 *  wall-clock forever: on 2026-09-18 five of them had been announcing
 *  OVER-HOUR for up to 30 hours, and the noise trained the coordinator to
 *  ignore the one alert that was real. `stages` cannot express "parked", so
 *  the board is the only place this is written down. */
function parkedSlugs(): Set<string> {
  const out = new Set<string>();
  if (!existsSync(BOARD)) return out;
  let column = "";
  for (const line of readFileSync(BOARD, "utf8").split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) { column = heading[1]!; continue; }
    if (column !== "Need Attention") continue;
    const card = /\[\[(?:[^\]|]*\/)?cards\/([^\]|]+)\|/.exec(line);
    if (card) out.add(card[1]!);
  }
  return out;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BOARD = argValue("--board") ?? DEFAULT_BOARD;
const TASKS = argValue("--tasks") ?? DEFAULT_TASKS;
const EVIDENCE = join(dirname(BOARD), "evidence");

/** Statuses that mean an agent should currently be working. */
const LIVE = new Set(["investigating", "planned", "implementing", "reviewing"]);

function argNum(flag: string, dflt: number): number {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : dflt;
}
// A blocking verifier runs both arms on two daemons, a full suite twice and the
// capture matrix — it CANNOT produce an owner-side artifact for ~40 minutes by
// construction (measured on T29: 17:33-18:15). A 12-minute threshold fires on
// every task that reaches verification, which trains the coordinator to ignore
// it. 35 minutes still catches a genuine hang well before the hour.
const QUIET_AFTER = argNum("--quiet-after", 35);   // minutes with no artifact
const OVER = argNum("--over", 60);                 // the hour
const WARN = argNum("--warn", 40);                 // checkpoint

const mins = (ms: number) => Math.floor(ms / 60000);

/** Newest mtime under a directory, or 0. Evidence dirs are sometimes symlinked
 *  to a `manual-<slug>` twin, so try both spellings. */
function lastWrite(ref: string | null | undefined, slug: string): number {
  let newest = 0;
  const candidates = [ref, slug, slug ? `manual-${slug}` : undefined]
    .filter((v): v is string => Boolean(v));
  for (const name of candidates) {
    const dir = join(EVIDENCE, name);
    if (!existsSync(dir)) continue;
    const walk = (d: string) => {
      let entries: string[];
      try { entries = readdirSync(d); } catch { return; }
      for (const name of entries) {
        const p = join(d, name);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p);
        else if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    };
    walk(dir);
  }
  return newest;
}

interface Row {
  ref: string; slug: string; status: string;
  elapsed: number; quiet: number; flags: string[];
}

function rows(): Row[] {
  if (!existsSync(TASKS)) return [];
  const tasks = JSON.parse(readFileSync(TASKS, "utf8")) as Record<string, any>;
  const now = Date.now();
  const out: Row[] = [];
  const parked = parkedSlugs();
  for (const t of Object.values(tasks)) {
    if (!LIVE.has(t.status)) continue;
    const stamps = Object.values(t.stages ?? {}) as string[];
    if (!stamps.length) continue;
    // Elapsed runs from the moment WORK started — `implementing` if the task
    // has been approved, else the first stamp — and NOT from the latest stamp.
    //
    // Measuring from the latest stamp resets the clock every time a task
    // advances a phase, which is exactly backwards: T27 entered `reviewing` at
    // 103 minutes and its elapsed dropped to 0, so it never crossed the hour and
    // the watcher never fired. The budget is total working time, not time in the
    // current phase.
    //
    // `implementing` is the right zero because the gap before it is Nicholas
    // deciding, which is not the task overrunning. An unapproved task therefore
    // measures from its first stamp — investigation has its own budget too.
    const st = (t.stages ?? {}) as Record<string, string>;
    // `investigating` is the zero, not the earliest stamp: that is when an owner
    // was actually dispatched. The earliest stamp is when the CARD was filed,
    // which on 2026-09-18 made F93 announce OVER-HOUR at 127m four minutes after
    // dispatch — it had sat in the queue for two hours first. Queue time is not
    // the owner overrunning.
    //
    // (The older comment below reasoned from `implementing` because a task used
    // to wait for Nicholas to approve a plan. That gate was removed 2026-09-11,
    // so the gap before `implementing` is now the owner working, not waiting.)
    const startStamp = st.implementing ?? st.investigating
      ?? stamps.reduce((a, b) => (a < b ? a : b));
    // A task whose `stages` already carries a timestamp for a stage LATER, in
    // `STAGES` order, than the one `t.status` currently names can only have
    // gotten there by reaching that later stage and then being moved BACK to
    // an earlier live status — reopened after shipping, resumed after being
    // parked, redispatched by hand. `stages` is append-only (`kanban.ts
    // recordStage`), so no new stamp marks the moment it happened; the
    // fallback above then silently resolves to whichever PRE-reopen stamp
    // wins the `??` chain. Detectable without any new required field: does a
    // later stage already have a stamp?
    const statusIdx = (STAGES as readonly string[]).indexOf(t.status);
    const reopened = statusIdx >= 0 && Object.keys(st).some(
      s => (STAGES as readonly string[]).indexOf(s) > statusIdx);

    // `reopenedAt`: an optional, hand-set ISO timestamp recording exactly "this
    // task was put back into a live status at this moment" — task-watch never
    // writes it (nothing in this file does; grep confirms no writeFileSync/
    // renameSync anywhere), it only reads it when an operator sets it as part
    // of the same manual edit that resets `status` back to a live value
    // (there is no dedicated command for that reset today — see T52's plan).
    // When present and later than the naive `startStamp` above, it fully
    // replaces it: it is a precise answer `stages` cannot give once a stage
    // name has already been stamped once.
    const reopenedAtMs = typeof t.reopenedAt === "string" ? Date.parse(t.reopenedAt) : NaN;
    const naiveStarted = new Date(startStamp).getTime();
    const confirmedReopen = Number.isFinite(reopenedAtMs) && reopenedAtMs > naiveStarted;
    const started = confirmedReopen ? reopenedAtMs : naiveStarted;
    const lw = lastWrite(t.ref, t.slug);
    const row: Row = {
      ref: t.ref ?? "-", slug: t.slug, status: t.status,
      elapsed: mins(now - started),
      quiet: lw ? mins(now - lw) : -1,
      flags: [],
    };
    if (parked.has(t.slug)) row.flags.push("parked");
    else if (reopened && !confirmedReopen) row.flags.push("reopened");
    else if (row.elapsed >= OVER) row.flags.push("OVER-HOUR");
    else if (row.elapsed >= WARN) row.flags.push("checkpoint");
    if (row.quiet >= QUIET_AFTER) row.flags.push(`quiet-${row.quiet}m`);
    if (row.quiet < 0) row.flags.push("no-artifacts-yet");
    out.push(row);
  }
  return out.sort((a, b) => b.elapsed - a.elapsed);
}

function main(): number {
  const rs = rows();
  if (!rs.length) { process.stdout.write("no live tasks\n"); return 0; }
  const w = (pick: (r: Row) => string) => Math.max(0, ...rs.map(r => pick(r).length));
  const wr = w(r => r.ref), ws = w(r => r.slug), wt = w(r => r.status);
  for (const r of rs) {
    process.stdout.write(
      `${r.ref.padEnd(wr)}  ${r.status.padEnd(wt)}  ${r.slug.padEnd(ws)}  ` +
      `${String(r.elapsed).padStart(3)}m  last-write ${r.quiet < 0 ? "  –" : String(r.quiet).padStart(3) + "m"}` +
      (r.flags.length ? `  ⚠ ${r.flags.join(" ")}` : "") + "\n");
  }
  // A quiet stretch is usually a build or a test run. Say so, so nobody
  // escalates a healthy task — one sat silent 11 minutes on a visual subset.
  if (rs.some(r => r.flags.some(f => f.startsWith("quiet")))) {
    process.stdout.write(
      "\nquiet = no artifact written recently. Usually a build or a test run,\n" +
      "not a hang. Look before escalating; the harness reports a real stall.\n");
  }
  return rs.some(r => r.flags.includes("OVER-HOUR")) ? 1 : 0;
}

// --------------------------------------------------------------- watch mode
//
// The one-shot command was not enough, and the gap was found the hard way: a
// task crossed the hour unnoticed because nothing ran the command. An
// instrument nobody polls is a habit again.
//
// So this mirrors watch-todos.ts, the pattern the pipeline already trusts: poll
// quietly, and EXIT when there is something to act on. The exit is the event —
// the harness re-invokes the coordinator, which then nudges the task. No timer
// lives in the coordinator's head.
//
//   exit 0  a task has crossed the hour (or a new one has), act on it
//   exit 3  heartbeat, nothing to report in a long while
const POLL_MS = argNum("--poll-ms", 120_000); // 2 min; elapsed changes slowly
const HEARTBEAT_MS = 3_600_000;   // an hour of nothing to say

async function watch(): Promise<never> {
  const started = Date.now();
  // Only fire ONCE per task per threshold — otherwise every poll re-reports the
  // same overrun and the coordinator is woken to say nothing new.
  const announced = new Set<string>();
  // Seed with whatever is ALREADY flagged. The coordinator has seen the current
  // state — it just read it — so firing on it would wake the session to repeat
  // something it already knows, and every relaunch would do it again. Alert on
  // the TRANSITION into a threshold, never on standing state.
  for (const r of rows()) {
    if (r.flags.includes("OVER-HOUR")) announced.add(`${r.ref}:over`);
    if (r.flags.includes("checkpoint")) announced.add(`${r.ref}:warn`);
  }
  process.stderr.write(
    `[task-watch] watching every ${POLL_MS / 1000}s; ${announced.size} already-flagged task(s) seeded\n`);
  for (;;) {
    const fresh = rows().filter(r => {
      const key = `${r.ref}:${r.flags.includes("OVER-HOUR") ? "over" : "warn"}`;
      if (!r.flags.includes("OVER-HOUR") && !r.flags.includes("checkpoint")) return false;
      if (announced.has(key)) return false;
      announced.add(key);
      return true;
    });
    if (fresh.length) {
      for (const r of fresh) {
        process.stdout.write(
          `${r.flags.includes("OVER-HOUR") ? "OVER-HOUR" : "checkpoint"}  ${r.ref}  ` +
          `${r.slug}  ${r.elapsed}m  last-write ${r.quiet < 0 ? "–" : `${r.quiet}m`}\n`);
      }
      process.exit(0);
    }
    if (Date.now() - started >= HEARTBEAT_MS) {
      process.stderr.write("[task-watch] exiting 3 — heartbeat\n");
      process.exit(3);
    }
    await Bun.sleep(POLL_MS);
  }
}

if (import.meta.main) {
  if (process.argv.includes("--watch")) await watch();
  process.exit(main());
}
