#!/usr/bin/env bun
//
// phase.ts — stamp phase boundaries so a timing account is MEASURED, not recalled.
//
// Why this exists: every om-task reports its own phase breakdown, but om-verifier
// reports only a total. So when the pipeline's biggest single cost turned out to
// be "the blocking verifier, 19-48 min", nobody could say what inside it was
// expensive — and the coordinator filled the gap by subtracting suite time from
// total time and attributing the residual to build-and-boot. That attribution was
// wrong (the verifier is already told not to rebuild), and it nearly bought a
// day of tooling aimed at a phase that costs seconds.
//
// A mark is a checkpoint, not a start/end pair: pairs get mismatched under
// retries, checkpoints cannot. Duration of a phase is the gap to the next mark.
//
//   phase.ts mark <evidence-dir> "<label>"
//   phase.ts report <evidence-dir> [--md]
//
// The `phases.jsonl` it writes is itself a bankable artifact, so a timing
// account can cite it and pass verify-lint.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Mark { label: string; ts: string }
export interface Span { label: string; ms: number; from: string }

export const marksFile = (dir: string) => join(dir, "phases.jsonl");

export function readMarks(dir: string): Mark[] {
  const f = marksFile(dir);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as Mark);
}

export function addMark(dir: string, label: string, now = new Date().toISOString()): Mark {
  mkdirSync(dir, { recursive: true });
  const mark: Mark = { label, ts: now };
  appendFileSync(marksFile(dir), `${JSON.stringify(mark)}\n`);
  return mark;
}

/** A phase runs from its mark to the NEXT mark. The final mark closes the last
 *  phase and has no duration of its own — so end with an explicit "done". */
export function spans(marks: Mark[]): Span[] {
  const out: Span[] = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const a = marks[i]!, b = marks[i + 1]!;
    out.push({ label: a.label, ms: Date.parse(b.ts) - Date.parse(a.ts), from: a.ts });
  }
  return out;
}

export const human = (ms: number) =>
  ms < 1000 ? `${ms}ms`
    : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s`
      : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;

export function render(marks: Mark[], md = false): string {
  const s = spans(marks);
  if (!s.length) return "phase: nothing recorded yet\n";
  const total = Date.parse(marks[marks.length - 1]!.ts) - Date.parse(marks[0]!.ts);
  const w = Math.max(...s.map(x => x.label.length), 5);
  const pct = (ms: number) => total > 0 ? `${((ms / total) * 100).toFixed(0)}%` : "-";
  const rows = s.map(x => md
    ? `| ${x.label} | ${human(x.ms)} | ${pct(x.ms)} |`
    : `  ${x.label.padEnd(w)}  ${human(x.ms).padStart(7)}  ${pct(x.ms).padStart(4)}`);
  const head = md ? ["| phase | elapsed | share |", "|---|---:|---:|"] : [];
  const foot = md ? `| **total** | **${human(total)}** | |` : `  ${"TOTAL".padEnd(w)}  ${human(total).padStart(7)}`;
  return [...head, ...rows, foot, ""].join("\n");
}

function main(): number {
  const [cmd, dir, ...rest] = process.argv.slice(2);
  if (!cmd || !dir) {
    process.stderr.write('usage: phase.ts mark <dir> "<label>" | phase.ts report <dir> [--md]\n');
    return 64;
  }
  if (cmd === "mark") {
    const label = rest.filter(a => !a.startsWith("--")).join(" ").trim();
    if (!label) { process.stderr.write('phase.ts mark <dir> "<label>"\n'); return 64; }
    const m = addMark(dir, label);
    process.stdout.write(`phase ✓ ${m.label}  ${m.ts}\n`);
    return 0;
  }
  if (cmd === "report") {
    process.stdout.write(render(readMarks(dir), rest.includes("--md")));
    return 0;
  }
  process.stderr.write(`unknown command: ${cmd}\n`);
  return 64;
}

if (import.meta.main) process.exit(main());
