#!/usr/bin/env bun
//
// verify-lint.ts — mechanical check that a verify report's claims are BANKED.
//
// This exists because `om-evidence-auditor` is gone. The auditor's two real
// catches on the cloud ports were both the same shape: a sentence asserting a
// measurement that no artifact backed — "mergeable" stated in prose, and a card
// claiming the fixed line "stays a heading", which was false on that fork. Both
// are mechanically detectable: a claim with no citation behind it.
//
// What it CANNOT catch, and nobody should believe otherwise: a number extracted
// wrongly FROM a real artifact. T54's owner under-counted failures with an
// anchored grep while citing the correct file; this lint would pass that report.
// It replaces the auditor's cheapest half, not its judgement.
//
// Usage:
//   verify-lint.ts <report.md> [--evidence <dir>] [--quiet]
// Exit 0 clean, 1 findings, 64 usage.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface Finding {
  kind: "dead-citation" | "ephemeral-citation" | "uncited-claim";
  line: number;
  text: string;
  detail: string;
}

/** A citation is any path-shaped token: a backticked path, a wikilink target,
 *  or a bare filename with a known evidence extension. Deliberately generous —
 *  a false positive costs one resolved path, a false negative costs the check. */
const CITE_RE = new RegExp(
  [
    "`([^`\\n]*(?:/|\\.(?:md|txt|png|jpg|json|jsonl|log|tsv|mjs|ts|tsx|patch))[^`\\n]*)`", // `a/b.txt`, `b.txt`
    "!?\\[\\[([^\\]\\n|]+)(?:\\|[^\\]\\n]*)?\\]\\]", // [[vault/path]] and ![[…]]
    "(?<![`\\w/])([\\w.@-]+(?:/[\\w.@-]+)*\\.(?:md|txt|png|jpg|json|jsonl|log|tsv|mjs|ts|tsx|patch))\\b",
  ].join("|"),
  "g",
);

/** Measurement-shaped numbers. NOT every digit: a commit sha, a date, a version
 *  or a line reference is not a claim, and flagging them would train everyone to
 *  ignore the output — which is how the OVER-HOUR flag became noise. */
const CLAIM_RE = new RegExp(
  [
    "\\b\\d[\\d,]*(?:\\.\\d+)?\\s*(?:ms|s|sec|secs|min|mins|%)\\b",
    "\\b\\d[\\d,]*\\s*(?:pass|passed|passing|fail|failed|failing|errors?|warnings?|" +
      "diagnostics?|files?|tests?|lines?|entries|artifacts?|divergences?|hunks?)\\b",
    // A line reference (`session.ts:2931`, `:1628`) is not a measurement. Without
    // this lookbehind the lint fires on every grep transcript, and a gate that
    // cries wolf 100 times per report is a gate nobody reads.
    "(?<![:.\\w])\\d{4,}\\b",
  ].join("|"),
  "gi",
);

/** Extensions that only exist as produced evidence. A `.ts` or `.md` that does
 *  not resolve is a source path or a plan, not a missing artifact. */
const ARTIFACT_EXT = /\.(?:txt|log|jsonl|tsv|png|jpg|patch)$/i;

const isSha = (t: string) => /^[0-9a-f]{7,40}$/i.test(t) && /[a-f]/i.test(t);
const isDate = (t: string) => /^20\d{2}([-/]\d{2}){0,2}$/.test(t);

export function citationsIn(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(CITE_RE)) {
    const hit = m[1] ?? m[2] ?? m[3];
    if (hit) out.push(hit.trim());
  }
  return out;
}

export function claimsIn(line: string): string[] {
  return [...line.matchAll(CLAIM_RE)]
    .map(m => m[0].trim())
    .filter(t => !isSha(t) && !isDate(t));
}

/** Every file under a root, indexed by basename. Reports cite bare filenames
 *  (`base-full-run.txt`) for artifacts that actually live a level down in
 *  `verifier/` — which is how a human finds them, so the lint should too.
 *  Without this, 10 of T56's genuinely-banked artifacts read as dead. */
function indexByName(root: string, depth = 4): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, left: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (left > 0) walk(full, left - 1); continue; }
      if (!out.has(e.name)) out.set(e.name, full);
    }
  };
  if (existsSync(root)) walk(root, depth);
  return out;
}

/** Resolve a citation the way a reader would: absolute as-is, then against the
 *  evidence dir and the report's own directory, then by basename anywhere in
 *  the evidence tree. */
function resolveCite(
  cite: string, evidenceDir: string, reportDir: string, index: Map<string, string>,
): string | null {
  const tries = isAbsolute(cite)
    ? [cite]
    : [resolve(evidenceDir, cite), resolve(reportDir, cite)];
  for (const t of tries) if (existsSync(t)) return t;
  return index.get(basename(cite)) ?? null;
}

/**
 * Sections are delimited by any markdown heading. A claim is satisfied by a
 * citation ANYWHERE in its section, not on its own line — reports legitimately
 * write "see X below" and then a table of numbers, and demanding a path per row
 * would produce unreadable prose that nobody writes and everyone bypasses.
 */
export function lint(
  md: string, opts: { evidenceDir: string; reportDir: string; vaultEvidence?: string },
): Finding[] {
  const lines = md.split("\n");
  const findings: Finding[] = [];
  const index = indexByName(opts.evidenceDir);

  // Pass 1: every citation must resolve, and must live somewhere durable.
  const resolvedPerLine: (string | null)[] = lines.map(() => null);
  lines.forEach((line, i) => {
    for (const cite of citationsIn(line)) {
      const hit = resolveCite(cite, opts.evidenceDir, opts.reportDir, index);
      if (!hit) {
        // A report legitimately NAMES the code under review — `src/lib/session.ts`,
        // the plan, another report. Those are references, not measurements, and
        // flagging them buried the real signal 86-to-11 on the first real run.
        // Only an artifact-shaped extension is expected to resolve: those file
        // types exist *because* something was measured into them.
        if (ARTIFACT_EXT.test(cite)) {
          findings.push({
            kind: "dead-citation", line: i + 1, text: cite,
            detail: "artifact cited but not found — the claim it backs is unbanked",
          });
        }
        continue;
      }
      const durable = [opts.evidenceDir, opts.vaultEvidence].filter(Boolean)
        .some(root => !relative(resolve(root!), hit).startsWith(".."));
      // Only a durable artifact BACKS a claim. A resolving path into a worktree
      // proves nothing later, because the worktree is removed at close-out.
      if (durable) resolvedPerLine[i] = hit;
      if (!durable && ARTIFACT_EXT.test(cite)) {
        findings.push({
          kind: "ephemeral-citation", line: i + 1, text: cite,
          detail: `lives outside the evidence dir (${hit}) — a worktree is deleted at ` +
            "close-out, so this cannot be re-derived later",
        });
      }
    }
  });

  // Pasted command output inside a fence is the artifact's CONTENT, not a claim
  // the report is making in its own voice. Citations inside fences still count.
  const fenced: boolean[] = [];
  let inFence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) { fenced.push(true); inFence = !inFence; continue; }
    fenced.push(inFence);
  }

  // Pass 2: a section carrying measurement-shaped numbers needs a live citation.
  let start = 0;
  const bounds: [number, number][] = [];
  lines.forEach((l, i) => {
    if (/^#{1,6}\s/.test(l)) { bounds.push([start, i]); start = i; }
  });
  bounds.push([start, lines.length]);

  for (const [from, to] of bounds) {
    if (to <= from) continue;
    const cited = resolvedPerLine.slice(from, to).some(Boolean);
    if (cited) continue;
    for (let i = from; i < to; i++) {
      if (fenced[i]) continue;
      const claims = claimsIn(lines[i]!);
      if (!claims.length) continue;
      findings.push({
        kind: "uncited-claim", line: i + 1, text: claims.join(", "),
        detail: `no resolving artifact anywhere in section "${
          (lines[from] ?? "").replace(/^#+\s*/, "").trim() || "(preamble)"}"`,
      });
    }
  }
  return findings;
}

function main(): number {
  const args = process.argv.slice(2);
  const report = args.find(a => !a.startsWith("--"));
  if (!report) {
    process.stderr.write("usage: verify-lint.ts <report.md> [--evidence <dir>] [--quiet]\n");
    return 64;
  }
  if (!existsSync(report)) {
    process.stderr.write(`no such report: ${report}\n`);
    return 64;
  }
  const flag = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const reportDir = dirname(resolve(report));
  const evidenceDir = resolve(flag("--evidence") ?? reportDir);
  const vaultEvidence = flag("--vault");

  const findings = lint(readFileSync(report, "utf8"), { evidenceDir, reportDir, vaultEvidence });
  if (!findings.length) {
    if (!args.includes("--quiet")) {
      const n = statSync(report).size;
      process.stdout.write(`verify-lint: clean — every claim in ${report} (${n} B) is banked\n`);
    }
    return 0;
  }
  for (const f of findings) {
    process.stdout.write(`${f.kind.padEnd(19)} ${report}:${f.line}  ${f.text}\n    ${f.detail}\n`);
  }
  process.stdout.write(`\nverify-lint: ${findings.length} finding(s). Bank the artifact, or delete the claim.\n`);
  return 1;
}

if (import.meta.main) process.exit(main());
