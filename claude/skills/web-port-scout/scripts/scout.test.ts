import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCOUT = join(import.meta.dir, "scout.ts");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function sh(cwd: string, ...cmd: string[]) {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

/** A bare `origin` with a `production` branch, and a clone of it as the "web repo". */
function fixture() {
  const d = mkdtempSync(join(tmpdir(), "wps-repo-")); dirs.push(d);
  const origin = join(d, "origin.git"), work = join(d, "work"), repo = join(d, "repo");
  sh(d, "git", "init", "-q", "--bare", origin);
  sh(d, "git", "clone", "-q", origin, work);
  sh(work, "git", "checkout", "-q", "-b", "production");
  const commit = (file: string, msg: string) => {
    writeFileSync(join(work, file.replaceAll("/", "_")), msg);
    sh(work, "git", "add", "-A"); sh(work, "git", "commit", "-q", "-m", msg);
    sh(work, "git", "push", "-q", "origin", "production");
    return sh(work, "git", "rev-parse", "HEAD");
  };
  const first = commit("a", "fix(chart): first");
  sh(d, "git", "clone", "-q", "-b", "production", origin, repo);
  return { d, work, repo, cursor: join(d, "cursor"), commit, first };
}

function scout(repo: string, cursor: string, ...args: string[]) {
  // An empty skip list: these tests pin the CLI, not the live list (Task 5).
  const r = Bun.spawnSync(["bun", SCOUT, ...args, "--repo", repo, "--cursor", cursor, "--skip", "/dev/null"]);
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() };
}

describe("gate", () => {
  test("no cursor → NOCURSOR; init sets it; then SAME; a push → NEW", () => {
    const f = fixture();
    expect(scout(f.repo, f.cursor, "gate")).toMatchObject({ code: 11, out: `NOCURSOR ${f.first}` });
    expect(scout(f.repo, f.cursor, "init").out).toBe(`cursor ${f.first}`);
    expect(scout(f.repo, f.cursor, "gate")).toMatchObject({ code: 0, out: `SAME ${f.first}` });
    const second = f.commit("b", "feat(heatmap): second");
    expect(scout(f.repo, f.cursor, "gate")).toMatchObject({ code: 10, out: `NEW ${second}` });
  });
  test("init leaves an existing cursor alone", () => {
    const f = fixture();
    writeFileSync(f.cursor, "keepme\n");
    scout(f.repo, f.cursor, "init");
    expect(readFileSync(f.cursor, "utf8")).toBe("keepme\n");
  });
});

describe("units", () => {
  test("groups cursor..tip and reports the range", () => {
    const f = fixture();
    scout(f.repo, f.cursor, "init");
    f.commit("b", "fix(heatmap): one");
    const tip = f.commit("c", "fix(heatmap): two");
    const r = scout(f.repo, f.cursor, "units");
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out);
    expect(json.from).toBe(f.first);
    expect(json.to).toBe(tip);
    expect(json.units.length).toBe(1);
    expect(json.units[0].shas.length).toBe(2);
  });
  test("REVIEW FOCUS 1: a cursor that is not an ancestor refuses, exit 2", () => {
    const f = fixture();
    writeFileSync(f.cursor, "0123456789012345678901234567890123456789\n");
    f.commit("b", "fix(x): y");
    const r = scout(f.repo, f.cursor, "units");
    expect(r.code).toBe(2);
    expect(r.err).toContain("not an ancestor");
  });
  test("REVIEW FOCUS 2: an empty range is an empty list, exit 0", () => {
    const f = fixture();
    scout(f.repo, f.cursor, "init");
    const r = scout(f.repo, f.cursor, "units");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).units).toEqual([]);
  });
});

describe("advance, cites, log", () => {
  test("advance writes the cursor", () => {
    const f = fixture();
    expect(scout(f.repo, f.cursor, "advance", f.first).out).toBe(`cursor ${f.first}`);
    expect(readFileSync(f.cursor, "utf8")).toBe(`${f.first}\n`);
  });
  test("REVIEW FIX 4: advance resolves a short sha to the full one", () => {
    const f = fixture();
    expect(scout(f.repo, f.cursor, "advance", f.first.slice(0, 10)).out).toBe(`cursor ${f.first}`);
    expect(readFileSync(f.cursor, "utf8")).toBe(`${f.first}\n`);
  });
  test("REVIEW FIX 4: advance refuses a sha that is not on production", () => {
    const f = fixture();
    writeFileSync(f.cursor, `${f.first}\n`);
    const r = scout(f.repo, f.cursor, "advance", "0123456789012345678901234567890123456789");
    expect(r.code).toBe(2);
    expect(readFileSync(f.cursor, "utf8")).toBe(`${f.first}\n`);
  });
  test("cites prints every citing card", () => {
    const f = fixture();
    const cards = join(f.d, "cards");
    mkdirSync(cards, { recursive: true });
    writeFileSync(join(cards, "x.md"), `web ${f.first.slice(0, 10)}`);
    writeFileSync(join(cards, "y.md"), `web ${f.first.slice(0, 10)} part two`);
    const r = scout(f.repo, f.cursor, "cites", f.first, "--cards", cards);
    expect(r.out.split("\n").sort()).toEqual([`${f.first.slice(0, 10)} x.md`, `${f.first.slice(0, 10)} y.md`]);
  });
  test("cites prints hits only", () => {
    const f = fixture();
    const cards = join(f.d, "cards");
    mkdirSync(cards, { recursive: true });
    writeFileSync(join(cards, "x.md"), `web ${f.first.slice(0, 10)}`);
    const r = scout(f.repo, f.cursor, "cites", f.first, "f".repeat(40), "--cards", cards);
    expect(r.out).toBe(`${f.first.slice(0, 10)} x.md`);
  });
  test("log creates the file with a heading, then appends", () => {
    const f = fixture();
    const log = join(f.d, "log.md"), entries = join(f.d, "e.json");
    writeFileSync(entries, JSON.stringify([{ unit: "u@1", verdict: "none", reason: "no units" }]));
    scout(f.repo, f.cursor, "log", "--entries", entries, "--range", "a..b", "--log", log);
    scout(f.repo, f.cursor, "log", "--entries", entries, "--range", "b..c", "--log", log);
    const text = readFileSync(log, "utf8");
    expect(text.startsWith("# web-port-scout run log\n")).toBe(true);
    expect(text.match(/^## /gm)!.length).toBe(2);
  });
});
