import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI = join(import.meta.dir, "task-watch.ts");
const roots: string[] = [];

interface FixtureOptions {
  ref?: string;
  slug?: string;
  elapsedMs?: number;
  evidenceName?: string;
  status?: string;
  stages?: Record<string, string>;
  reopenedAt?: string;
  parkedSlug?: string;
}

function fixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "task-watch-"));
  roots.push(root);
  const ref = options.ref ?? "T68";
  const slug = options.slug ?? "task-watch-fixture";
  const board = join(root, "vault", "kanban", "Kanban.md");
  const tasks = join(root, "state", "fixture-tasks.json");
  mkdirSync(dirname(board), { recursive: true });
  mkdirSync(dirname(tasks), { recursive: true });
  writeFileSync(board, options.parkedSlug
    ? `## Need Attention\n\n- [ ] [[kanban/cards/${options.parkedSlug}|details]]\n`
    : "");
  writeFileSync(tasks, JSON.stringify({
    [slug]: {
      ref,
      slug,
      status: options.status ?? "implementing",
      stages: options.stages ?? {
        implementing: new Date(Date.now() - (options.elapsedMs ?? 0)).toISOString(),
      },
      ...(options.reopenedAt ? { reopenedAt: options.reopenedAt } : {}),
    },
  }));

  if (options.evidenceName) {
    const evidence = join(dirname(board), "evidence", options.evidenceName);
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "proof.txt"), "fresh evidence\n");
  }

  return { board, tasks, ref, slug };
}

function run(board: string, tasks: string, ...args: string[]) {
  const proc = Bun.spawnSync(
    ["bun", CLI, "--board", board, "--tasks", tasks, ...args],
    { stdout: "pipe", stderr: "pipe", timeout: 10_000 },
  );
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("task-watch artifact freshness", () => {
  test("finds fresh evidence in the ref-named directory", () => {
    const f = fixture({ evidenceName: "T68" });
    const proc = run(f.board, f.tasks);

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).toContain(f.ref);
    expect(proc.stdout).not.toContain("no-artifacts-yet");
    const age = proc.stdout.match(/last-write\s+(\d+)m/);
    expect(age).not.toBeNull();
    expect(Number(age![1])).toBeLessThanOrEqual(1);
  });

  test("falls back to a legacy slug-named evidence directory", () => {
    const f = fixture({ ref: "T69", slug: "legacy-evidence", evidenceName: "legacy-evidence" });
    const proc = run(f.board, f.tasks);

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).not.toContain("no-artifacts-yet");
    expect(proc.stdout).toMatch(/last-write\s+0m/);
  });

  test("still warns when no evidence directory exists", () => {
    const f = fixture({ ref: "T70", slug: "untouched-evidence" });
    const proc = run(f.board, f.tasks);

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).toContain("no-artifacts-yet");
    expect(proc.stdout).toContain("last-write   –");
  });

  test("board and tasks overrides redirect the task list and derived evidence root", () => {
    const f = fixture({ ref: "T71", slug: "override-only", evidenceName: "T71" });
    const proc = run(f.board, f.tasks);

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).toContain("T71");
    expect(proc.stdout).toContain("override-only");
    expect(proc.stdout).not.toContain("no-artifacts-yet");
  });

  test("uses the fixture board to detect a parked task", () => {
    const slug = "fixture-board-only-task";
    const f = fixture({ ref: "T901", slug, parkedSlug: slug });
    const proc = run(f.board, f.tasks);

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).toContain(slug);
    expect(proc.stdout).toContain("⚠ parked");
  });
});

describe("task-watch reopened elapsed", () => {
  test("flags an unconfirmed reopen instead of stale elapsed alarms", () => {
    const now = Date.now();
    const f = fixture({
      ref: "T75",
      slug: "unconfirmed-reset",
      stages: {
        implementing: new Date(now - 3 * 24 * 60 * 60_000).toISOString(),
        shipped: new Date(now - 2 * 24 * 60 * 60_000).toISOString(),
      },
    });
    const proc = run(f.board, f.tasks);

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).toContain("reopened");
    expect(proc.stdout).not.toContain("OVER-HOUR");
    expect(proc.stdout).not.toContain("checkpoint");
  });

  test("keeps over-hour behavior for ordinary monotonic stages", () => {
    const f = fixture({ ref: "T76", slug: "ordinary-overrun", elapsedMs: 61 * 60_000 });
    const proc = run(f.board, f.tasks);

    expect(proc.exitCode).toBe(1);
    expect(proc.stdout).toContain("OVER-HOUR");
    expect(proc.stdout).not.toContain("reopened");
  });

  test("uses a recent confirmed reopen as the elapsed start", () => {
    const now = Date.now();
    const f = fixture({
      ref: "T77",
      slug: "confirmed-reset",
      stages: {
        implementing: new Date(now - 3 * 24 * 60 * 60_000).toISOString(),
        shipped: new Date(now - 2 * 24 * 60 * 60_000).toISOString(),
      },
      reopenedAt: new Date(now - 2 * 60_000).toISOString(),
    });
    const proc = run(f.board, f.tasks);

    expect(proc.exitCode).toBe(0);
    const elapsed = proc.stdout.match(/\s(\d+)m\s+last-write/);
    expect(elapsed).not.toBeNull();
    expect(Number(elapsed![1])).toBeGreaterThanOrEqual(1);
    expect(Number(elapsed![1])).toBeLessThanOrEqual(3);
    expect(proc.stdout).not.toContain("reopened");
    expect(proc.stdout).not.toContain("OVER-HOUR");
    expect(proc.stdout).not.toContain("checkpoint");
  });

  test("ignores a reopenedAt older than the naive start", () => {
    const now = Date.now();
    const f = fixture({
      ref: "T78",
      slug: "stale-reset-time",
      stages: {
        implementing: new Date(now - 61 * 60_000).toISOString(),
        shipped: new Date(now - 30 * 60_000).toISOString(),
      },
      reopenedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
    });
    const proc = run(f.board, f.tasks);

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).toContain("reopened");
    expect(proc.stdout).not.toContain("OVER-HOUR");
    expect(proc.stdout).not.toContain("checkpoint");
  });

  test("keeps parked ahead of the inferred reopened flag", () => {
    const now = Date.now();
    const slug = "synthetic-attention-slug";
    const f = fixture({
      ref: "T900",
      slug,
      parkedSlug: slug,
      stages: {
        implementing: new Date(now - 61 * 60_000).toISOString(),
        shipped: new Date(now - 30 * 60_000).toISOString(),
      },
    });
    const proc = run(f.board, f.tasks);

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).toContain("parked");
    expect(proc.stdout).not.toContain("reopened");
    expect(proc.stdout).not.toContain("OVER-HOUR");
  });

  test("does not count a reopened-only row as over-hour for main exit", () => {
    const now = Date.now();
    const f = fixture({
      ref: "T79",
      slug: "exit-contract-reset",
      stages: {
        implementing: new Date(now - 3 * 24 * 60 * 60_000).toISOString(),
        shipped: new Date(now - 2 * 24 * 60 * 60_000).toISOString(),
      },
    });
    const proc = run(f.board, f.tasks);

    expect(proc.stdout).toContain("reopened");
    expect(proc.stdout).not.toContain("OVER-HOUR");
    expect(proc.exitCode).toBe(0);
  });
});

describe("task-watch planned status", () => {
  test("lists an over-hour planned task", () => {
    const f = fixture({
      ref: "T312",
      slug: "planned-overrun",
      status: "planned",
      stages: {
        planned: new Date(Date.now() - 90 * 60_000).toISOString(),
      },
    });
    const proc = run(f.board, f.tasks);

    expect(proc.stdout).toContain(f.ref);
    expect(proc.stdout).toContain("OVER-HOUR");
  });

  test("lists a recent planned task without an elapsed warning", () => {
    const f = fixture({
      ref: "T313",
      slug: "planned-recent",
      status: "planned",
      stages: {
        planned: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    });
    const proc = run(f.board, f.tasks);

    expect(proc.stdout).toContain(f.ref);
    expect(proc.stdout).not.toContain("OVER-HOUR");
    expect(proc.stdout).not.toContain("checkpoint");
  });
});

describe("task-watch exit and alert contracts", () => {
  test("one-shot exits 0 normally and 1 for an over-hour task", () => {
    const normal = fixture({ ref: "T72", slug: "normal-exit" });
    const over = fixture({ ref: "T73", slug: "over-exit", elapsedMs: 61 * 60_000 });

    expect(run(normal.board, normal.tasks).exitCode).toBe(0);
    const overProc = run(over.board, over.tasks);
    expect(overProc.exitCode).toBe(1);
    expect(overProc.stdout).toContain("OVER-HOUR");
  });

  test("watch alert renders missing evidence as a dash and exits 0", () => {
    const f = fixture({ ref: "T74", slug: "watch-missing", elapsedMs: 56_000 });
    const proc = run(f.board, f.tasks, "--watch", "--warn", "1", "--poll-ms", "10");

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).toContain("checkpoint");
    expect(proc.stdout).toContain("last-write –");
    expect(proc.stdout).not.toContain("-1m");
  }, 10_000);

  // The heartbeat exit-3 contract is intentionally not exercised here: its
  // fixed one-hour timer is out of scope for this fast suite.
});
