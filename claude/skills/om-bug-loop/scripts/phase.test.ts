import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMark, human, readMarks, render, spans } from "./phase.ts";

const dir = () => mkdtempSync(join(tmpdir(), "phase-"));

describe("phase", () => {
  test("marks round-trip through jsonl", () => {
    const d = dir();
    addMark(d, "setup", "2026-09-08T10:00:00.000Z");
    addMark(d, "suite", "2026-09-08T10:05:00.000Z");
    expect(readMarks(d).map(m => m.label)).toEqual(["setup", "suite"]);
  });

  // Checkpoints, not start/end pairs: a retry inside a phase cannot orphan an
  // "end" that never fires, which is how hand-kept timing accounts drift.
  test("a phase runs to the NEXT mark", () => {
    const d = dir();
    addMark(d, "setup", "2026-09-08T10:00:00.000Z");
    addMark(d, "suite", "2026-09-08T10:05:00.000Z");
    addMark(d, "done", "2026-09-08T10:06:00.000Z");
    const s = spans(readMarks(d));
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ label: "setup", ms: 300_000 });
    expect(s[1]).toMatchObject({ label: "suite", ms: 60_000 });
  });

  test("a single mark yields no span", () => {
    const d = dir();
    addMark(d, "setup", "2026-09-08T10:00:00.000Z");
    expect(spans(readMarks(d))).toHaveLength(0);
  });

  test("render shows shares that sum to the total", () => {
    const d = dir();
    addMark(d, "setup", "2026-09-08T10:00:00.000Z");
    addMark(d, "verify", "2026-09-08T10:10:00.000Z");
    addMark(d, "done", "2026-09-08T10:20:00.000Z");
    const out = render(readMarks(d));
    expect(out).toContain("50%");
    expect(out).toContain("TOTAL");
    expect(out).toContain("20m00s");
  });

  test("markdown mode emits a table", () => {
    const d = dir();
    addMark(d, "a", "2026-09-08T10:00:00.000Z");
    addMark(d, "done", "2026-09-08T10:01:00.000Z");
    expect(render(readMarks(d), true)).toContain("| phase | elapsed | share |");
  });

  test("human durations", () => {
    expect(human(400)).toBe("400ms");
    expect(human(4_500)).toBe("4.5s");
    expect(human(125_000)).toBe("2m05s");
  });
});
