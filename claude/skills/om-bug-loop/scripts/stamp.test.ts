import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stampTool = process.env.OMBL_STAMP_UNDER_TEST ?? join(import.meta.dir, "stamp.ts");
const headerMark = "om-bug-loop:provenance";

function inTemp(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "stamp-T271-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function command(args: string[], cwd: string): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
}

function stamp(file: string, cwd: string, commit = "new-commit"): ReturnType<typeof Bun.spawnSync> {
  return command(["bun", stampTool, "write", file, "--arm", "after", "--commit", commit], cwd);
}

function text(file: string): string {
  return readFileSync(file, "utf8");
}

function headerCount(body: string): number {
  return body.split(headerMark).length - 1;
}

test("AC1: stamps an executable mjs after its shebang", () => inTemp(dir => {
  const file = join(dir, "probe.mjs");
  writeFileSync(file, '#!/usr/bin/env node\nconsole.log("ok")\n');

  expect(stamp(file, dir).exitCode).toBe(0);
  const body = text(file);
  expect(body.split("\n")[0]).toBe("#!/usr/bin/env node");
  expect(headerCount(body)).toBe(1);
  const ran = command(["node", file], dir);
  expect(ran.exitCode).toBe(0);
  expect(ran.stdout.toString()).toBe("ok\n");
}));

test("AC2: keeps a Python shebang on line one", () => inTemp(dir => {
  const file = join(dir, "probe.py");
  writeFileSync(file, '#!/usr/bin/env python3\nprint("ok")\n');

  expect(stamp(file, dir).exitCode).toBe(0);
  expect(text(file).split("\n")[0]).toBe("#!/usr/bin/env python3");
  const ran = command(["python3", file], dir);
  expect(ran.exitCode).toBe(0);
  expect(ran.stdout.toString()).toBe("ok\n");
}));

test("AC3: stamps an executable TypeScript file after its shebang", () => inTemp(dir => {
  const file = join(dir, "probe.ts");
  writeFileSync(file, '#!/usr/bin/env bun\nconsole.log("ok")\n');

  expect(stamp(file, dir).exitCode).toBe(0);
  expect(text(file).split("\n")[0]).toBe("#!/usr/bin/env bun");
  const ran = command(["bun", file], dir);
  expect(ran.exitCode).toBe(0);
  expect(ran.stdout.toString()).toBe("ok\n");
}));

test("AC4: three stamps leave one header and three executable lines", () => inTemp(dir => {
  const file = join(dir, "probe.mjs");
  writeFileSync(file, '#!/usr/bin/env node\nconsole.log("ok")\n');

  for (const commit of ["first", "second", "third"]) {
    expect(stamp(file, dir, commit).exitCode).toBe(0);
  }
  const body = text(file);
  expect(headerCount(body)).toBe(1);
  expect(body.trimEnd().split("\n")).toHaveLength(3);
  expect(command(["node", file], dir).exitCode).toBe(0);
}));

test("AC5: re-stamping a hand-repaired file replaces its post-shebang header", () => inTemp(dir => {
  const file = join(dir, "probe.mjs");
  writeFileSync(file,
    '#!/usr/bin/env node\n// om-bug-loop:provenance arm=before commit=old at=2026-01-01T00:00:00.000Z\nconsole.log("ok")\n');

  expect(stamp(file, dir, "new-commit").exitCode).toBe(0);
  const body = text(file);
  expect(body.split("\n")[0]).toBe("#!/usr/bin/env node");
  expect(headerCount(body)).toBe(1);
  expect(body).toContain("commit=new-commit");
  expect(command(["node", file], dir).exitCode).toBe(0);
}));

test("AC6: re-stamping an old-tool-broken file heals its shebang", () => inTemp(dir => {
  const file = join(dir, "probe.mjs");
  writeFileSync(file,
    '// om-bug-loop:provenance arm=before commit=old at=2026-01-01T00:00:00.000Z\n#!/usr/bin/env node\nconsole.log("ok")\n');

  expect(stamp(file, dir).exitCode).toBe(0);
  const body = text(file);
  expect(body.split("\n")[0]).toBe("#!/usr/bin/env node");
  expect(headerCount(body)).toBe(1);
  expect(command(["node", file], dir).exitCode).toBe(0);
}));

test("AC7: preserves a foreign Markdown comment on the first line", () => inTemp(dir => {
  const file = join(dir, "evidence.md");
  const original = "<!-- om-bug-loop:source om-play-around -->\nbody\n";
  writeFileSync(file, original);

  expect(stamp(file, dir).exitCode).toBe(0);
  const body = text(file);
  expect(headerCount(body)).toBe(1);
  expect(body.slice(body.indexOf("\n") + 1)).toBe(original);
}));

test("AC8: preserves a foreign text comment on the first line", () => inTemp(dir => {
  const file = join(dir, "evidence.txt");
  const original = "# omitted rows are listed below\nrow 1\n";
  writeFileSync(file, original);

  expect(stamp(file, dir).exitCode).toBe(0);
  const body = text(file);
  expect(headerCount(body)).toBe(1);
  expect(body.slice(body.indexOf("\n") + 1)).toBe(original);
}));

test("AC9: re-stamps a plain log with an exact header and unchanged body", () => inTemp(dir => {
  const file = join(dir, "evidence.log");
  const original = "first byte\nlast byte\n";
  writeFileSync(file, original);

  expect(stamp(file, dir, "first").exitCode).toBe(0);
  expect(stamp(file, dir, "second").exitCode).toBe(0);
  const body = text(file);
  const [header] = body.split("\n");
  expect(header).toMatch(/^# om-bug-loop:provenance arm=after commit=second at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  expect(headerCount(body)).toBe(1);
  expect(body.slice(body.indexOf("\n") + 1)).toBe(original);
}));

test("AC10: adds a newline to a bare shebang before stamping", () => inTemp(dir => {
  const file = join(dir, "probe.mjs");
  writeFileSync(file, "#!/usr/bin/env node");

  expect(stamp(file, dir).exitCode).toBe(0);
  const body = text(file);
  expect(body.split("\n")[0]).toBe("#!/usr/bin/env node");
  expect(headerCount(body)).toBe(1);
  expect(command(["node", file], dir).exitCode).toBe(0);
}));

test("AC11: strict manifest is repeatable and excludes only its root output", () => inTemp(dir => {
  const artifact = join(dir, "evidence.log");
  writeFileSync(artifact, "evidence\n");
  expect(stamp(artifact, dir).exitCode).toBe(0);

  const first = command(["bun", stampTool, "manifest", dir, "--strict"], dir);
  const second = command(["bun", stampTool, "manifest", dir, "--strict"], dir);
  expect(first.exitCode).toBe(0);
  expect(second.exitCode).toBe(0);
  expect(text(join(dir, "MANIFEST.md"))).not.toContain("`MANIFEST.md`");

  const nestedDir = join(dir, "nested");
  mkdirSync(nestedDir);
  const nestedManifest = join(nestedDir, "MANIFEST.md");
  writeFileSync(nestedManifest, "nested evidence\n");
  expect(stamp(nestedManifest, dir).exitCode).toBe(0);
  expect(command(["bun", stampTool, "manifest", dir, "--strict"], dir).exitCode).toBe(0);
  expect(text(join(dir, "MANIFEST.md"))).toContain("`nested/MANIFEST.md`");
}));

test("AC12: strict manifest reports provenance for a shebang script", () => inTemp(dir => {
  const file = join(dir, "probe.mjs");
  writeFileSync(file, '#!/usr/bin/env node\nconsole.log("ok")\n');
  expect(stamp(file, dir).exitCode).toBe(0);

  expect(command(["bun", stampTool, "manifest", dir, "--strict"], dir).exitCode).toBe(0);
  const manifest = text(join(dir, "MANIFEST.md"));
  expect(manifest).toContain("`probe.mjs` — arm **after**, commit `new-comm`");
}));
