#!/usr/bin/env bun
// scout.ts — CLI for web-port-scout. See ../SKILL.md for the run procedure and
// the design: Obisidian/openmarket/plans/26-10-08 web-port-scout design.md.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  LOG_FORMAT, citesAll, formatLog, groupUnits, parseLog, parseSkipAreas, readCursor, writeCursor,
  type LogEntry,
} from "./lib";

const HOME = homedir();
const DEFAULTS = {
  repo: join(HOME, "Documents/GitlabRepos/kiyotaka-frontend"),
  cursor: join(HOME, ".claude/om-bug-loop/web-port-cursor"),
  cards: join(HOME, "Documents/Obisidian/kanban/cards"),
  log: join(HOME, "Documents/Obisidian/openmarket-mobile-charts/web-port-log.md"),
  skip: join(import.meta.dir, "../references/skip-areas.md"),
};
const BRANCH = "production";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const positionals = () => {
  const out: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i]!.startsWith("--")) { i++; continue; }
    out.push(args[i]!);
  }
  return out;
};

class Refusal extends Error {}
function git(repo: string, ...gitArgs: string[]): string {
  const r = Bun.spawnSync(["git", "-C", repo, ...gitArgs]);
  if (r.exitCode !== 0) throw new Refusal(`git ${gitArgs.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}
const remoteTip = (repo: string) => {
  const line = git(repo, "ls-remote", "origin", `refs/heads/${BRANCH}`).trim();
  if (!line) throw new Refusal(`origin has no ${BRANCH} branch`);
  return line.split(/\s+/)[0]!;
};

function main(): number {
  const command = args[0];
  const repo = flag("--repo", DEFAULTS.repo)!;
  const cursorPath = flag("--cursor", DEFAULTS.cursor)!;

  if (command === "gate") {
    const tip = remoteTip(repo);
    const cursor = readCursor(cursorPath);
    if (!cursor) { console.log(`NOCURSOR ${tip}`); return 11; }
    if (cursor === tip) { console.log(`SAME ${tip}`); return 0; }
    console.log(`NEW ${tip}`); return 10;
  }
  if (command === "init") {
    const existing = readCursor(cursorPath);
    if (existing) { console.log(`cursor ${existing}`); return 0; }
    const tip = remoteTip(repo);
    writeCursor(cursorPath, tip);
    console.log(`cursor ${tip}`); return 0;
  }
  if (command === "units") {
    git(repo, "fetch", "-q", "origin", BRANCH);
    const from = flag("--from") ?? readCursor(cursorPath);
    if (!from) throw new Refusal("no cursor; run `scout.ts init` first or pass --from");
    const to = flag("--to") ?? git(repo, "rev-parse", `origin/${BRANCH}`).trim();
    // A rewritten production (or a stale cursor) would otherwise turn into a
    // range of thousands of commits and a flood of cards.
    const ancestor = Bun.spawnSync(["git", "-C", repo, "merge-base", "--is-ancestor", from, to]);
    if (ancestor.exitCode !== 0) throw new Refusal(`${from} is not an ancestor of ${to}; production was rewritten or the cursor is wrong. Not guessing a range.`);
    // Full SHAs out, whatever the caller passed (`3c227b8058^`, a short sha):
    // `to` becomes the cursor, and the cursor is compared verbatim by `gate`.
    const fromSha = git(repo, "rev-parse", from).trim();
    const toSha = git(repo, "rev-parse", to).trim();
    const log = git(repo, "log", "--reverse", "--no-merges", `--format=${LOG_FORMAT}`, "--name-only", `${fromSha}..${toSha}`);
    const skip = parseSkipAreas(readFileSync(flag("--skip", DEFAULTS.skip)!, "utf8"));
    console.log(JSON.stringify({ from: fromSha, to: toSha, units: groupUnits(parseLog(log), skip) }, null, 2));
    return 0;
  }
  if (command === "cites") {
    const cards = flag("--cards", DEFAULTS.cards)!;
    for (const sha of positionals()) {
      for (const hit of citesAll(cards, sha)) console.log(`${sha.slice(0, 10)} ${hit}`);
    }
    return 0;
  }
  if (command === "log") {
    const entries = JSON.parse(readFileSync(flag("--entries")!, "utf8")) as LogEntry[];
    const range = flag("--range");
    if (!range) throw new Refusal("log needs --range <from..to>");
    const path = flag("--log", DEFAULTS.log)!;
    if (!existsSync(path)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "# web-port-scout run log\n"); }
    const stamp = new Date().toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
    appendFileSync(path, formatLog(stamp, range, entries));
    return 0;
  }
  if (command === "advance") {
    const given = positionals()[0];
    if (!given) throw new Refusal("advance needs a sha");
    // `gate` compares the cursor verbatim with the remote tip, so store the full
    // SHA; and refuse anything production does not contain, or every later
    // `units` would refuse (a typo) or re-handle the wrong range.
    const sha = git(repo, "rev-parse", "--verify", "-q", `${given}^{commit}`).trim();
    git(repo, "fetch", "-q", "origin", BRANCH);
    const onProduction = Bun.spawnSync(["git", "-C", repo, "merge-base", "--is-ancestor", sha, `origin/${BRANCH}`]);
    if (onProduction.exitCode !== 0) throw new Refusal(`${given} is not on origin/${BRANCH}; cursor unchanged`);
    writeCursor(cursorPath, sha);
    console.log(`cursor ${sha}`); return 0;
  }
  console.error("usage: scout.ts <gate|init|units|cites|log|advance> [--repo R] [--cursor C] …");
  return 64;
}

try { process.exit(main()); }
catch (e) { console.error((e as Error).message); process.exit(2); }
