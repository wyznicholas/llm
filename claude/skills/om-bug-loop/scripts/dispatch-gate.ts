#!/usr/bin/env bun
// dispatch-gate.ts — the load check that replaced the fixed concurrency cap,
// and the instrumentation that makes the next answer measured rather than
// reasoned.
//
// A fixed "three owners maximum" was the wrong shape. An owner is a process
// FAMILY, not a process, and how heavy a family is depends on what stage it is
// in — a scoped test run at --shards 2 is nothing like a full suite at
// cores-2. A count cannot see that, and it cannot see Nicholas's own work
// either. Load can.
//
// Usage:
//   bun dispatch-gate.ts check  --ref T23        # GO / QUEUE, exit 0 / 1
//   bun dispatch-gate.ts sample --ref T23 --note peak
//   bun dispatch-gate.ts report                  # what the log has learned
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const LOG = join(homedir(), ".claude", "om-bug-loop", "dispatch-log.jsonl");

/** Physical cores. `sysctl hw.ncpu` counts perf + efficiency, which is what
 *  the run queue actually competes for. */
export function cores(): number {
  const out = Bun.spawnSync({ cmd: ["sysctl", "-n", "hw.ncpu"] }).stdout.toString().trim();
  const n = Number(out);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

/** The three load averages, in order. */
export function loads(): [number, number, number] {
  const out = Bun.spawnSync({ cmd: ["uptime"] }).stdout.toString();
  const m = /load averages?:\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(out);
  if (!m) return [NaN, NaN, NaN];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Everything this pipeline can spawn. Counted for the log, never for the
 *  verdict — the verdict is load, because 200 idle processes are harmless and
 *  20 busy ones are not. */
export function procs(): number {
  const ps = Bun.spawnSync({ cmd: ["ps", "-ax", "-o", "command"] }).stdout.toString();
  return ps.split("\n").filter(l => /(^|\/)(bun|node|codex)\b|Chromium|Helper \(Renderer\)/.test(l)).length;
}

/**
 * The threshold, as a multiple of core count.
 *
 * 1.2x leaves headroom for Nicholas's own work on the same box. Below it a new
 * owner gets real CPU; above it everything slows together and the harness
 * watchdog starts killing agents at 600s of silence — which is how three
 * owners died in one afternoon while still making progress.
 *
 * The FIFTEEN-minute average is the gate on purpose. The one-minute figure is
 * noise: a single sample of it once read 3.9 while the five-minute average was
 * 36, and that misread was reported as if it were a trend.
 */
export const THRESHOLD_RATIO = 1.2;

export interface Verdict {
  go: boolean; load1: number; load5: number; load15: number;
  procs: number; cores: number; threshold: number; reason: string;
}

export function verdict(
  l: [number, number, number] = loads(), c = cores(), p = procs(),
): Verdict {
  const threshold = c * THRESHOLD_RATIO;
  const [load1, load5, load15] = l;
  // A NaN load (uptime parse failed) must not read as "quiet" — refuse instead.
  const go = Number.isFinite(load15) && load15 < threshold;
  const reason = !Number.isFinite(load15)
    ? "could not read load average — refusing rather than guessing"
    : go
      ? `15m load ${load15.toFixed(2)} < ${threshold.toFixed(1)} (${c} cores x ${THRESHOLD_RATIO})`
      : `15m load ${load15.toFixed(2)} >= ${threshold.toFixed(1)} — queue this task, do not dispatch`;
  return { go, load1, load5, load15, procs: p, cores: c, threshold, reason };
}

function log(event: string, ref: string, note: string, v: Verdict): void {
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, JSON.stringify({
    ts: new Date().toISOString(), event, ref, note,
    load1: v.load1, load5: v.load5, load15: v.load15,
    procs: v.procs, cores: v.cores, go: v.go,
  }) + "\n");
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
  const command = process.argv[2];
  const ref = argValue("--ref") ?? "-";
  const note = argValue("--note") ?? "";

  if (command === "check" || command === "sample") {
    const v = verdict();
    log(command, ref, note, v);
    const tag = command === "check" ? (v.go ? "GO" : "QUEUE") : "SAMPLE";
    process.stdout.write(
      `${tag}  ${ref}  15m=${v.load15} 5m=${v.load5} 1m=${v.load1}  procs=${v.procs}  ${v.reason}\n`);
    return command === "check" && !v.go ? 1 : 0;
  }

  if (command === "report") {
    if (!existsSync(LOG)) { process.stdout.write("no samples yet\n"); return 0; }
    const rows = readFileSync(LOG, "utf8").trim().split("\n")
      .filter(Boolean).map(l => JSON.parse(l) as Record<string, number | string>);
    const checks = rows.filter(r => r.event === "check");
    const peaks = rows.filter(r => r.event === "sample");
    const max = (xs: typeof rows, k: string) =>
      xs.length ? Math.max(...xs.map(r => Number(r[k]) || 0)) : 0;
    process.stdout.write(
      `${rows.length} samples (${checks.length} dispatch checks, ${peaks.length} peaks)\n` +
      `  dispatched at 15m load: max ${max(checks, "load15")}\n` +
      `  peak 15m load observed:  ${max(peaks, "load15")}\n` +
      `  peak process count:      ${max(peaks, "procs")}\n` +
      `  queued (refused):        ${checks.filter(r => r.go === false).length}\n`);
    return 0;
  }

  process.stderr.write([
    "usage: dispatch-gate.ts <command>",
    "  check  --ref T23              GO/QUEUE before dispatching an owner (exit 1 = queue)",
    "  sample --ref T23 --note peak  record a datapoint mid-flight",
    "  report                        summarise what the log has learned",
    "",
  ].join("\n"));
  return 64;
}

if (import.meta.main) process.exit(main());
