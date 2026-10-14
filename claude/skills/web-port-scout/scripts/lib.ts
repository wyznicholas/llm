// lib.ts — the deterministic half of web-port-scout. Everything here is a pure
// function of its inputs (or one small file), so a scout run's judgement step
// starts from facts that were unit-tested, not re-derived by a model each time.
import { Glob } from "bun";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Commit { sha: string; author: string; date: string; subject: string; files: string[] }
export type Prefilter = "skip" | "dep-bump" | "judge";
export interface Unit {
  id: string; scope: string; types: string[]; shas: string[]; subjects: string[];
  files: string[]; authors: string[]; firstDate: string; lastDate: string; prefilter: Prefilter;
}
export interface LogEntry {
  unit: string;
  verdict: "skip" | "port-existing" | "port-new" | "ask" | "duplicate" | "none";
  reason: string;
  card?: string;
}

const RS = "\x1e";
const US = "\x1f";
export const LOG_FORMAT = `${RS}%H${US}%an${US}%aI${US}%s`;

export function parseLog(text: string): Commit[] {
  return text.split(RS).filter(chunk => chunk.trim()).map(chunk => {
    const [head = "", ...rest] = chunk.split("\n");
    const [sha = "", author = "", date = "", subject = ""] = head.split(US);
    return { sha, author, date, subject, files: rest.map(l => l.trim()).filter(Boolean) };
  });
}

/** Only real conventional types group. Web `production` also carries bundled
 *  picks titled `production: …`, which are many changes in one commit and must
 *  never be folded into a neighbour. */
const TYPES = "feat|fix|perf|refactor|chore|test|docs|style|build|ci|revert";
const CONVENTIONAL = new RegExp(`^(${TYPES})(?:\\(([^)]+)\\))?!?:\\s`);

export function scopeOf(subject: string): { type: string; scope: string } | null {
  const m = CONVENTIONAL.exec(subject);
  return m ? { type: m[1]!, scope: m[2] ?? m[1]! } : null;
}

/** Same exact-line rule as train-surfaces.md: prose can never become a glob. */
export function parseSkipAreas(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^- `([^`]+)` — .+$/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

const DEP_BUMP = /^chore\(deps\): bump @orangecharts\//;

export function prefilter(unit: Pick<Unit, "subjects" | "files">, skipGlobs: string[]): Prefilter {
  if (unit.subjects.length && unit.subjects.every(s => DEP_BUMP.test(s))) return "dep-bump";
  const globs = skipGlobs.map(g => new Glob(g));
  // `files.length` guards the vacuous case: an empty commit is not "all skip".
  if (unit.files.length && unit.files.every(f => globs.some(g => g.match(f)))) return "skip";
  return "judge";
}

const addUnique = (list: string[], value: string) => { if (!list.includes(value)) list.push(value); };

export function groupUnits(commits: Commit[], skipGlobs: string[], windowHours = 12): Unit[] {
  const units: Unit[] = [];
  const open = new Map<string, Unit>();
  const windowMs = windowHours * 3_600_000;
  for (const commit of commits) {
    const conv = scopeOf(commit.subject);
    let unit = conv ? open.get(conv.scope) : undefined;
    // Author dates on cherry-picked production commits are not monotonic, so
    // compare by distance, not direction.
    if (unit && Math.abs(Date.parse(commit.date) - Date.parse(unit.lastDate)) > windowMs) unit = undefined;
    if (!unit) {
      const scope = conv?.scope ?? "misc";
      unit = {
        id: `${scope}@${commit.sha.slice(0, 10)}`, scope, types: [], shas: [], subjects: [],
        files: [], authors: [], firstDate: commit.date, lastDate: commit.date, prefilter: "judge",
      };
      units.push(unit);
      if (conv) open.set(conv.scope, unit);
    }
    if (conv) addUnique(unit.types, conv.type);
    unit.shas.push(commit.sha);
    unit.subjects.push(commit.subject);
    for (const f of commit.files) addUnique(unit.files, f);
    addUnique(unit.authors, commit.author);
    if (Date.parse(commit.date) > Date.parse(unit.lastDate)) unit.lastDate = commit.date;
    if (Date.parse(commit.date) < Date.parse(unit.firstDate)) unit.firstDate = commit.date;
  }
  for (const unit of units) unit.prefilter = prefilter(unit, skipGlobs);
  return units;
}

/** Every card note quoting this web SHA (at its 10-character prefix). All of
 *  them, not the first: a `production:` bundle is filed one card per part, and
 *  a re-run after a crash must see which parts already have a card. */
export function citesAll(cardsDir: string, sha: string): string[] {
  if (!existsSync(cardsDir)) return [];
  const needle = sha.slice(0, 10);
  return readdirSync(cardsDir)
    .filter(name => name.endsWith(".md") && readFileSync(join(cardsDir, name), "utf8").includes(needle));
}

export function cites(cardsDir: string, sha: string): string | null {
  return citesAll(cardsDir, sha)[0] ?? null;
}

export function readCursor(path: string): string | null {
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf8").trim();
  return value || null;
}

export function writeCursor(path: string, sha: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${sha}\n`);
  renameSync(temp, path);
}

export function formatLog(stamp: string, range: string, entries: LogEntry[]): string {
  const lines = entries.map(e =>
    `- \`${e.unit}\` **${e.verdict}**: ${e.reason}` +
    (e.card ? ` → [[kanban/cards/${e.card}|${e.card}]]` : ""));
  return `\n## ${stamp} · ${range}\n\n${lines.join("\n")}\n`;
}
