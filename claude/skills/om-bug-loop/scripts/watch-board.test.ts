import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "watch-board.ts");
const dirs: string[] = [];
const freshDir = () => { const d = mkdtempSync(join(tmpdir(), "board-watch-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const BOARD = [
  "## todo", "",
  "- [ ] midnight workflow #medium #human",
  "- [ ] play around with the server settings #low #pa",
  "- [ ] copy link kinda ugly #low #research",
  "- [ ] reset button greyed out #low",
  "- [ ] **T90 · Already taken** [[kanban/cards/already-taken|details]] #low #openmarket",
  "- [ ] **todo · Keyboard & focus (2)** [[kanban/cards/group-todo-keyboard-focus|details]] #openmarket #group",
  "",
].join("\n");

async function runOnce(stateDir: string, boardPath: string, extra: string[] = []) {
  const proc = Bun.spawn({
    cmd: ["bun", SCRIPT, "--once", "--state", stateDir, "--board", boardPath, ...extra],
    cwd: import.meta.dir, stdout: "pipe", stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return {
    exitCode: proc.exitCode,
    json: stdout.trim() ? JSON.parse(stdout.trim().split("\n").pop()!) : null,
    pending: (() => { try { return readdirSync(join(stateDir, "pending")).sort(); } catch { return []; } })(),
    stateExists: existsSync(join(stateDir, "state.json")),
  };
}

test("(a) routes every unclaimed card and skips #human and claimed ones", async () => {
  const dir = freshDir();
  const board = join(dir, "Kanban.md");
  writeFileSync(board, BOARD);
  const r = await runOnce(dir, board);

  expect(r.exitCode).toBe(0);
  const routes = Object.fromEntries(r.json.new.map((c: any) => [c.title, c.route]));
  expect(routes).toEqual({
    "play around with the server settings": "om-play-around",
    "copy link kinda ugly": "om-research",
    "reset button greyed out": "om-task",
  });
  expect(Object.keys(routes)).not.toContain("midnight workflow");
  expect(Object.keys(routes)).not.toContain("Already taken");
  expect(Object.keys(routes)).not.toContain("todo · Keyboard & focus (2)");
});

test("a todo group line is claimed, so --once offers only the raw line", async () => {
  const dir = freshDir();
  const board = join(dir, "Kanban.md");
  writeFileSync(board, [
    "## todo", "",
    "- [ ] **todo · Keyboard & focus (4)** [[cards/group-todo-keyboard-focus|details]] #openmarket #group",
    "- [ ] raw focus finding #low", "",
  ].join("\n"));
  const r = await runOnce(dir, board);
  expect(r.exitCode).toBe(0);
  expect(r.json.new.map((card: any) => card.title)).toEqual(["raw focus finding"]);
  expect(r.pending).toEqual(["raw-focus-finding.json"]);
});

test("(b) a #human card is never recorded anywhere — the veto is a filter", async () => {
  const dir = freshDir();
  const board = join(dir, "Kanban.md");
  writeFileSync(board, BOARD);
  const r = await runOnce(dir, board);
  // The watcher owns no ledger: `dispatched` belongs to the coordinator, so a
  // clean run writes no state at all. Nothing about the #human card persists.
  expect(r.stateExists).toBe(false);
  expect(r.pending.some(p => p.includes("midnight"))).toBe(false);
});

test("(c) removing #human makes the card eligible on the very next poll", async () => {
  const dir = freshDir();
  const board = join(dir, "Kanban.md");
  writeFileSync(board, BOARD);
  await runOnce(dir, board);
  writeFileSync(board, BOARD.replace(" #medium #human", " #medium"));
  const r = await runOnce(dir, board);
  expect(r.json.new.map((c: any) => c.title)).toContain("midnight workflow");
});

test("(d) a slug already dispatched is not re-offered", async () => {
  const dir = freshDir();
  const board = join(dir, "Kanban.md");
  writeFileSync(board, BOARD);
  const first = await runOnce(dir, board);
  expect(first.pending).toContain("reset-button-greyed-out.json");
  rmSync(join(dir, "pending", "reset-button-greyed-out.json"));
  writeFileSync(join(dir, "state.json"),
    JSON.stringify({ dispatched: ["reset-button-greyed-out"] }));
  const r = await runOnce(dir, board);
  expect(r.json.new.map((c: any) => c.title)).not.toContain("reset button greyed out");
});

test("(e) a pending file already on disk is not offered twice", async () => {
  const dir = freshDir();
  const board = join(dir, "Kanban.md");
  writeFileSync(board, BOARD);
  await runOnce(dir, board);
  const again = await runOnce(dir, board);
  expect(again.json.new).toEqual([]);
});

test("(f) the payload carries what the coordinator needs to dispatch", async () => {
  const dir = freshDir();
  const board = join(dir, "Kanban.md");
  writeFileSync(board, BOARD);
  await runOnce(dir, board);
  const pa = JSON.parse(readFileSync(join(dir, "pending", "play-around-with-the-server.json"), "utf8"));
  expect(pa).toMatchObject({ route: "om-play-around", tags: ["#low", "#pa"] });
  expect(typeof pa.lineNo).toBe("number");
  expect(typeof pa.detectedAt).toBe("string");
});

test("(g) a missing board is not a crash", async () => {
  const dir = freshDir();
  const r = await runOnce(dir, join(dir, "nope.md"));
  expect(r.exitCode).toBe(0);
  expect(r.json.new).toEqual([]);
});

test("(h) --max-per-poll offers at most N cards, leaving the rest for later polls", async () => {
  const dir = freshDir();
  const board = join(dir, "Kanban.md");
  writeFileSync(board, BOARD);

  // Three cards are routable in BOARD. One poll, one card.
  const first = await runOnce(dir, board, ["--max-per-poll", "1"]);
  expect(first.json.new).toHaveLength(1);
  expect(first.pending).toHaveLength(1);

  // The next poll offers the next one, not the same one again.
  const second = await runOnce(dir, board, ["--max-per-poll", "1"]);
  expect(second.json.new).toHaveLength(1);
  expect(second.json.new[0].slug).not.toBe(first.json.new[0].slug);
  expect(second.pending).toHaveLength(2);

  const third = await runOnce(dir, board, ["--max-per-poll", "1"]);
  expect(third.json.new).toHaveLength(1);
  expect(third.pending).toHaveLength(3);

  // Nothing routable left.
  const fourth = await runOnce(dir, board, ["--max-per-poll", "1"]);
  expect(fourth.json.new).toEqual([]);
});

test("(i) without --max-per-poll every routable card is offered at once", async () => {
  const dir = freshDir();
  const board = join(dir, "Kanban.md");
  writeFileSync(board, BOARD);
  const r = await runOnce(dir, board);
  expect(r.json.new).toHaveLength(3);
});

test("(j) a non-numeric or non-positive --max-per-poll is refused, not ignored", async () => {
  const dir = freshDir();
  const board = join(dir, "Kanban.md");
  writeFileSync(board, BOARD);
  for (const bad of ["nonsense", "0", "-2"]) {
    const r = await runOnce(dir, board, ["--max-per-poll", bad]);
    expect(r.exitCode).toBe(64);
  }
});

test("(k) a bad --poll-ms is refused too", async () => {
  const dir = freshDir();
  const board = join(dir, "Kanban.md");
  writeFileSync(board, BOARD);
  const r = await runOnce(dir, board, ["--poll-ms", "abc"]);
  expect(r.exitCode).toBe(64);
});
