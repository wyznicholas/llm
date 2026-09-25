import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { citationsIn, claimsIn, lint } from "./verify-lint.ts";

function fixture(): { dir: string; art: string } {
  const dir = mkdtempSync(join(tmpdir(), "vlint-"));
  mkdirSync(join(dir, "verifier"), { recursive: true });
  writeFileSync(join(dir, "verifier", "suite.txt"), "8270 pass / 90 fail\n");
  return { dir, art: "verifier/suite.txt" };
}
const run = (md: string, dir: string, vault?: string) =>
  lint(md, { evidenceDir: dir, reportDir: dir, vaultEvidence: vault });

describe("claim detection", () => {
  test("counts and timings are claims", () => {
    expect(claimsIn("8270 pass / 90 fail")).toContain("8270 pass");
    expect(claimsIn("suite ran 167.1s")).toHaveLength(1);
    expect(claimsIn("245 diagnostics identical")).toHaveLength(1);
  });
  // Flagging shas, dates and version refs would make the output noise, and a
  // noisy gate gets ignored — the same way five false OVER-HOUR alarms trained
  // everyone to skip the one signal meant to be unignorable.
  test("shas, dates and short line refs are not claims", () => {
    expect(claimsIn("rebased onto def2146f cleanly")).toHaveLength(0);
    expect(claimsIn("measured 2026-09-07")).toHaveLength(0);
    expect(claimsIn("see session.ts:754")).toHaveLength(0);
  });
});

describe("citation detection", () => {
  test("backticked paths, wikilinks and bare filenames", () => {
    expect(citationsIn("see `verifier/suite.txt`")).toEqual(["verifier/suite.txt"]);
    expect(citationsIn("![[kanban/evidence/x/repro.png]]")).toEqual(["kanban/evidence/x/repro.png"]);
    expect(citationsIn("banked in newfails-diff.txt")).toEqual(["newfails-diff.txt"]);
  });
});

describe("lint", () => {
  test("a cited section passes", () => {
    const { dir, art } = fixture();
    expect(run(`## Suite\n\nBase 8270 pass / 90 fail — \`${art}\`\n`, dir)).toHaveLength(0);
  });

  test("one citation covers the whole section, not just its own line", () => {
    const { dir, art } = fixture();
    const md = `## Suite\n\nFull numbers in \`${art}\`.\n\n| arm | pass |\n| base | 8270 pass |\n| fix | 8280 pass |\n`;
    expect(run(md, dir)).toHaveLength(0);
  });

  // T50's auditor finding: `mergeable` asserted in prose, never measured.
  test("an uncited number is caught", () => {
    const { dir } = fixture();
    const f = run("## CI\n\nLint reported 245 diagnostics on both arms.\n", dir);
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe("uncited-claim");
  });

  test("a citation that does not resolve is caught", () => {
    const { dir } = fixture();
    const f = run("## Suite\n\n8270 pass, see `verifier/missing.txt`\n", dir);
    expect(f.some(x => x.kind === "dead-citation")).toBe(true);
  });

  // The auditor caught a BEFORE render pointing at a deleted worktree.
  test("a citation into a worktree is flagged as ephemeral", () => {
    const { dir } = fixture();
    const wt = mkdtempSync(join(tmpdir(), "wt-"));
    writeFileSync(join(wt, "out.txt"), "x");
    const f = run(`## Suite\n\n8270 pass, see \`${join(wt, "out.txt")}\`\n`, dir);
    expect(f.some(x => x.kind === "ephemeral-citation")).toBe(true);
  });

  test("vault evidence counts as durable", () => {
    const { dir } = fixture();
    const vault = mkdtempSync(join(tmpdir(), "vault-"));
    writeFileSync(join(vault, "repro.png"), "x");
    const f = run(`## Shot\n\n2 files, 4 hunks — ![[${join(vault, "repro.png")}]]\n`, dir, vault);
    expect(f).toHaveLength(0);
  });

  test("prose with no numbers needs no citation", () => {
    const { dir } = fixture();
    expect(run("## Notes\n\nThe conflict was incidental.\n", dir)).toHaveLength(0);
  });
});
