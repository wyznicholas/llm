import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOG_FORMAT, cites, formatLog, groupUnits, parseLog, parseSkipAreas, prefilter,
  readCursor, scopeOf, writeCursor, citesAll, type Commit,
} from "./lib";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "wps-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const c = (sha: string, date: string, subject: string, files: string[] = ["src/a.ts"]): Commit =>
  ({ sha: sha.padEnd(40, "0"), author: "dev", date, subject, files });

describe("parseLog", () => {
  test("reads the record/unit-separated format with file lists", () => {
    expect(LOG_FORMAT).toContain("%H");
    const text = "\x1eaaa\x1fAnn\x1f2026-10-07T10:00:00+08:00\x1ffix(chart): x\n\nsrc/a.ts\nsrc/b.ts\n" +
      "\x1ebbb\x1fBo\x1f2026-10-07T11:00:00+08:00\x1fchore: empty\n";
    expect(parseLog(text)).toEqual([
      { sha: "aaa", author: "Ann", date: "2026-10-07T10:00:00+08:00", subject: "fix(chart): x", files: ["src/a.ts", "src/b.ts"] },
      { sha: "bbb", author: "Bo", date: "2026-10-07T11:00:00+08:00", subject: "chore: empty", files: [] },
    ]);
  });
});

describe("scopeOf", () => {
  test("conventional subjects give type and scope; a bare type is its own scope", () => {
    expect(scopeOf("fix(wrun): a thing")).toEqual({ type: "fix", scope: "wrun" });
    expect(scopeOf("feat!: breaking")).toEqual({ type: "feat", scope: "feat" });
  });
  test("a production bundle subject is not conventional", () => {
    expect(scopeOf("production: Book Heat perf, Sensitivity slider")).toBeNull();
    expect(scopeOf("Merge branch 'x'")).toBeNull();
  });
});

describe("parseSkipAreas", () => {
  test("only exact list lines count", () => {
    expect(parseSkipAreas("# Skip\n\nprose `not/this/**`\n- `docs/**` — web docs\n- `tests/**` — tests\n"))
      .toEqual(["docs/**", "tests/**"]);
  });
});

describe("prefilter", () => {
  const globs = ["docs/**", "tests/**"];
  test("every file on the skip list → skip", () => {
    expect(prefilter({ subjects: ["docs: x"], files: ["docs/a.md", "tests/b.ts"] }, globs)).toBe("skip");
  });
  test("one product file → judge", () => {
    expect(prefilter({ subjects: ["fix: x"], files: ["docs/a.md", "src/a.ts"] }, globs)).toBe("judge");
  });
  test("REVIEW FOCUS 3: no files → judge, never a vacuous skip", () => {
    expect(prefilter({ subjects: ["chore: empty"], files: [] }, globs)).toBe("judge");
  });
  test("orangecharts bumps → dep-bump; a mixed deps unit → judge", () => {
    expect(prefilter({ subjects: ["chore(deps): bump @orangecharts/indicator-kit to 0.62.1"], files: ["package.json"] }, globs)).toBe("dep-bump");
    expect(prefilter({ subjects: ["chore(deps): bump @orangecharts/indicator-kit to 0.62.1", "chore(deps): bump vite to 6"], files: ["package.json"] }, globs)).toBe("judge");
  });
});

describe("groupUnits", () => {
  test("same scope within the window is one unit; outside it, a new one", () => {
    const units = groupUnits([
      c("a1", "2026-10-06T10:00:00Z", "fix(wrun): one"),
      c("a2", "2026-10-06T12:00:00Z", "feat(wrun): two", ["src/b.ts"]),
      c("a3", "2026-10-07T12:00:00Z", "fix(wrun): three"),
    ], []);
    expect(units.map(u => u.shas.length)).toEqual([2, 1]);
    expect(units[0]!.types).toEqual(["fix", "feat"]);
    expect(units[0]!.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(units[0]!.id).toBe(`wrun@${"a1".padEnd(10, "0")}`);
  });
  test("REVIEW FOCUS 4: a non-conventional commit is always its own unit", () => {
    const units = groupUnits([
      c("b1", "2026-10-05T06:00:00Z", "production: Book Heat perf, Sensitivity slider"),
      c("b2", "2026-10-05T06:01:00Z", "production: more picks"),
    ], []);
    expect(units.length).toBe(2);
    expect(units[0]!.scope).toBe("misc");
  });
  test("each unit carries its prefilter", () => {
    const units = groupUnits([c("d1", "2026-10-06T10:00:00Z", "docs(x): y", ["docs/a.md"])], ["docs/**"]);
    expect(units[0]!.prefilter).toBe("skip");
  });
});

describe("cites", () => {
  test("REVIEW FOCUS 5: a card quoting the 10-char prefix is found from the full SHA", () => {
    const d = tmp();
    writeFileSync(join(d, "port-sensitivity-bar.md"), "## Evidence\n\n- web 3c227b8058 production: …\n");
    writeFileSync(join(d, "other.md"), "nothing here");
    expect(cites(d, "3c227b8058ffffffffffffffffffffffffffffff")).toBe("port-sensitivity-bar.md");
    expect(cites(d, "deadbeef00ffffffffffffffffffffffffffffff")).toBeNull();
  });
  test("REVIEW FIX 1: citesAll returns every citing card, so a bundle filed per part is checked part by part", () => {
    const d = tmp();
    writeFileSync(join(d, "part-a.md"), "web 3c227b8058 part: Book Heat perf");
    writeFileSync(join(d, "part-b.md"), "web 3c227b8058 part: live book rows");
    writeFileSync(join(d, "other.md"), "nothing");
    expect(citesAll(d, "3c227b8058ffffffffffffffffffffffffffffff").sort()).toEqual(["part-a.md", "part-b.md"]);
    expect(citesAll(join(d, "nope"), "3c227b8058")).toEqual([]);
  });
  test("a missing cards dir is no hit, not a crash", () => {
    expect(cites(join(tmp(), "nope"), "3c227b8058")).toBeNull();
  });
});

describe("cursor", () => {
  test("round-trips, trims, and is null when absent", () => {
    const p = join(tmp(), "sub", "cursor");
    expect(readCursor(p)).toBeNull();
    writeCursor(p, "abc123");
    expect(readFileSync(p, "utf8")).toBe("abc123\n");
    expect(readCursor(p)).toBe("abc123");
  });
});

describe("formatLog", () => {
  test("one heading per run, one line per unit", () => {
    expect(formatLog("2026-10-08 16:00", "aaaaaaaaaa..bbbbbbbbbb", [
      { unit: "wrun@a1", verdict: "skip", reason: "script editor only" },
      { unit: "heatmap@b2", verdict: "port-existing", reason: "orderbook-heatmap page", card: "port-heatmap-x" },
    ])).toBe(
      "\n## 2026-10-08 16:00 · aaaaaaaaaa..bbbbbbbbbb\n\n" +
      "- `wrun@a1` **skip**: script editor only\n" +
      "- `heatmap@b2` **port-existing**: orderbook-heatmap page → [[kanban/cards/port-heatmap-x|port-heatmap-x]]\n");
  });
});
