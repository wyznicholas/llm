#!/usr/bin/env bun
// train.ts — the only door from an owned fix branch onto a surface train.
//
// One-PR-per-task produced 55 open PRs and repeated conflicts on the same few
// UI files. A train batches fixes by surface without capping open work, while
// ref-prefixed commits keep every fix independently revertible.
//
// Usage:
//   bun train.ts ship <ref> --surface <key> --branch <owner-branch> --section <md> (--test-cmd <cmd> [--test-list <file>] | --test-list <file> | --verified <log>)
//   bun train.ts drop <ref> [--surface <key>] [--reason <why>]
//   bun train.ts status [--repo <checkout>] [--gh-repo <owner/name>]
//   bun train.ts landed [--repo <checkout>] [--gh-repo <owner/name>]
// Exit 5 means the ship succeeded, but its card could not move to Review.
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  DEFAULT_BOARD,
  DEFAULT_TASKS,
  humanDuration,
  knownRefs,
  listRows,
  resolveRef,
} from "./kanban";

export const DEFAULT_REPO = "/Users/nicholas/Documents/GitlabRepos/openmarket-chat";
export const DEFAULT_SURFACES = join(import.meta.dir, "../references/train-surfaces.md");
/** Distinct because shipping succeeded; only the card move failed. */
export const EXIT_SHIPPED_NOT_IN_REVIEW = 5;
const TRAIN = resolve(import.meta.path);
const SURFACE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Only exact list lines count, so prose examples cannot accidentally become
 * valid routing keys. */
export function parseSurfaces(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^- `([a-z0-9]+(?:-[a-z0-9]+)*)` — (.+)$/.exec(line);
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

/** A generated key uses the same human-editable format as every existing key,
 * and preserves the reference document around it byte-for-byte. */
export function appendSurface(text: string, key: string, desc: string): string {
  if (!SURFACE_RE.test(key)) throw new Error(`invalid surface key: ${key}`);
  if (!desc.trim()) throw new Error("a new surface needs a description");
  if (parseSurfaces(text).has(key)) return text;
  return `${text.replace(/\s*$/, "")}\n- \`${key}\` — ${desc.trim()}\n`;
}

const PREFIX = /^(?:([TRFC]\d+)\b|\[([TRFC]\d+)\](?=\s|$))/;

/** The leading ref is the ownership boundary: later commits carrying another
 * ref are never silently pulled into this fix. */
export function leadingRef(subject: string): string | null {
  const m = PREFIX.exec(subject);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

export function commitRef(subject: string): string | null {
  const leading = leadingRef(subject);
  if (leading) return leading;
  const trailing = /\(([TRFC]\d+)\)\s*$/.exec(subject);
  if (trailing) return trailing[1]!;
  const refs = [...new Set(subject.match(/\b[TRFC]\d+\b/g) ?? [])];
  return refs.length === 1 ? refs[0]! : null;
}

/** Prefix only unowned subjects; rewriting an already-canonical subject would
 * create noisy commits and make retries non-idempotent. */
export function withRef(subject: string, ref: string): string {
  return leadingRef(subject) === ref ? subject : `${ref} ${subject}`;
}

export interface ParsedSection {
  meta: Record<string, string>;
  body: string;
}

// Mirrors stamp.ts's `.md` provenance header.
const MARKDOWN_PROVENANCE_HEADER = /^<!--\s*om-bug-loop:provenance\b.*-->$/;

/** PR sections are durable handoff records, so malformed front matter fails
 * before any branch is rebuilt or pushed. */
export function parseSection(text: string): ParsedSection {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !MARKDOWN_PROVENANCE_HEADER.test(trimmed);
  });
  if (lines[start]?.trim() !== "---")
    throw new Error("section must start with --- front matter");
  const end = lines.slice(start + 1).findIndex((line) => line.trim() === "---");
  if (end < 0) throw new Error("section front matter needs a closing --- line");
  const meta: Record<string, string> = {};
  for (const line of lines.slice(start + 1, start + end + 1)) {
    const m = /^([^:#][^:]*):\s*(.*)$/.exec(line);
    if (m) meta[m[1]!.trim()] = m[2]!.trim();
  }
  return {
    meta,
    body: lines
      .slice(start + end + 2)
      .join("\n")
      .trim(),
  };
}

export function trainTitle(surface: string, refs: string[]): string {
  return `train(${surface}): ${refs.length} fixes — ${refs.join(", ")}`;
}

export interface BodyRow {
  ref: string;
  title: string;
  files: number;
  added: number;
  deleted: number;
  verdict: string;
  try: string;
  body: string;
}
const cell = (v: unknown) => String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** The body is regenerated from train commits plus durable sections, keeping
 * the PR an accurate manifest after every append or drop. */
export function renderBody(rows: BodyRow[], unattributed: string[], notes = ""): string {
  const first =
    "**Merge with Rebase and merge.** Each fix is one or more commits whose subject starts with its ref, so any single fix can be reverted on its own.";
  const table = [
    "| fix | ref | files | lines ± | verifier | how to try |",
    "| --- | --- | ---: | ---: | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${cell(r.title)} | ${r.ref} | ${r.files} | +${r.added} −${r.deleted} | ${cell(r.verdict)} | ${cell(r.try)} |`,
    ),
  ];
  const sections = rows.map((r) => `## ${r.ref} · ${r.title}\n\n${r.body.trim()}`);
  const tail = unattributed.length
    ? [
        `## unattributed`,
        "",
        "Commits without a leading task ref:",
        "",
        ...unattributed.map((s) => `- ${s}`),
      ].join("\n")
    : "";
  return [
    first,
    "",
    ...table,
    "",
    ...(notes.trim() ? [notes.trim(), ""] : []),
    ...sections.flatMap((s, i) => (i ? ["", s] : [s])),
    ...(tail ? ["", tail] : []),
    "",
  ].join("\n");
}

/** Existing hand-built sections are imported before regeneration, because a
 * missing local cache is not permission to erase another owner's evidence. */
export function parseBodySections(body: string): Map<string, { title: string; body: string }> {
  const out = new Map<string, { title: string; body: string }>();
  const matches = [...body.matchAll(/^## ([TRFC]\d+) · (.+)\s*$/gm)];
  matches.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = matches[i + 1]?.index ?? body.length;
    out.set(m[1]!, { title: m[2]!.trim(), body: body.slice(start, end).trim() });
  });
  return out;
}

function tableCells(line: string): string[] {
  if (!/^\s*\|/.test(line)) return [];
  const cells: string[] = [];
  let cur = "";
  const start = line.indexOf("|") + 1;
  for (let i = start; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  return cells;
}

/** Table metadata is enough to reconstruct front matter when adopting a train
 * that another agent built without the local section store. */
export function parseBodyTable(body: string): Map<string, { verdict: string; try: string }> {
  const out = new Map<string, { verdict: string; try: string }>();
  const lines = body.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => tableCells(line).includes("ref"));
  if (headerIndex < 0) return out;
  const headers = tableCells(lines[headerIndex]!);
  const refIndex = headers.findIndex((value) => value === "ref");
  const verdictIndex = headers.findIndex((value) => /verifier|verdict/i.test(value));
  const tryIndex = headers.findIndex((value) => /try/i.test(value));
  for (const line of lines.slice(headerIndex + 1)) {
    if (!/^\s*\|/.test(line)) break;
    const cells = tableCells(line);
    const ref = cells[refIndex] ?? "";
    if (/^[TRFC]\d+$/.test(ref)) {
      out.set(ref, {
        verdict: verdictIndex < 0 ? "—" : cells[verdictIndex] || "—",
        try: tryIndex < 0 ? "—" : cells[tryIndex] || "—",
      });
    }
  }
  return out;
}

export function parseBodyNotes(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const headerIndex = lines.findIndex((line) => tableCells(line).includes("ref"));
  if (headerIndex < 0) return "";
  let tableEnd = headerIndex;
  while (tableEnd + 1 < lines.length && /^\s*\|/.test(lines[tableEnd + 1]!)) tableEnd++;
  const sectionOffset = lines
    .slice(tableEnd + 1)
    .findIndex((line) => /^## [TRFC]\d+ · /.test(line));
  if (sectionOffset < 0) return "";
  return lines.slice(tableEnd + 1, tableEnd + 1 + sectionOffset).join("\n").trim();
}

/** GitHub check objects vary between CheckRun and StatusContext; normalize
 * both shapes so an absent conclusion remains visibly in progress. */
export function ciSummary(rollup: unknown): string {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  const counts = { success: 0, failure: 0, pending: 0, skipped: 0 };
  for (const raw of rollup) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const value = String(item.conclusion ?? item.state ?? "").toUpperCase();
    if (["SUCCESS", "EXPECTED", "NEUTRAL"].includes(value)) counts.success++;
    else if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(value))
      counts.failure++;
    else if (value === "SKIPPED") counts.skipped++;
    else counts.pending++;
  }
  return [
    counts.success ? `${counts.success}✓` : "",
    counts.failure ? `${counts.failure}✗` : "",
    counts.pending ? `${counts.pending}…` : "",
    counts.skipped ? `${counts.skipped}↷` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, contents);
  renameSync(temp, path);
}
const writeJson = (path: string, value: unknown) =>
  atomicWrite(path, `${JSON.stringify(value, null, 1)}\n`);
const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

class Stop extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}
const refuse = (message: string, code = 1): never => {
  throw new Stop(code, message);
};

export const BUN_TEST_FILE = /(?:\.|_)(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

export function normalizeTestPath(entry: string, repo: string): string {
  const resolvedRepo = resolve(repo);
  const resolvedEntry = isAbsolute(entry) ? resolve(entry) : resolve(resolvedRepo, entry);
  let comparedRepo = resolvedRepo;
  let comparedEntry = resolvedEntry;
  try {
    const realRepo = realpathSync(resolvedRepo);
    const realEntry = realpathSync(resolvedEntry);
    comparedRepo = realRepo;
    comparedEntry = realEntry;
  } catch {
    // Missing paths are checked by the caller after lexical containment is established.
  }
  const repoRelative = relative(comparedRepo, comparedEntry).replaceAll("\\", "/");
  if (
    !repoRelative ||
    repoRelative === ".." ||
    repoRelative.startsWith("../") ||
    isAbsolute(repoRelative)
  )
    refuse(
      `test path resolves outside the repository or to the repository itself: ${JSON.stringify(entry)}`,
      64,
    );
  return repoRelative;
}

export function parseTestList(text: string): { files: string[]; dropped: string[] } {
  const files: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r\n?|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (
      line.startsWith("#") ||
      line.startsWith("//") ||
      line.startsWith("<!--") ||
      line.includes("om-bug-loop:provenance")
    ) {
      dropped.push(raw);
      continue;
    }
    const tokens = line.split(/\s+/);
    if (
      tokens.some(
        (token) =>
          token.startsWith("#") ||
          token === "//" ||
          token.startsWith("<!--") ||
          token.includes("om-bug-loop:provenance"),
      )
    )
      refuse(`comment token in the middle of test list line ${JSON.stringify(raw)}`, 64);
    for (const token of tokens) {
      if (
        !/^[A-Za-z0-9_@+.\-/]+$/.test(token) ||
        token.startsWith("-") ||
        !BUN_TEST_FILE.test(token)
      ) {
        dropped.push(token);
        continue;
      }
      if (!seen.has(token)) {
        seen.add(token);
        files.push(token);
      }
    }
  }
  return { files, dropped };
}

export function assertCommandSafe(cmd: string): void {
  let offending: string | undefined;
  if (cmd.includes("\n")) offending = "<newline>";
  else if (cmd.includes("\r")) offending = "<carriage-return>";
  else {
    const tokens = cmd.split(/\s+/).filter(Boolean);
    offending = tokens.find(
      (token) =>
        // Quoting a comment token does not make its intent unambiguous; fail closed.
        /^["']?#/.test(token) ||
        token.includes("om-bug-loop:provenance") ||
        token.includes("<!--"),
    );
  }
  if (offending !== undefined)
    refuse(
      `test command would comment out part of the test run; offending token: ${JSON.stringify(offending)}`,
      64,
    );
}

export function buildTestCommand(prefix: string, files: string[]): string {
  if (files.length === 0)
    refuse(
      "test list yields zero test files — refusing to print a re-verify command that runs nothing (or everything)",
      64,
    );
  const command = `${prefix.trim()} ${files.join(" ")}`;
  assertCommandSafe(command);
  return command;
}

export function parseBunSummary(log: string): { tests: number; files: number }[] {
  return [...log.matchAll(/Ran (\d+) tests? across (\d+) files?\./g)].map((match) => ({
    tests: Number(match[1]),
    files: Number(match[2]),
  }));
}

interface ProcResult {
  code: number;
  out: string;
  err: string;
}
function exec(cmd: string[], cwd?: string, env?: Record<string, string | undefined>): ProcResult {
  const p = Bun.spawnSync({
    cmd,
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
function must(
  cmd: string[],
  cwd?: string,
  env?: Record<string, string | undefined>,
): string {
  const r = exec(cmd, cwd, env);
  if (r.code !== 0) refuse((r.err || r.out || `${cmd[0]} failed`).trim());
  return r.out.trim();
}
const git = (repo: string, ...args: string[]) => must(["git", ...args], repo);
const gitMaybe = (repo: string, ...args: string[]) => exec(["git", ...args], repo);
// Rewritten train commits carry the house committer regardless of local config; authors stay intact.
const HOUSE_COMMITTER = {
  GIT_COMMITTER_NAME: "Nicholas Wong",
  GIT_COMMITTER_EMAIL: "nicholaswong@trontalgroup.com",
};
const gitCommit = (repo: string, ...args: string[]) =>
  must(["git", ...args], repo, HOUSE_COMMITTER);
const gitCommitMaybe = (repo: string, ...args: string[]) =>
  exec(["git", ...args], repo, HOUSE_COMMITTER);
const ghBin = () => process.env.TRAIN_GH ?? "gh";
const gh = (repoPath: string, ...args: string[]) => must([ghBin(), ...args], repoPath);
const kanbanPath = () => process.env.TRAIN_KANBAN ?? join(import.meta.dir, "kanban.ts");

interface LockInfo {
  pid: number;
  ref: string;
  command: string;
  startedAt: string;
}
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}
const lockDescription = (p: string, x: Partial<LockInfo>, stale: boolean) =>
  `${stale ? "stale lock" : "lock wait expired"}: ${p} held by pid ${x.pid ?? "?"} (${x.ref ?? "?"}, ${x.command ?? "?"}, since ${x.startedAt ?? "?"})`;

/** A surface lock covers the whole mutation so concurrent owners can only ever
 * observe and extend a complete train tip. Stale locks are diagnosed, never
 * stolen, because pid uncertainty must not turn into a competing push. */
export function withSurfaceLock<T>(
  home: string,
  surface: string,
  ref: string,
  fn: () => T,
  waitSeconds = 300,
  now = new Date().toISOString(),
): T {
  const path = join(home, "locks", `train-${surface}.lock`);
  mkdirSync(dirname(path), { recursive: true });
  const ours: LockInfo = {
    pid: process.pid,
    ref,
    command: process.argv[2] ?? "unknown",
    startedAt: now,
  };
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, JSON.stringify(ours));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holder: Partial<LockInfo> = {};
      let stale = false;
      try {
        holder = JSON.parse(readFileSync(path, "utf8"));
        stale = !holder.pid || processGone(holder.pid);
      } catch {
        stale = true;
      }
      if (stale)
        refuse(
          `${lockDescription(path, holder, true)} and that process is gone. Remove it if nothing else is shipping to train/${surface}: rm ${path}`,
          75,
        );
      if (Date.now() >= deadline)
        refuse(
          `${lockDescription(path, holder, false)}. Re-run with a longer --lock-wait if it is still active.`,
          75,
        );
      Bun.sleepSync(1000);
    }
  }
  const release = () => {
    try {
      const held = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
      if (held.pid === process.pid) unlinkSync(path);
    } catch {
      /* A replaced lock belongs to its replacer. */
    }
  };
  const onExit = () => release();
  const onInt = () => {
    release();
    process.exit(130);
  };
  const onTerm = () => {
    release();
    process.exit(143);
  };
  process.on("exit", onExit);
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    return fn();
  } finally {
    release();
    process.off("exit", onExit);
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

interface Pull {
  number: number;
  url: string;
  state: string;
  title?: string;
  body?: string;
  createdAt: string;
  headRefName?: string;
  [key: string]: unknown;
}
interface TrainState {
  continuing: boolean;
  fresh: boolean;
  baseTip: string;
  remoteTip: string | null;
  newest: Pull | null;
  stale: { sha: string; pr: { number: number; state: string } | null } | null;
}
function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
function repoName(repo: string): string {
  return gh(repo, "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner");
}
function prsForHead(repo: string, r: string, surface: string): Pull[] {
  const text = gh(
    repo,
    "pr",
    "list",
    "--repo",
    r,
    "--head",
    `train/${surface}`,
    "--state",
    "all",
    "--json",
    "number,url,state,title,createdAt,headRefOid",
    "--limit",
    "20",
  );
  return parseJson<Pull[]>(text, []).sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt)),
  );
}
function remoteSha(repo: string, surface: string): string | null {
  const p = gitMaybe(repo, "rev-parse", "--verify", "-q", `refs/remotes/origin/train/${surface}`);
  return p.code === 0 ? p.out.trim() : null;
}
function resolveTrainState(repo: string, r: string, surface: string): TrainState {
  const remoteTip = remoteSha(repo, surface);
  const newest = prsForHead(repo, r, surface)[0] ?? null;
  const continuing = !!remoteTip && (!newest || newest.state.toUpperCase() === "OPEN");
  const fresh = !continuing;
  return {
    continuing,
    fresh,
    remoteTip,
    newest,
    baseTip: continuing ? remoteTip! : git(repo, "rev-parse", "origin/main"),
    stale:
      fresh && remoteTip
        ? { sha: remoteTip, pr: newest ? { number: newest.number, state: newest.state } : null }
        : null,
  };
}

function commitInfo(repo: string, sha: string): { subject: string; body: string } {
  const raw = git(repo, "show", "-s", "--format=%s%x00%b", sha);
  const at = raw.indexOf("\0");
  return {
    subject: at < 0 ? raw : raw.slice(0, at),
    body: at < 0 ? "" : raw.slice(at + 1).trimEnd(),
  };
}
function rangeCommits(repo: string, upstream: string, branch: string): string[] {
  const args = [
    "rev-list",
    "--reverse",
    "--no-merges",
    "--right-only",
    "--cherry-pick",
    `${upstream}...${branch}`,
    "^origin/main",
  ];
  const merges = git(
    repo,
    "rev-list",
    "--merges",
    "--right-only",
    "--cherry-pick",
    `${upstream}...${branch}`,
    "^origin/main",
  )
    .split(/\s+/)
    .filter(Boolean);
  if (merges.length)
    refuse(`refusing to ship a range containing merge commits: ${merges.join(", ")}`);
  return git(repo, ...args)
    .split(/\s+/)
    .filter(Boolean);
}
function conflictMessage(surface: string, files: string[]): string {
  return `cherry-pick conflict in: ${files.join(", ") || "(unknown paths)"}\nrebase your branch onto origin/train/${surface} by hand — a hunk inside the fix's own logic goes to Codex — then run ship again`;
}
function rebuild(
  repo: string,
  branch: string,
  base: string,
  commits: string[],
  ref: string,
  surface: string,
): string {
  const original = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-B", branch, base);
  for (const sha of commits) {
    const picked = gitCommitMaybe(repo, "cherry-pick", sha);
    if (picked.code !== 0) {
      const files = gitMaybe(repo, "diff", "--name-only", "--diff-filter=U")
        .out.trim()
        .split(/\r?\n/)
        .filter(Boolean);
      gitMaybe(repo, "cherry-pick", "--abort");
      git(repo, "checkout", "-q", "-B", branch, original);
      refuse(conflictMessage(surface, files), 4);
    }
    const info = commitInfo(repo, "HEAD");
    if (leadingRef(info.subject) !== ref) {
      const args = ["commit", "--amend", "--no-verify", "-m", `${ref} ${info.subject}`];
      if (info.body) args.push("-m", info.body);
      gitCommit(repo, ...args);
    }
  }
  return git(repo, "rev-parse", "HEAD");
}

interface Pending {
  ref: string;
  slug: string;
  surface: string;
  repo: string;
  worktree: string;
  branch: string;
  baseTip: string;
  head: string;
  ownerCommits: number;
  fresh: boolean;
  stale: TrainState["stale"];
  testCmd: string;
  testFiles?: string[];
  rebasedAt: string;
  logPath: string;
}
const trainDir = (home: string, surface: string) => join(home, "trains", surface);
const pendingPath = (home: string, surface: string, ref: string) =>
  join(trainDir(home, surface), `${ref}.pending.json`);
function refuseOtherRepo(home: string, surface: string, repo: string): void {
  const path = join(trainDir(home, surface), "train.json");
  if (!existsSync(path)) return;
  const train = parseJson<Record<string, unknown>>(readFileSync(path, "utf8"), {});
  if (train.pr == null || typeof train.repo !== "string" || train.repo === repo) return;
  const pr = train.pr as Record<string, unknown>;
  const number = Number(pr.number);
  const repoShort = repo.split("/").at(-1) ?? repo;
  refuse(
    `surface "${surface}" is already a train in ${train.repo} (PR #${number}); ` +
      `pick a key for this repo, e.g. --surface ${repoShort}-${surface} ` +
      `--new-surface "<desc>"`,
  );
}
function refsAt(repo: string, tip: string): string[] {
  const log = git(repo, "log", "--reverse", "--format=%s", `origin/main..${tip}`);
  return [
    ...new Set(
      log
        .split(/\r?\n/)
        .map(commitRef)
        .filter((x): x is string => !!x),
    ),
  ];
}
function short(sha: string) {
  return sha.slice(0, 8);
}
function reverifyText(
  p: Pending,
  others: string[],
  otherCommits: number,
  sectionPath: string,
  overlap: string[] = [],
): string {
  const where = p.fresh ? "fresh from origin/main" : `tip ${short(p.baseTip)}`;
  const moved = overlap.length
    ? `\nThe moved base overlaps this fix in: ${overlap.join(", ")}\n`
    : "";
  const source = others.length ? others.join(", ") : "no other fixes";
  return [
    `${p.ref} rebased onto train/${p.surface} (${where}; ` +
      `${otherCommits} commit(s) from ${source}).${moved}`,
    "NOT SHIPPED. Re-run your scoped tests on the rebased tip, then ship with --verified:",
    "",
    `  cd ${p.worktree} && test "$(git rev-parse HEAD)" = ${p.head} && ` +
      `( ${p.testCmd} ) 2>&1 | tee ${p.logPath}`,
    "",
    "Diff the failure SET against your own branch's run, as before. Then:",
    "",
    `  bun ${TRAIN} ship ${p.ref} --surface ${p.surface} --branch ${p.branch} ` +
      `--section ${sectionPath} --verified ${p.logPath} --repo ${p.worktree}`,
  ].join("\n");
}

/** The ledger is read at the final mutation point so another task owner's keys
 * survive, including fields this script has never heard of. */
export function writeTaskFields(
  tasksPath: string,
  slug: string,
  fields: Record<string, unknown>,
): void {
  const all = parseJson<Record<string, Record<string, unknown>>>(
    readFileSync(tasksPath, "utf8"),
    {},
  );
  if (!all[slug]) refuse(`no entry for "${slug}" in ${tasksPath}`);
  const task = { ...all[slug] };
  for (const [key, value] of Object.entries(fields))
    value === undefined ? delete task[key] : (task[key] = value);
  all[slug] = task;
  writeJson(tasksPath, all);
}

function taskIdentity(
  input: string,
  tasks: string,
  board: string,
): { slug: string; ref: string; title: string; task: Record<string, unknown> } {
  let slug: string;
  try {
    slug = resolveRef(input, tasks, board);
  } catch (e) {
    refuse((e as Error).message);
  }
  const all = parseJson<Record<string, Record<string, unknown>>>(readFileSync(tasks, "utf8"), {});
  const task = all[slug!];
  if (!task) refuse(`no entry for "${slug!}" in ${tasks}`);
  const ref = typeof task.ref === "string" ? task.ref.toUpperCase() : "";
  if (!/^[TRFC]\d+$/.test(ref)) refuse(`task "${slug!}" has no canonical ref`);
  const title =
    knownRefs(tasks, board).find((x) => x.slug === slug)?.title ?? String(task.title ?? slug);
  return { slug: slug!, ref, title, task };
}

function validateSection(path: string): ParsedSection {
  if (!existsSync(path)) refuse(`no section file at ${path}`);
  let parsed: ParsedSection;
  try {
    parsed = parseSection(readFileSync(path, "utf8"));
  } catch (e) {
    refuse((e as Error).message);
  }
  const missing: string[] = [];
  if (!parsed!.meta.verdict) missing.push("verdict (the table's verifier column)");
  if (!parsed!.meta.try) missing.push("try (the table's how to try column)");
  if (missing.length) refuse(`section front matter is missing ${missing.join(" and ")}`);
  if (!parsed!.body) refuse("section body must be non-empty");
  return parsed!;
}
function validateSurface(path: string, surface: string, desc?: string): string | null {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const known = parseSurfaces(text);
  if (known.has(surface)) return null;
  if (desc !== undefined && SURFACE_RE.test(surface) && desc.trim()) {
    return appendSurface(text, surface, desc);
  }
  refuse(
    `unknown surface "${surface}". Known surfaces: ${[...known.keys()].join(", ") || "(none)"}. Use --new-surface "<what it covers>" to add it.`,
  );
}

function sectionText(meta: Record<string, string>, body: string): string {
  const source = meta.source ? `source: ${meta.source}\n` : "";
  return `---\ntitle: ${meta.title ?? ""}\nverdict: ${meta.verdict ?? ""}\ntry: ${meta.try ?? ""}\n${source}---\n\n${body.trim()}\n`;
}
function archiveTrain(home: string, surface: string, name: string, exceptRef?: string): void {
  const dir = trainDir(home, surface);
  const archive = join(dir, "archive", name);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  for (const file of files) {
    if (file !== "train.json" && !file.endsWith(".md")) continue;
    if (exceptRef && file === `${exceptRef}.md`) continue;
    mkdirSync(archive, { recursive: true });
    renameSync(join(dir, file), join(archive, file));
  }
}

interface Rendered {
  refs: string[];
  rows: BodyRow[];
  unattributed: string[];
  body: string;
}
function statsFor(
  repo: string,
  commits: string[],
): { files: number; added: number; deleted: number } {
  const files = new Set<string>();
  let added = 0;
  let deleted = 0;
  for (const sha of commits) {
    const text = git(repo, "diff-tree", "--root", "--no-commit-id", "--numstat", "-r", sha);
    for (const line of text.split(/\r?\n/)) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!m) continue;
      files.add(m[3]!);
      if (m[1] !== "-") added += Number(m[1]);
      if (m[2] !== "-") deleted += Number(m[2]);
    }
  }
  return { files: files.size, added, deleted };
}
function buildRendered(
  repo: string,
  home: string,
  surface: string,
  openPr: Pull | null,
  ghRepo: string,
  tasks: string,
  board: string,
): Rendered {
  const records = git(
    repo,
    "log",
    "--reverse",
    "--format=%H%x1f%s",
    `origin/main..origin/train/${surface}`,
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split("\x1f");
      return { sha: sha!, subject: subject! };
    });
  const grouped = new Map<string, string[]>();
  const unattributed: string[] = [];
  for (const rec of records) {
    const ref = commitRef(rec.subject);
    if (!ref) {
      unattributed.push(rec.subject);
      continue;
    }
    if (!grouped.has(ref)) grouped.set(ref, []);
    grouped.get(ref)!.push(rec.sha);
  }
  let oldBody = "";
  if (openPr) {
    const view = parseJson<Pull>(
      gh(
        repo,
        "pr",
        "view",
        String(openPr.number),
        "--repo",
        ghRepo,
        "--json",
        "number,url,state,title,body,createdAt,mergeable,mergeStateStatus,statusCheckRollup,commits",
      ),
      openPr,
    );
    oldBody = String(view.body ?? openPr.body ?? "");
  }
  const oldSections = parseBodySections(oldBody);
  const oldTable = parseBodyTable(oldBody);
  const notesPath = join(trainDir(home, surface), "_notes.md");
  let notes = "";
  if (openPr) {
    notes = parseBodyNotes(oldBody);
    atomicWrite(notesPath, notes ? `${notes}\n` : "");
  } else if (existsSync(notesPath)) notes = readFileSync(notesPath, "utf8").trim();
  const rows: BodyRow[] = [];
  for (const [ref, commits] of grouped) {
    const path = join(trainDir(home, surface), `${ref}.md`);
    let stored: ParsedSection | null = null;
    if (existsSync(path)) {
      try {
        stored = parseSection(readFileSync(path, "utf8"));
      } catch {
        stored = null;
      }
    }
    if ((!stored || stored.meta.source === "imported") && oldSections.has(ref)) {
      const sec = oldSections.get(ref)!;
      const table = oldTable.get(ref);
      atomicWrite(
        path,
        sectionText(
          {
            title: sec.title,
            verdict: table?.verdict ?? "—",
            try: table?.try ?? "—",
            source: "imported",
          },
          sec.body,
        ),
      );
    }
    let parsed: ParsedSection | null = null;
    if (existsSync(path)) {
      try {
        parsed = parseSection(readFileSync(path, "utf8"));
      } catch {
        parsed = null;
      }
    }
    const fallbackTitle =
      oldSections.get(ref)?.title ??
      knownRefs(tasks, board).find((x) => x.ref === ref)?.title ??
      ref;
    const stat = statsFor(repo, commits);
    rows.push({
      ref,
      title: parsed?.meta.title || fallbackTitle,
      ...stat,
      verdict: parsed?.meta.verdict || "—",
      try: parsed?.meta.try || "—",
      body: parsed?.body || "_No section stored — the owner should re-run train.ts ship._",
    });
  }
  return {
    refs: [...grouped.keys()],
    rows,
    unattributed,
    body: renderBody(rows, unattributed, notes),
  };
}
function openPrFor(repo: string, r: string, surface: string): Pull | null {
  return prsForHead(repo, r, surface).find((p) => p.state.toUpperCase() === "OPEN") ?? null;
}
function bodyAndPr(
  repo: string,
  home: string,
  surface: string,
  r: string,
  createdAt: string,
  tasks: string,
  board: string,
): { url: string; number: number; rendered: Rendered } {
  const open = openPrFor(repo, r, surface);
  const rendered = buildRendered(repo, home, surface, open, r, tasks, board);
  const title = trainTitle(surface, rendered.refs);
  const temp = join(
    tmpdir(),
    `train-body-${process.pid}-${Math.random().toString(16).slice(2)}.md`,
  );
  writeFileSync(temp, rendered.body);
  try {
    if (open) {
      gh(
        repo,
        "pr",
        "edit",
        String(open.number),
        "--repo",
        r,
        "--title",
        title,
        "--body-file",
        temp,
      );
      return { url: open.url, number: open.number, rendered };
    }
    const url = gh(
      repo,
      "pr",
      "create",
      "--repo",
      r,
      "--base",
      "main",
      "--head",
      `train/${surface}`,
      "--title",
      title,
      "--body-file",
      temp,
    ).trim();
    const guessed = Number(/\/(\d+)\/?$/.exec(url)?.[1]);
    const view = parseJson<Pull>(
      gh(
        repo,
        "pr",
        "view",
        String(guessed),
        "--repo",
        r,
        "--json",
        "number,url,state,title,body,createdAt,mergeable,mergeStateStatus,statusCheckRollup,commits",
      ),
      { number: guessed, url, state: "OPEN", createdAt },
    );
    return { url: view.url || url, number: view.number, rendered };
  } finally {
    rmSync(temp, { force: true });
  }
}

function changedFiles(repo: string, from: string, to: string): Set<string> {
  if (from === to) return new Set();
  const r = gitMaybe(repo, "diff", "--name-only", from, to);
  return new Set((r.code ? "" : r.out).trim().split(/\r?\n/).filter(Boolean));
}
function ownerFiles(repo: string, commits: string[]): Set<string> {
  const out = new Set<string>();
  for (const sha of commits)
    for (const f of git(repo, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", sha)
      .split(/\r?\n/)
      .filter(Boolean))
      out.add(f);
  return out;
}
function stateMoved(p: Pending, s: TrainState): boolean {
  return p.fresh !== s.fresh || p.baseTip !== s.baseTip;
}
function movePendingBase(
  p: Pending,
  s: TrainState,
  home: string,
): { pending: Pending; overlap: string[] } {
  const beforeHead = git(p.worktree, "rev-parse", "HEAD");
  const commits = git(p.worktree, "rev-list", "--reverse", `${p.baseTip}..${beforeHead}`)
    .split(/\s+/)
    .filter(Boolean);
  const mine = ownerFiles(p.worktree, commits);
  let incoming: Set<string>;
  if (p.fresh !== s.fresh) {
    const base = git(p.worktree, "merge-base", p.baseTip, s.baseTip);
    incoming = changedFiles(p.worktree, base, s.baseTip);
  } else incoming = changedFiles(p.worktree, p.baseTip, s.baseTip);
  const head = rebuild(p.worktree, p.branch, s.baseTip, commits, p.ref, p.surface);
  const overlap = [...mine].filter((f) => incoming.has(f)).sort();
  const next = { ...p, baseTip: s.baseTip, head, fresh: s.fresh, stale: s.stale };
  if (overlap.length) {
    next.rebasedAt = new Date().toISOString();
    next.logPath = join(home, "evidence", p.ref, `train-reverify-${short(head)}.log`);
    mkdirSync(dirname(next.logPath), { recursive: true });
  }
  writeJson(pendingPath(home, p.surface, p.ref), next);
  return { pending: next, overlap };
}

function stamp(slug: string, tasks: string, board: string): void {
  const r = exec(["bun", kanbanPath(), "stamp", slug, "--tasks", tasks, "--board", board]);
  if (r.code) process.stderr.write(`warning: kanban stamp failed: ${(r.err || r.out).trim()}\n`);
}
function kanbanUpsert(ref: string, column: string, tasks: string, board: string): ProcResult {
  return exec([
    "bun",
    kanbanPath(),
    "upsert",
    ref,
    "--column",
    column,
    "--tasks",
    tasks,
    "--board",
    board,
  ]);
}

function moveShippedCard(slug: string, prUrl: string, tasks: string, board: string): number {
  const current = parseJson<Record<string, Record<string, unknown>>>(
    readFileSync(tasks, "utf8"),
    {},
  );
  const column = listRows(tasks, board).find((row) => row.slug === slug)?.column;
  if (current[slug]?.status === "shipped" && column === "Review") {
    stamp(slug, tasks, board);
    return 0;
  }

  let failure: { command: "stage" | "status" | "upsert"; result: ProcResult } | null = null;
  for (const command of ["stage", "status"] as const) {
    const result = exec([
      "bun",
      kanbanPath(),
      command,
      slug,
      "shipped",
      "--tasks",
      tasks,
      "--board",
      board,
    ]);
    if (result.code) {
      failure = { command, result };
      break;
    }
  }
  if (!failure) {
    const result = kanbanUpsert(slug, "Review", tasks, board);
    if (result.code) failure = { command: "upsert", result };
  }

  stamp(slug, tasks, board);
  if (!failure) return 0;

  const output = (failure.result.err || failure.result.out).trim();
  if (output) process.stderr.write(`${output}\n`);
  if (failure.command === "upsert") {
    process.stderr.write(
      `SHIPPED onto ${prUrl}, but the card could not move to Review. Fix the note, then run: kanban.ts upsert ${slug} --column Review\n`,
    );
  } else {
    process.stderr.write(
      `SHIPPED onto ${prUrl}, but the card could not move to Review. Fix the task, then run: kanban.ts ${failure.command} ${slug} shipped && kanban.ts upsert ${slug} --column Review\n`,
    );
  }
  return EXIT_SHIPPED_NOT_IN_REVIEW;
}

function ship(): number {
  const input = process.argv[3];
  const surface = argValue("--surface");
  const branch = argValue("--branch");
  const sectionArg = argValue("--section");

  if (!input || !surface || !branch || !sectionArg)
    refuse(
      "usage: train.ts ship <ref> --surface <key> --branch <owner-branch> --section <md> (--test-cmd <cmd> [--test-list <file>] | --test-list <file> | --verified <log>)",
      64,
    );
  const home = argValue("--home") ?? join(homedir(), ".claude/om-bug-loop");
  const tasks = argValue("--tasks") ?? DEFAULT_TASKS;
  const board = argValue("--board") ?? DEFAULT_BOARD;
  const surfaces = argValue("--surfaces") ?? DEFAULT_SURFACES;
  const repo = resolve(argValue("--repo") ?? process.cwd());
  const now = argValue("--now") ?? new Date().toISOString();
  const verified = argValue("--verified");
  const testCmd = argValue("--test-cmd");
  const testListIndex = process.argv.indexOf("--test-list");
  const testList = testListIndex >= 0 ? process.argv[testListIndex + 1] : undefined;

  const surfaceUpdate = validateSurface(surfaces, surface, argValue("--new-surface"));
  const parsed = validateSection(sectionArg);
  const id = taskIdentity(input, tasks, board);

  let preparedTestCmd = testCmd;
  let testFiles: string[] | undefined;
  if (!verified) {
    if (!testCmd && testListIndex < 0)
      refuse(
        "the first ship call requires (--test-cmd <cmd> [--test-list <file>] | --test-list <file> | --verified <log>)",
        64,
      );
    if (testListIndex >= 0) {
      if (!testList || testList.startsWith("--")) refuse("--test-list requires a file", 64);
      if (!existsSync(testList) || !statSync(testList).isFile())
        refuse(`test list does not exist or is not a regular file: ${testList}`, 64);
      const parsedList = parseTestList(readFileSync(testList, "utf8"));
      for (const line of parsedList.dropped)
        process.stderr.write(`dropped from test list: ${line}\n`);
      testFiles = [
        ...new Set(parsedList.files.map((file) => normalizeTestPath(file, repo))),
      ];
      preparedTestCmd = buildTestCommand(testCmd ?? "bun test", testFiles);
      const missing = testFiles.filter((file) => {
        const path = resolve(repo, file);
        try {
          return !statSync(path).isFile();
        } catch {
          return true;
        }
      });
      if (missing.length)
        refuse(`test list names missing or non-file paths: ${missing.join(", ")}`, 64);
    } else assertCommandSafe(testCmd!);
  }
  if (git(repo, "status", "--porcelain", "--untracked-files=no"))
    refuse("refusing to ship a dirty tracked worktree (never stash it)");
  const checked = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
  if (checked !== branch)
    refuse(`--branch ${branch} is not checked out in ${repo} (found ${checked})`);
  if (id.task.train && id.task.train !== surface)
    refuse(`${id.ref} is already on train/${id.task.train}; drop it first`);
  const sectionPath = resolve(sectionArg);
  const wait = Number(argValue("--lock-wait") ?? 300);
  const r = repoName(repo);
  refuseOtherRepo(home, surface, r);
  if (surfaceUpdate !== null) atomicWrite(surfaces, surfaceUpdate);

  return withSurfaceLock(
    home,
    surface,
    id.ref,
    () => {
      git(repo, "fetch", "origin", "--prune");

      if (!verified) {
        const state = resolveTrainState(repo, r, surface);
        const commits = rangeCommits(
          repo,
          state.continuing ? `origin/train/${surface}` : "origin/main",
          branch,
        );
        if (!commits.length) refuse("nothing new to ship");
        for (const sha of commits) {
          const own = leadingRef(commitInfo(repo, sha).subject);
          if (own && own !== id.ref)
            refuse(
              `commit ${short(sha)} carries different ref ${own}: ${commitInfo(repo, sha).subject}`,
            );
        }
        const head = rebuild(repo, branch, state.baseTip, commits, id.ref, surface);
        const logPath = join(home, "evidence", id.ref, `train-reverify-${short(head)}.log`);
        mkdirSync(dirname(logPath), { recursive: true });
        const pending: Pending = {
          ref: id.ref,
          slug: id.slug,
          surface,
          repo: r,
          worktree: repo,
          branch,
          baseTip: state.baseTip,
          head,
          ownerCommits: commits.length,
          fresh: state.fresh,
          stale: state.stale,
          testCmd: preparedTestCmd!,
          ...(testFiles === undefined ? {} : { testFiles }),
          rebasedAt: now,
          logPath,
        };
        writeJson(pendingPath(home, surface, id.ref), pending);
        const otherCommits = Number(
          git(repo, "rev-list", "--count", `origin/main..${state.baseTip}`),
        );
        process.stdout.write(
          `${reverifyText(pending, refsAt(repo, state.baseTip), otherCommits, sectionPath)}\n`,
        );
        return 3;
      }

      const pp = pendingPath(home, surface, id.ref);
      if (!existsSync(pp)) refuse(`no pending rebase for ${id.ref}; run the first ship call`);
      let pending = parseJson<Pending>(readFileSync(pp, "utf8"), null as never);
      const head = git(repo, "rev-parse", "HEAD");
      if (head !== pending.head)
        refuse("the branch changed since the rebase — run the first ship call again");
      if (!existsSync(verified)) refuse(`verified log does not exist: ${verified}`);
      if (statSync(verified).size === 0) refuse(`verified log is empty: ${verified}`);
      if (statSync(verified).mtimeMs < new Date(pending.rebasedAt).getTime())
        refuse(`verified log is older than the rebase: ${verified}`);

      assertCommandSafe(pending.testCmd);
      const isBunTest = /(^|[\s;&|(])bun\s+test\b/.test(pending.testCmd);
      if (isBunTest || pending.testFiles !== undefined) {
        const summaries = parseBunSummary(readFileSync(verified, "utf8"));
        if (summaries.length === 0)
          refuse(
            "no bun test summary line in the verified log — the log is not the output of the printed command",
          );
        if (summaries.length > 1)
          refuse("more than one bun run in the log — ambiguous");
        const summary = summaries[0]!;
        if (summary.files === 0 || summary.tests === 0)
          refuse(
            `bun test summary reports zero tests or files (${summary.tests} tests across ${summary.files} files)`,
          );
        if (pending.testFiles !== undefined) {
          const pendingHead = git(pending.worktree, "rev-parse", "HEAD");
          if (pendingHead !== pending.head)
            refuse("the pending worktree changed since the rebase — run the first ship call again");
          const distinct = [
            ...new Set(
              pending.testFiles.map((file) => normalizeTestPath(file, pending.worktree)),
            ),
          ];
          const missing = distinct.filter((file) => {
            try {
              return !statSync(resolve(pending.worktree, file)).isFile();
            } catch {
              return true;
            }
          });
          if (missing.length)
            refuse(`listed test file no longer exists at the pinned HEAD: ${missing.join(", ")}`);
          const lower = distinct.length;
          if (summary.files < lower)
            refuse(
              `log ran ${summary.files} files but the list names ${lower} existing test files`,
            );
          const listed = git(
            pending.worktree,
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude=node_modules",
          )
            .split("\0")
            .filter(Boolean);
          // git ls-files emits repo-relative paths without "./"; normalise first or F49 matches nothing.
          const needles = distinct.map((file) => file.toLowerCase());
          // Exact equality is impossible: Bun treats positional args as substring path
          // filters, so one entry can match several files (F64's test/your-library.test.tsx
          // also matched apps/cloud/test/your-library.test.tsx; 18 entries ran 26 files),
          // while its default reporter does not print a line per file that ran.
          const upper = listed.filter(
            (file) =>
              BUN_TEST_FILE.test(file) &&
              !/(^|\/)node_modules\//.test(file) &&
              needles.some((needle) => file.toLowerCase().includes(needle)),
          ).length;
          if (summary.files > upper)
            refuse(
              `log ran ${summary.files} files but the list can match at most ${upper} — it ran more than the scoped set (a truncated/commented filter runs the whole suite)`,
            );
        }
      }

      let finalState: TrainState | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        git(repo, "fetch", "origin", "--prune");
        let state = resolveTrainState(repo, r, surface);
        if (stateMoved(pending, state)) {
          const oldBase = pending.baseTip;
          const moved = movePendingBase(pending, state, home);
          pending = moved.pending;
          if (moved.overlap.length) {
            const otherCommits = Number(
              git(repo, "rev-list", "--count", `origin/main..${state.baseTip}`),
            );
            process.stdout.write(
              `${reverifyText(pending, refsAt(repo, state.baseTip), otherCommits, sectionPath, moved.overlap)}\n`,
            );
            return 3;
          }
          const n = git(repo, "rev-list", "--count", `${oldBase}..${state.baseTip}`);
          process.stdout.write(
            `train base moved by ${n} commit(s), touching none of this fix's files; continuing.\n`,
          );
        }
        finalState = state;
        if (state.fresh && state.remoteTip) {
          if (state.stale?.pr?.state.toUpperCase() === "CLOSED") {
            git(
              repo,
              "push",
              "origin",
              `${state.remoteTip}:refs/heads/train-closed/${surface}-${state.stale.pr.number}`,
            );
          }
          // A lease-guarded delete is safe only for a finished train; routine
          // appends never force and drop is the sole other force-push path.
          const del = gitMaybe(
            repo,
            "push",
            `--force-with-lease=refs/heads/train/${surface}:${state.remoteTip}`,
            "origin",
            `:refs/heads/train/${surface}`,
          );
          if (del.code) refuse((del.err || del.out).trim());
          archiveTrain(
            home,
            surface,
            String(state.stale?.pr?.number ?? now.replace(/[:.]/g, "-")),
            id.ref,
          );
          git(repo, "fetch", "origin", "--prune");
        }
        const push = gitMaybe(repo, "push", "origin", `${branch}:refs/heads/train/${surface}`);
        if (push.code === 0) break;
        if (/non-fast-forward|fetch first|rejected/i.test(push.err + push.out)) {
          if (attempt === 3) refuse("the train is moving too fast; retry ship");
          continue;
        }
        refuse((push.err || push.out).trim());
      }

      git(repo, "fetch", "origin", "--prune");
      const dest = join(trainDir(home, surface), `${id.ref}.md`);
      atomicWrite(dest, readFileSync(sectionArg, "utf8"));
      const oldTrainPath = join(trainDir(home, surface), "train.json");
      const oldTrain = existsSync(oldTrainPath)
        ? parseJson<any>(readFileSync(oldTrainPath, "utf8"), {})
        : {};
      const provisionalRefs = Array.isArray(oldTrain.refs) ? [...oldTrain.refs] : [];
      if (!provisionalRefs.includes(id.ref)) provisionalRefs.push(id.ref);
      writeJson(oldTrainPath, {
        surface,
        repo: r,
        pr: oldTrain.pr ?? null,
        refs: provisionalRefs,
        createdAt: oldTrain.createdAt ?? now,
        updatedAt: now,
      });
      const pr = bodyAndPr(repo, home, surface, r, now, tasks, board);
      writeJson(oldTrainPath, {
        surface,
        repo: r,
        pr: { number: pr.number, url: pr.url },
        refs: pr.rendered.refs,
        createdAt: oldTrain.createdAt ?? now,
        updatedAt: now,
      });
      writeTaskFields(tasks, id.slug, { mrUrl: pr.url, train: surface });
      rmSync(pp, { force: true });
      const reviewResult = moveShippedCard(id.slug, pr.url, tasks, board);
      process.stdout.write(
        `${id.ref} shipped on train/${surface} → ${pr.url} (${pr.rendered.refs.length} fixes: ${pr.rendered.refs.join(", ")})\n`,
      );
      return reviewResult;
    },
    wait,
    now,
  );
}

function allPrs(repo: string, r: string, state: "open" | "merged"): Pull[] {
  return parseJson<Pull[]>(
    gh(
      repo,
      "pr",
      "list",
      "--repo",
      r,
      "--state",
      state,
      "--json",
      "number,url,state,title,headRefName,createdAt,mergeable,mergeStateStatus,statusCheckRollup",
      "--limit",
      "200",
    ),
    [],
  ).filter((p) => p.headRefName?.startsWith("train/"));
}
function prView(repo: string, r: string, n: number): Pull {
  return parseJson<Pull>(
    gh(
      repo,
      "pr",
      "view",
      String(n),
      "--repo",
      r,
      "--json",
      "number,url,state,title,body,createdAt,mergeable,mergeStateStatus,statusCheckRollup,commits",
    ),
    null as never,
  );
}
function prRefs(p: Pull): string[] {
  const commits = Array.isArray(p.commits) ? (p.commits as Array<Record<string, unknown>>) : [];
  const refs: string[] = [];
  const add = (ref: string | null) => {
    if (ref && !refs.includes(ref)) refs.push(ref);
  };
  for (const ref of parseBodyTable(String(p.body ?? "")).keys()) add(ref);
  for (const ref of parseBodySections(String(p.body ?? "")).keys()) add(ref);
  for (const commit of commits) add(commitRef(String(commit.messageHeadline ?? "")));
  return refs;
}

function drop(): number {
  const input = process.argv[3];
  if (!input) refuse("usage: train.ts drop <ref> [--surface <key>]", 64);

  const home = argValue("--home") ?? join(homedir(), ".claude/om-bug-loop");
  const tasks = argValue("--tasks") ?? DEFAULT_TASKS;
  const board = argValue("--board") ?? DEFAULT_BOARD;
  const repo = resolve(argValue("--repo") ?? DEFAULT_REPO);
  const now = argValue("--now") ?? new Date().toISOString();
  const id = taskIdentity(input, tasks, board);
  const surface =
    argValue("--surface") ?? (typeof id.task.train === "string" ? id.task.train : undefined);
  if (!surface) refuse(`${id.ref} has no train; pass --surface <key>`);
  const wait = Number(argValue("--lock-wait") ?? 300);
  const r = repoName(repo);
  refuseOtherRepo(home, surface, r);

  return withSurfaceLock(
    home,
    surface,
    id.ref,
    () => {
      git(repo, "fetch", "origin", "--prune");
      const open = openPrFor(repo, r, surface);
      const oldTip = remoteSha(repo, surface);
      if (!oldTip || !open) refuse(`train/${surface} has no remote branch and OPEN PR`);

      const base = git(repo, "merge-base", "origin/main", oldTip);
      const commits = git(repo, "rev-list", "--reverse", "--no-merges", `${base}..${oldTip}`)
        .split(/\s+/)
        .filter(Boolean);
      const removed = commits.filter(
        (sha) => commitRef(commitInfo(repo, sha).subject) === id.ref,
      );
      if (!removed.length) refuse(`${id.ref} has no commits on train/${surface}`);
      const keep = commits.filter(
        (sha) => commitRef(commitInfo(repo, sha).subject) !== id.ref,
      );
      const parent = mkdtempSync(join(tmpdir(), "train-drop-"));
      const wt = join(parent, "worktree");
      let added = false;

      try {
        git(repo, "worktree", "add", "--detach", wt, base);
        added = true;
        for (const sha of keep) {
          const pick = gitCommitMaybe(wt, "cherry-pick", sha);
          if (pick.code) {
            const files = gitMaybe(wt, "diff", "--name-only", "--diff-filter=U")
              .out.trim()
              .split(/\r?\n/)
              .filter(Boolean);
            gitMaybe(wt, "cherry-pick", "--abort");
            refuse(
              `drop conflict at ${short(sha)} in: ${files.join(", ") || "(unknown paths)"}`,
              4,
            );
          }
        }
        // Removing one ref rewrites history by definition; the exact old tip in
        // the lease prevents this routine force push from erasing a concurrent append.
        const push = gitMaybe(
          wt,
          "push",
          `--force-with-lease=refs/heads/train/${surface}:${oldTip}`,
          "origin",
          `HEAD:refs/heads/train/${surface}`,
        );
        if (push.code) refuse(`the train moved; re-run drop\n${(push.err || push.out).trim()}`);
      } finally {
        if (added) gitMaybe(repo, "worktree", "remove", "--force", wt);
        rmSync(parent, { recursive: true, force: true });
      }

      git(repo, "fetch", "origin", "--prune");
      const dir = trainDir(home, surface);
      const sec = join(dir, `${id.ref}.md`);
      if (existsSync(sec)) {
        mkdirSync(join(dir, "archive"), { recursive: true });
        renameSync(sec, join(dir, "archive", `dropped-${id.ref}-${now.replace(/[:.]/g, "-")}.md`));
      }
      const trainPath = join(dir, "train.json");
      const state = existsSync(trainPath)
        ? parseJson<any>(readFileSync(trainPath, "utf8"), {})
        : { surface, repo: r, refs: [] };
      state.refs = (Array.isArray(state.refs) ? state.refs : []).filter(
        (x: string) => x !== id.ref,
      );
      state.updatedAt = now;

      if (keep.length) {
        const edited = bodyAndPr(repo, home, surface, r, now, tasks, board);
        state.refs = edited.rendered.refs;
        state.pr = { number: edited.number, url: edited.url };
      } else {
        gh(
          repo,
          "pr",
          "close",
          String(open.number),
          "--repo",
          r,
          "--comment",
          `Emptied by train.ts drop ${id.ref}.`,
        );
        state.pr = null;
      }
      writeJson(trainPath, state);
      writeTaskFields(tasks, id.slug, { mrUrl: null, train: undefined });

      const moved = kanbanUpsert(id.ref, "Need Attention", tasks, board);
      if (moved.code) {
        process.stderr.write((moved.err || moved.out).trim() + "\n");
        return 1;
      }
      process.stdout.write(
        `${id.ref} dropped from train/${surface}: ${removed.length} commit(s) ${removed.map(short).join(", ")}. Its own branch still holds its commits.\n`,
      );
      return 0;
    },
    wait,
    now,
  );
}

function landedNumbers(home: string, surface: string): number[] {
  const p = join(trainDir(home, surface), "landed.json");
  return existsSync(p) ? parseJson<number[]>(readFileSync(p, "utf8"), []) : [];
}
function status(): number {
  const home = argValue("--home") ?? join(homedir(), ".claude/om-bug-loop");
  const repo = resolve(argValue("--repo") ?? DEFAULT_REPO);
  const now = new Date(argValue("--now") ?? new Date().toISOString()).getTime();
  const r = argValue("--gh-repo") ?? repoName(repo);
  const open = allPrs(repo, r, "open").sort((a, b) => a.headRefName!.localeCompare(b.headRefName!));

  if (!open.length) process.stdout.write("no open trains\n");
  for (const listed of open) {
    const p = prView(repo, r, listed.number);
    const surface = listed.headRefName!.slice(6);
    process.stdout.write(
      `${surface}  #${p.number}  ${humanDuration(now - new Date(p.createdAt).getTime())}  ${p.mergeable}/${p.mergeStateStatus}  CI ${ciSummary(p.statusCheckRollup)}  ${prRefs(p).join(", ") || "—"}  ${p.url}\n`,
    );
  }

  for (const p of allPrs(repo, r, "merged")) {
    const surface = p.headRefName!.slice(6);
    if (!landedNumbers(home, surface).includes(p.number))
      process.stdout.write(
        `merged, not landed: ${surface} #${p.number} — run: bun train.ts landed\n`,
      );
  }
  return 0;
}

const TERMINAL = new Set(["shipped", "researched", "swept", "withdrawn", "skipped", "failed"]);
function landed(): number {
  const home = argValue("--home") ?? join(homedir(), ".claude/om-bug-loop");
  const tasks = argValue("--tasks") ?? DEFAULT_TASKS;
  const board = argValue("--board") ?? DEFAULT_BOARD;
  const repo = resolve(argValue("--repo") ?? DEFAULT_REPO);
  const now = argValue("--now") ?? new Date().toISOString();
  const r = argValue("--gh-repo") ?? repoName(repo);
  let failed = 0;

  for (const listed of allPrs(repo, r, "merged").sort((a, b) => a.number - b.number)) {
    const surface = listed.headRefName!.slice(6);
    if (landedNumbers(home, surface).includes(listed.number)) continue;
    withSurfaceLock(
      home,
      surface,
      `PR#${listed.number}`,
      () => {
        const p = prView(repo, r, listed.number);
        const refs = prRefs(p);
        let moved = 0;
        let errors = 0;
        for (const ref of refs) {
          const entry = knownRefs(tasks, board).find((x) => x.ref === ref);
          if (!entry) {
            process.stdout.write(`${ref} skipped: not known to this task ledger\n`);
            continue;
          }
          const result = kanbanUpsert(ref, "Done", tasks, board);
          if (result.code) {
            process.stderr.write(`${ref}: ${(result.err || result.out).trim()}\n`);
            errors++;
            failed++;
            continue;
          }
          const all = parseJson<Record<string, Record<string, unknown>>>(
            readFileSync(tasks, "utf8"),
            {},
          );
          const task = all[entry.slug];
          if (task && !TERMINAL.has(String(task.status ?? "")))
            writeTaskFields(tasks, entry.slug, { status: "shipped" });
          process.stdout.write(`${ref} → Done\n`);
          moved++;
        }
        const numbers = landedNumbers(home, surface);
        if (!numbers.includes(p.number)) numbers.push(p.number);
        writeJson(join(trainDir(home, surface), "landed.json"), numbers);
        const trainPath = join(trainDir(home, surface), "train.json");
        if (existsSync(trainPath)) {
          const state = parseJson<any>(readFileSync(trainPath, "utf8"), {});
          if (state.pr?.number === p.number) archiveTrain(home, surface, String(p.number));
        }
        process.stdout.write(`train/${surface} #${p.number}: ${moved} moved, ${errors} failed\n`);
      },
      Number(argValue("--lock-wait") ?? 300),
      now,
    );
  }
  return failed ? 1 : 0;
}

export function main(): number {
  try {
    const command = process.argv[2];
    if (command === "ship") return ship();
    if (command === "drop") return drop();
    if (command === "status") return status();
    if (command === "landed") return landed();
    refuse("usage: train.ts <ship|drop|status|landed> ...", 64);
  } catch (e) {
    if (e instanceof Stop) {
      process.stderr.write(`${e.message}\n`);
      return e.code;
    }
    process.stderr.write(`${(e as Error).stack ?? String(e)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(main());
