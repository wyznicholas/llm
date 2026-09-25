// kanban.test.ts — the board mirror must be a *surgical* editor: it owns the
// column skeleton, and touches nothing else in a file Nicholas also edits by
// hand in Obsidian.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { COLUMNS, SKELETON, moveCard, noteProblem, noteSection, statusBlock, MARK_START, cardLine, DEFAULT_BOARD, DEFAULT_PRIORITY, normalizeTask, STAGES, LEGACY_TICK, stripReviewSkipMark } from "./kanban";

const SCRIPT = join(import.meta.dir, "kanban.ts");
const dirs: string[] = [];
function boardPath(contents = ""): string {
  const d = mkdtempSync(join(tmpdir(), "om-bug-loop-kanban-"));
  dirs.push(d);
  const p = join(d, "Kanban.md");
  writeFileSync(p, contents);
  return p;
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Review columns refuse a card whose note is missing or a stub, so a test that
 *  exercises MOVEMENT into one must give the card a real note first. */
function writeNote(board: string, slug: string): void {
  const cards = join(dirname(board), "cards");
  mkdirSync(cards, { recursive: true });
  writeFileSync(join(cards, `${slug}.md`),
    `# ${slug}\n\n## Problem\n\n` + "A genuine note body, long enough to pass the stub check. ".repeat(3) +
    // Review cards must SHOW the change; movement fixtures carry an embed so
    // they exercise card movement, not the screenshot guard.
    `\n\n![[kanban/evidence/${slug}/after.png]]\n`);
}

function run(args: string[]) {
  // Safety invariant: even old tests that predate --tasks/--board isolation
  // must never fall through to the live board or ledger.
  const safe = [...args];
  let board = safe.includes("--board") ? safe[safe.indexOf("--board") + 1] : undefined;
  let tasks = safe.includes("--tasks") ? safe[safe.indexOf("--tasks") + 1] : undefined;
  if (!board) {
    board = tasks ? join(dirname(tasks), "Kanban.md") : boardPath(SKELETON);
    if (!existsSync(board)) writeFileSync(board, SKELETON);
    safe.push("--board", board);
  }
  if (!tasks) {
    tasks = join(dirname(board), "tasks.json");
    safe.push("--tasks", tasks);
  }
  const proc = Bun.spawnSync({ cmd: ["bun", SCRIPT, ...safe], cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

test("init on an empty file writes frontmatter and the six columns in order", () => {
  const p = boardPath("");
  expect(run(["init", "--board", p]).code).toBe(0);
  const md = readFileSync(p, "utf8");
  expect(md.startsWith("---\n\nkanban-plugin: board\n\n---\n")).toBe(true);
  const headings = [...md.matchAll(/^## (.+)$/gm)].map(m => m[1]);
  expect(headings).toEqual([...COLUMNS]);
});

import {
  CARD_CATEGORIES, CATEGORIES_DOC, GROUP_LANES, groupId, parseGroupId, groupLine,
  summaryProblem, groupTarget, groupNote, renderGroups, readCategoryMarker,
  readSummaryMarker, reconcileMembership,
} from "./kanban";

describe("card categories and grouped lane cards", () => {
  const NOW = "2026-09-17T12:00:00.000Z";
  const SUMMARY = {
    problem: "Keyboard focus skips the History control.",
    solution: "Put the control in the normal tab order.",
    repro: ["Open a room from a cold app.", "Press Tab until the dock is reached."],
  };
  const args = (board: string, tasks: string) =>
    ["--board", board, "--tasks", tasks, "--now", NOW];
  const summaryFile = (board: string, summary: object = SUMMARY) => {
    const path = join(dirname(board), `summary-${Math.random()}.json`);
    writeFileSync(path, JSON.stringify(summary));
    return path;
  };
  const memberNote = (board: string, slug: string) => {
    const cards = join(dirname(board), "cards");
    mkdirSync(cards, { recursive: true });
    writeFileSync(join(cards, `${slug}.md`), [
      `# ${slug}`, "", "## Problem", "",
      "Keyboard focus skips the visible History control in the room dock. ".repeat(2),
      "", "## Reproduction steps", "", "1. Open a room from a cold app.",
      "2. Press Tab until the dock is reached.", "",
      "**Expected:** History receives focus.", "**Actual:** Focus skips it.", "",
      "## Work items", "", "- [ ] update the control", "", "No UI surface — fixture.", "",
    ].join("\n"));
  };
  function fixture(
    lane: "todo" | "in progress" | "Review" = "Review",
    entries: Array<{ slug: string; ref: string; title: string }> = [
      { slug: "focus-five", ref: "T5", title: "History focus skips the control" },
    ],
  ) {
    const lines = entries.map(({ slug, ref, title }) =>
      `- [ ] **${ref} · ${title}** [[cards/${slug}|details]] #openmarket #low #bug ![[${slug}.png]]`);
    const board = boardPath(SKELETON
      .replace(`## ${lane}\n\n`, `## ${lane}\n\n- [ ] sentinel before #human\n${lines.join("\n")}\n- [ ] sentinel after #human\n`));
    const tasks = join(dirname(board), "tasks.json");
    const ledger: Record<string, any> = {
      untouched: { slug: "untouched", ref: "T99", status: "new", unknown: { keep: true } },
    };
    for (const entry of entries) {
      ledger[entry.slug] = {
        slug: entry.slug, ref: entry.ref,
        status: lane === "Review" ? "shipped" : "implementing",
        priority: "low", product: "chat", unknown: [1, 2, 3],
        ...(lane === "Review" ? { mrUrl: `https://example.test/${entry.ref}` } : {}),
        featureMap: ["No feature surface — grouped-card fixture"],
        stages: { detected: "2026-09-17T10:00:00.000Z" },
      };
      memberNote(board, entry.slug);
    }
    writeFileSync(tasks, `${JSON.stringify(ledger, null, 1)}\n`);
    return { board, tasks, entries };
  }
  const categorize = (
    board: string, tasks: string, task: string, category = "keyboard-focus",
    extra: string[] = [],
  ) => run(["categorize", task, category, "--summary", summaryFile(board),
    ...extra, ...args(board, tasks)]);

  test("category shape, ids, title cap and summary validation", () => {
    expect(CARD_CATEGORIES.map(c => [c.n, c.key, c.grouped])).toEqual([
      [1, "keyboard-focus", true], [2, "screen-reader", true],
      [3, "layout-width", true], [4, "raw-data", false],
      [5, "stale-state", true], [6, "write-safety", false],
      [7, "routing-history", true], [8, "dead-ends", false],
      [9, "visual-copy", true], [10, "product-decision", false],
      [11, "not-real", true], [12, "pipeline-infra", false],
    ]);
    expect(GROUP_LANES).toEqual(["todo", "Review"]);
    for (const lane of GROUP_LANES) for (const category of CARD_CATEGORIES) {
      const id = groupId(lane, category.key);
      expect(parseGroupId(id)).toEqual({ lane, category: category.key });
      const bold = /^- \[ \] \*\*(.*?)\*\*/.exec(groupLine("/tmp/Kanban.md", lane, category.key, 999))![1]!;
      expect(bold.length).toBeLessThanOrEqual(TITLE_MAX);
    }
    expect(parseGroupId("group-review-unknown")).toBeNull();
    expect(summaryProblem(SUMMARY)).toBeNull();
    expect(summaryProblem({ ...SUMMARY, problem: " " })).toMatch(/problem/);
    expect(summaryProblem({ ...SUMMARY, solution: "x".repeat(401) })).toMatch(/400/);
    expect(summaryProblem({ ...SUMMARY, repro: Array(9).fill("step") })).toMatch(/1 to 8/);
    expect(summaryProblem({ ...SUMMARY, repro: ["x".repeat(241)] })).toMatch(/240/);
    expect(summaryProblem({ ...SUMMARY, problem: "![[shot.png]]" })).toMatch(/image/);
    expect(summaryProblem({ ...SUMMARY, repro: ["![shot](shot.png)"] })).toMatch(/image/);
    expect(groupTarget({ slug: "x", ref: "T1", category: "keyboard-focus", summary: SUMMARY }, "Review"))
      .toBe("group-review-keyboard-focus");
    expect(groupTarget({ slug: "x", ref: "C1", category: "keyboard-focus", summary: SUMMARY }, "Review"))
      .toBeNull();
  });

  test.skipIf(!existsSync(CATEGORIES_DOC))(
    "the category reference documents every key and grouped setting",
    () => {
      const doc = readFileSync(CATEGORIES_DOC, "utf8");
      for (const category of CARD_CATEGORIES) {
        expect(doc).toContain(`\`${category.key}\``);
        const section = doc.split(new RegExp(`^### .*\\\`${category.key}\\\`.*$`, "m"))[1]!
          .split(/^### /m)[0]!;
        expect(section).toContain(category.grouped ? "**grouped**" : "**individual**");
      }
    },
  );

  test("categorize groups Review cards surgically and writes the complete group note", () => {
    const { board, tasks } = fixture();
    const beforeLedger = JSON.parse(readFileSync(tasks, "utf8"));
    const result = categorize(board, tasks, "T5");
    expect(result.code).toBe(0);
    expect(result.out).toContain("grouped in group-review-keyboard-focus");
    const markdown = readFileSync(board, "utf8");
    expect(markdown).not.toContain("cards/focus-five|details");
    expect(markdown).toContain("**Review · Keyboard & focus (1)**");
    expect(markdown).toContain("- [ ] sentinel before #human");
    expect(markdown).toContain("- [ ] sentinel after #human");
    const ledger = JSON.parse(readFileSync(tasks, "utf8"));
    expect(ledger.untouched).toEqual(beforeLedger.untouched);
    expect(ledger["focus-five"]).toMatchObject({
      category: "keyboard-focus", summary: SUMMARY,
      groupedIn: "group-review-keyboard-focus",
      title: "History focus skips the control",
    });
    expect(ledger["focus-five"].groupedLine).toContain("#bug ![[focus-five.png]]");
    expect(ledger["focus-five"].unknown).toEqual([1, 2, 3]);
    const note = readFileSync(join(dirname(board), "cards", "group-review-keyboard-focus.md"), "utf8");
    expect(note).toContain("## T5 · History focus skips the control");
    expect(note).toContain("[[cards/focus-five|full note]]");
    expect(note).toContain("PR https://example.test/T5");
    expect(note).toContain(`**Problem.** ${SUMMARY.problem}`);
    expect(note).toContain(`**Solution.** ${SUMMARY.solution}`);
    expect(note).toContain(`1. ${SUMMARY.repro[0]}`);
  });

  test("members sort by ref and keep their titles in the two-member group", () => {
    const { board, tasks } = fixture("Review", [
      { slug: "focus-five", ref: "T5", title: "Five" },
      { slug: "focus-three", ref: "T3", title: "Three" },
    ]);
    expect(categorize(board, tasks, "T5").code).toBe(0);
    expect(categorize(board, tasks, "T3").code).toBe(0);
    const note = readFileSync(join(dirname(board), "cards", "group-review-keyboard-focus.md"), "utf8");
    expect(readFileSync(board, "utf8")).toContain("**Review · Keyboard & focus (2)**");
    expect(note.indexOf("## T3")).toBeLessThan(note.indexOf("## T5"));
    expect(note).toContain("## T3 · Three");
    expect(note).toContain("## T5 · Five");
  });

  test("todo uses its exact lane label and Solution direction", () => {
    const { board, tasks } = fixture("todo");
    expect(categorize(board, tasks, "T5").code).toBe(0);
    expect(readFileSync(board, "utf8")).toContain("**todo · Keyboard & focus (1)**");
    const note = readFileSync(join(dirname(board), "cards", "group-todo-keyboard-focus.md"), "utf8");
    expect(note).toContain("**Solution direction.**");
    expect(note).not.toContain("**Solution.**");
  });

  test("non-grouped categories, exemptions, missing summaries and other lanes stay individual", () => {
    const individual = fixture();
    let result = categorize(individual.board, individual.tasks, "T5", "write-safety");
    expect(result.out).toContain("not a grouped category");
    expect(readFileSync(individual.board, "utf8")).toContain("cards/focus-five|details");

    const exempt = fixture();
    result = categorize(exempt.board, exempt.tasks, "T5", "keyboard-focus",
      ["--individual", "open question"]);
    expect(result.out).toContain("exempt: open question");
    expect(run(["categorize", "T5", "keyboard-focus", "--grouped",
      ...args(exempt.board, exempt.tasks)]).code).toBe(0);
    expect(readFileSync(exempt.board, "utf8")).toContain("group-review-keyboard-focus");

    const noSummary = fixture();
    result = run(["categorize", "T5", "keyboard-focus", ...args(noSummary.board, noSummary.tasks)]);
    expect(result.out).toContain("no summary");
    expect(readFileSync(noSummary.board, "utf8")).toContain("cards/focus-five|details");

    const progress = fixture("in progress");
    result = categorize(progress.board, progress.tasks, "T5");
    expect(result.out).toContain("lane in progress is not grouped");
  });

  test("list represents grouped members and reports a missing group card", () => {
    const { board, tasks } = fixture();
    expect(categorize(board, tasks, "T5").code).toBe(0);
    let listed = run(["list", ...args(board, tasks)]);
    expect(listed.out).toContain("Review");
    expect(listed.out).toContain("History focus skips the control  [group-review-keyboard-focus]");
    expect(listed.out).not.toContain("group card group-review-keyboard-focus missing");
    writeFileSync(board, readFileSync(board, "utf8").split("\n")
      .filter(line => !line.includes("cards/group-review-keyboard-focus|details"))
      .join("\n"));
    listed = run(["list", ...args(board, tasks)]);
    expect(listed.out).toContain("group card group-review-keyboard-focus missing from the board");
  });

  test("Done and Need Attention restore exact member lines and shrink or remove groups", () => {
    const { board, tasks } = fixture("Review", [
      { slug: "focus-five", ref: "T5", title: "Five" },
      { slug: "focus-three", ref: "T3", title: "Three" },
    ]);
    expect(categorize(board, tasks, "T5").code).toBe(0);
    expect(categorize(board, tasks, "T3").code).toBe(0);
    expect(run(["upsert", "T5", "--column", "Done", ...args(board, tasks)]).code).toBe(0);
    const done = readBoardCards(board).get("focus-five")!;
    expect(done.column).toBe("Done");
    const restored = readFileSync(board, "utf8").split("\n").find(line => line.includes("cards/focus-five|"))!;
    expect(restored).toContain("T5 · Five");
    expect(restored).toContain("#bug ![[focus-five.png]]");
    expect(readFileSync(board, "utf8")).toContain("**Review · Keyboard & focus (1)**");
    expect(JSON.parse(readFileSync(tasks, "utf8"))["focus-five"]).not.toHaveProperty("groupedIn");

    expect(run(["upsert", "T3", "--column", "Need Attention", ...args(board, tasks)]).code).toBe(0);
    expect(readBoardCards(board).get("focus-three")?.column).toBe("Need Attention");
    expect(readFileSync(board, "utf8")).not.toContain("cards/group-review-keyboard-focus|details");
    expect(readFileSync(join(dirname(board), "cards", "group-review-keyboard-focus.md"), "utf8"))
      .toContain("This group is empty.");
  });

  test("upsert in the same grouped lane keeps membership, stamps, and can retitle", () => {
    const { board, tasks } = fixture();
    expect(categorize(board, tasks, "T5").code).toBe(0);
    expect(run(["upsert", "T5", "--column", "Review", "--title", "Renamed focus bug",
      ...args(board, tasks)]).code).toBe(0);
    const entry = JSON.parse(readFileSync(tasks, "utf8"))["focus-five"];
    expect(entry.groupedIn).toBe("group-review-keyboard-focus");
    expect(entry.title).toBe("Renamed focus bug");
    expect(entry.groupedLine).toContain("T5 · Renamed focus bug");
    expect(entry.stages.shipped).toBe(NOW);
    expect(readFileSync(board, "utf8")).not.toContain("cards/focus-five|details");
  });

  test("moving an eligible card into Review auto-joins after the Review gates", () => {
    const { board, tasks } = fixture("in progress");
    const raw = JSON.parse(readFileSync(tasks, "utf8"));
    raw["focus-five"].category = "keyboard-focus";
    raw["focus-five"].summary = SUMMARY;
    writeFileSync(tasks, `${JSON.stringify(raw, null, 1)}\n`);
    expect(run(["upsert", "T5", "--column", "Review", ...args(board, tasks)]).code).toBe(0);
    expect(JSON.parse(readFileSync(tasks, "utf8"))["focus-five"].groupedIn)
      .toBe("group-review-keyboard-focus");
    expect(readFileSync(board, "utf8")).toContain("**Review · Keyboard & focus (1)**");
  });

  test("grouped-member commands never create a stray line and restored state carries priority", () => {
    const { board, tasks } = fixture();
    expect(categorize(board, tasks, "T5").code).toBe(0);
    const replacement = join(dirname(board), "replacement.md");
    writeFileSync(replacement, [
      "# focus-five", "", "## Problem", "", "A replacement problem remains detailed enough.",
      "", "## Reproduction steps", "", "1. Open a room.", "",
      "**Expected:** focus works.", "**Actual:** focus skips.", "",
      "## Work items", "", "- [ ] update the control", "", "No UI surface — fixture.", "",
    ].join("\n"));
    const commands = [
      ["priority", "T5", "high"], ["status", "T5", "swept"],
      ["stage", "T5", "reviewing"], ["stamp", "T5"],
      ["feature", "T5", "--none", "grouped fixture"],
      ["check", "T5", "--item", "update the control"],
      ["note", "T5", "--file", replacement, "--force"],
    ];
    for (const command of commands) {
      expect(run([...command, ...args(board, tasks)]).code).toBe(0);
      expect(JSON.parse(readFileSync(tasks, "utf8"))["focus-five"].groupedIn)
        .toBe("group-review-keyboard-focus");
      expect(readFileSync(board, "utf8")).not.toContain("cards/focus-five|details");
    }
    expect(run(["categorize", "T5", "write-safety", ...args(board, tasks)]).code).toBe(0);
    const restored = readFileSync(board, "utf8").split("\n").find(line => line.includes("cards/focus-five|"))!;
    expect(restored).toContain("#high");
    expect(restored).toContain("T5 · History focus skips the control");
  });

  test("reconcile completes a crash-left half-grouped member without replacing its recovery line", () => {
    const { board, tasks } = fixture();
    const raw = JSON.parse(readFileSync(tasks, "utf8"));
    const recovery = "- [ ] **T5 · Recovery title** [[cards/focus-five|details]] #openmarket #low #bug ![[recovery.png]]";
    Object.assign(raw["focus-five"], {
      category: "keyboard-focus", summary: SUMMARY,
      groupedIn: "group-review-keyboard-focus", groupedLine: recovery,
      title: "History focus skips the control",
    });
    writeFileSync(tasks, `${JSON.stringify(raw, null, 1)}\n`);

    expect(readFileSync(board, "utf8")).toContain("cards/focus-five|details");
    reconcileMembership(board, tasks, "focus-five");

    expect(readFileSync(board, "utf8")).not.toContain("cards/focus-five|details");
    const after = JSON.parse(readFileSync(tasks, "utf8"))["focus-five"];
    expect(after.groupedIn).toBe("group-review-keyboard-focus");
    expect(after.groupedLine).toBe(recovery);
    expect(readFileSync(board, "utf8")).toContain("**Review · Keyboard & focus (1)**");
  });

  test("consume flags and file-finding markers carry category and summary without guessing", () => {
    const direct = boardPath(SKELETON.replace("## todo\n\n", "## todo\n\n- [ ] direct focus bug #low #bug\n"));
    const directTasks = join(dirname(direct), "tasks.json");
    const directLine = readFileSync(direct, "utf8").split("\n")
      .findIndex(value => value.includes("direct focus bug"));
    expect(run(["consume", String(directLine), "--ref", "T1", "--slug", "direct-focus",
      "--category", "keyboard-focus", "--summary", summaryFile(direct),
      ...args(direct, directTasks)]).code).toBe(0);
    expect(JSON.parse(readFileSync(directTasks, "utf8"))["direct-focus"].groupedIn)
      .toBe("group-todo-keyboard-focus");

    const marked = boardPath(SKELETON);
    const markedTasks = join(dirname(marked), "tasks.json");
    const body = join(dirname(marked), "finding.md");
    writeFileSync(body, "## Problem\n\n" + "Focus skips the History control. ".repeat(4) +
      "\n\n## Reproduction steps\n\n1. Open a room.\n\n**Expected:** focus works.\n**Actual:** it skips.\n");
    const dashed = { ...SUMMARY, solution: "Keep -- inside the JSON value." };
    expect(run(["file-finding", "marked focus bug", "--file", body, "--tags", "#low #bug",
      "--category", "keyboard-focus", "--summary", summaryFile(marked, dashed),
      ...args(marked, markedTasks)]).code).toBe(0);
    const notePath = join(dirname(marked), "cards", "marked-focus-bug.md");
    const note = readFileSync(notePath, "utf8");
    expect(readCategoryMarker(note)).toBe("keyboard-focus");
    expect(readSummaryMarker(note)).toEqual(dashed);
    const line = readFileSync(marked, "utf8").split("\n")
      .findIndex(value => value.includes("marked focus bug"));
    expect(run(["consume", String(line), "--ref", "T2", "--slug", "marked-focus-bug",
      ...args(marked, markedTasks)]).code).toBe(0);
    expect(JSON.parse(readFileSync(markedTasks, "utf8"))["marked-focus-bug"]).toMatchObject({
      category: "keyboard-focus", summary: dashed, groupedIn: "group-todo-keyboard-focus",
    });
    const replacement = join(dirname(marked), "marker-replacement.md");
    writeFileSync(replacement, "# marked focus bug\n\n## Problem\n\n" +
      "The replacement remains a complete finding body. ".repeat(3) + "\n");
    expect(run(["note", "T2", "--file", replacement, "--force",
      ...args(marked, markedTasks)]).code).toBe(0);
    const replaced = readFileSync(notePath, "utf8");
    expect(readCategoryMarker(replaced)).toBe("keyboard-focus");
    expect(readSummaryMarker(replaced)).toEqual(dashed);

    const plain = boardPath(SKELETON.replace("## todo\n\n", "## todo\n\n- [ ] plain bug #low\n"));
    const plainTasks = join(dirname(plain), "tasks.json");
    const plainLine = readFileSync(plain, "utf8").split("\n")
      .findIndex(value => value.includes("plain bug"));
    expect(run(["consume", String(plainLine), "--ref", "T3", "--slug", "plain-bug",
      ...args(plain, plainTasks)]).code).toBe(0);
    expect(JSON.parse(readFileSync(plainTasks, "utf8"))["plain-bug"]).not.toHaveProperty("category");
  });

  test("categorize and group-note refusals are atomic", () => {
    const { board, tasks } = fixture();
    const before = [readFileSync(board, "utf8"), readFileSync(tasks, "utf8")];
    expect(run(["categorize", "C9", "keyboard-focus", ...args(board, tasks)]).code).toBe(1);
    const raw = JSON.parse(readFileSync(tasks, "utf8"));
    raw.research = { slug: "research", ref: "R2", status: "new" };
    raw.refless = { slug: "refless", status: "new" };
    writeFileSync(tasks, `${JSON.stringify(raw, null, 1)}\n`);
    expect(run(["categorize", "R2", "keyboard-focus", ...args(board, tasks)]).code).toBe(1);
    expect(run(["categorize", "refless", "keyboard-focus", ...args(board, tasks)]).code).toBe(1);
    expect(run(["categorize", "T5", "unknown", ...args(board, tasks)]).code).toBe(64);
    const bad = summaryFile(board, { ...SUMMARY, problem: "" });
    const beforeBad = [readFileSync(board, "utf8"), readFileSync(tasks, "utf8")];
    expect(run(["categorize", "T5", "keyboard-focus", "--summary", bad,
      ...args(board, tasks)]).code).toBe(1);
    expect([readFileSync(board, "utf8"), readFileSync(tasks, "utf8")]).toEqual(beforeBad);
    const source = join(dirname(board), "group-source.md");
    writeFileSync(source, "# no\n");
    expect(run(["note", "group-review-keyboard-focus", "--file", source,
      ...args(board, tasks)]).code).toBe(1);
    expect(readFileSync(board, "utf8")).toBe(before[0]);
  });

  test("group lines do not enter ref allocation or task resolution", () => {
    const { board, tasks } = fixture();
    expect(categorize(board, tasks, "T5").code).toBe(0);
    expect(boardRefs(board)).toEqual([]);
    expect(nextRef(tasks, "T", board)).toBe("T100");
    expect(knownRefs(tasks, board).find(entry => entry.ref === "T5")?.title)
      .toBe("History focus skips the control");
    expect(resolveRef("T5", tasks, board)).toBe("focus-five");
    expect(readBoardCards(board).has("group-review-keyboard-focus")).toBe(true);
    expect(knownRefs(tasks, board).some(entry => entry.slug.startsWith("group-"))).toBe(false);
  });

  test("pure rendering and repeated stamp are idempotent", () => {
    const { board, tasks } = fixture();
    expect(categorize(board, tasks, "T5").code).toBe(0);
    const raw = JSON.parse(readFileSync(tasks, "utf8"));
    const once = renderGroups(readFileSync(board, "utf8"), raw, board);
    const twice = renderGroups(once.markdown, raw, board);
    expect(twice).toEqual(once);
    expect(groupNote("Review", "keyboard-focus", [raw["focus-five"]], board))
      .toBe(once.notes[join(dirname(board), "cards", "group-review-keyboard-focus.md")]);
    expect(run(["stamp", "T5", ...args(board, tasks)]).code).toBe(0);
    const first = [readFileSync(board, "utf8"),
      readFileSync(join(dirname(board), "cards", "group-review-keyboard-focus.md"), "utf8")];
    expect(run(["stamp", "T5", ...args(board, tasks)]).code).toBe(0);
    expect([readFileSync(board, "utf8"),
      readFileSync(join(dirname(board), "cards", "group-review-keyboard-focus.md"), "utf8")])
      .toEqual(first);
  });
});

test("init refuses a non-empty file and leaves it untouched", () => {
  const existing = "---\nkanban-plugin: board\n---\n\n## todo\n\n- [ ] hand written\n";
  const p = boardPath(existing);
  const r = run(["init", "--board", p]);
  expect(r.code).toBe(1);
  expect(readFileSync(p, "utf8")).toBe(existing);
});

test("upsert adds a card under the named column", () => {
  const p = boardPath("");
  run(["init", "--board", p]);
  expect(run(["upsert", "reset-button", "--column", "todo", "--title", "Reset button greys out", "--board", p]).code).toBe(0);
  const md = readFileSync(p, "utf8");
  const todoSection = md.split("## todo")[1]!.split("## ")[0]!;
  expect(todoSection).toContain("- [ ] **Reset button greys out** [[cards/reset-button|details]] #openmarket #low");
});

test("a chart task is tagged #charts, and an absent product still reads #openmarket", () => {
  // The board is shared across products; the tag is the axis it gets sliced on.
  expect(cardLine("hip3", "HIP-3 rows", DEFAULT_BOARD, "low", "chart"))
    .toContain("#charts #low");
  expect(cardLine("hip3", "HIP-3 rows", DEFAULT_BOARD, "low", "chat"))
    .toContain("#openmarket #low");
  // Every task predating the product field is chat — absent must not fall
  // through to an untagged or chart card.
  expect(cardLine("hip3", "HIP-3 rows", DEFAULT_BOARD, "low"))
    .toContain("#openmarket #low");
});

test("upsert again moves the card without duplicating it, preserving hand cards and the settings trailer", () => {
  const p = boardPath("");
  run(["init", "--board", p]);
  run(["upsert", "reset-button", "--column", "todo", "--title", "Reset button greys out", "--board", p]);
  // Nicholas adds a card by hand and the plugin appends its settings trailer
  const withExtras = readFileSync(p, "utf8")
    .replace("## Done", "## Done\n\n- [ ] a card Nicholas wrote by hand\n")
    + "\n%% kanban:settings\n```\n{\"kanban-plugin\":\"board\"}\n```\n%%\n";
  writeFileSync(p, withExtras);

  writeNote(p, "reset-button");
  expect(run(["upsert", "reset-button", "--column", "Review", "--board", p]).code).toBe(0);
  const md = readFileSync(p, "utf8");
  expect(md.match(/cards\/reset-button\|/g)).toHaveLength(1);
  expect(md.split("## Review")[1]!.split("\n## ")[0]).toContain("[[cards/reset-button|details]]");
  expect(md.split("## todo")[1]!.split("\n## ")[0]).not.toContain("cards/reset-button");
  expect(md).toContain("- [ ] a card Nicholas wrote by hand");
  expect(md).toContain("%% kanban:settings");
  expect(md).toContain('{"kanban-plugin":"board"}');
  // a move with no --title keeps the original card text
  expect(md).toContain("**Reset button greys out**");
});

test("slugs that collide as substrings do not cross-match", () => {
  const p = boardPath("");
  run(["init", "--board", p]);
  run(["upsert", "search", "--column", "todo", "--title", "Search bug", "--board", p]);
  run(["upsert", "search-filter", "--column", "todo", "--title", "Search filter bug", "--board", p]);
  writeNote(p, "search");
  run(["upsert", "search", "--column", "Review", "--board", p]);
  const md = readFileSync(p, "utf8");
  expect(md.split("## Review")[1]!.split("\n## ")[0]).toContain("[[cards/search|details]]");
  expect(md.split("## todo")[1]!.split("\n## ")[0]).toContain("[[cards/search-filter|details]]");
  expect(md.split("## todo")[1]!.split("\n## ")[0]).not.toContain("[[cards/search|details]]");
});

test("moveCard is pure and byte-preserving for unrelated lines", () => {
  const before = [
    "---", "", "kanban-plugin: board", "", "---", "",
    "## todo", "", "- [ ] **A** [[cards/a|details]] #om-bug-loop", "- [ ] untouched hand card", "",
    "## Review", "", "",
    "%% kanban:settings", "```", "{}", "```", "%%", "",
  ].join("\n");
  const after = moveCard(before, "a", "Review");
  expect(after).toContain("- [ ] untouched hand card");
  expect(after.split("## Review")[1]).toContain("[[cards/a|details]]");
  expect(after.split("## todo")[1]!.split("## Review")[0]).not.toContain("cards/a");
  expect(after).toContain("%% kanban:settings");
  expect(moveCard(after, "a", "Review")).toBe(after); // idempotent
});

// Regression (2026-09-01, found live): wikilinks resolve from the VAULT ROOT,
// so a bare `cards/<slug>` was a dead link that would create the note outside
// the kanban folder. Cards must carry the vault-relative path.
describe("vault-relative card links", () => {
  test("emits the vault-relative path when the board is inside a vault", () => {
    const vault = mkdtempSync(join(tmpdir(), "vault-"));
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    const board = join(vault, "kanban", "Kanban.md");
    mkdirSync(dirname(board), { recursive: true });
    writeFileSync(board, SKELETON);
    const after = moveCard(SKELETON, "my-bug", "todo", "My bug", board);
    expect(after).toContain("[[kanban/cards/my-bug|details]]");
  });

  test("falls back to the bare form outside a vault", () => {
    const board = join(mkdtempSync(join(tmpdir(), "novault-")), "Kanban.md");
    expect(moveCard(SKELETON, "my-bug", "todo", "My bug", board))
      .toContain("[[cards/my-bug|details]]");
  });

  test("a card written in the old bare form is still matched and moved", () => {
    const old = SKELETON.replace("## todo\n",
      "## todo\n- [ ] **Old** [[cards/legacy|details]] #om-bug-loop\n");
    const after = moveCard(old, "legacy", "Review");
    const lines = after.split("\n");
    const idx = lines.findIndex(l => l.includes("cards/legacy|"));
    expect(lines.slice(0, idx).reverse().find(l => l.startsWith("## "))).toBe("## Review");
    expect(after.match(/cards\/legacy\|/g)).toHaveLength(1);
  });

  test("the skeleton carries the plugin's settings trailer", () => {
    expect(SKELETON).toContain("%% kanban:settings");
    expect(SKELETON).toContain('{"kanban-plugin":"board"}');
  });
});

// Regression (2026-09-01, found live TWICE): a card reached the digest column
// while its note was missing, then again while its note was a 0-byte file
// Obsidian had created from a dead-link click. The board's review columns
// promise a readable note, so the TOOL enforces it — prose in the playbook did
// not hold. The column was `todo review` then and is `in progress` now (the
// approval stop was removed 2026-09-11); the promise, and this test, are the
// same either way.
describe("review columns require a real note", () => {
  function vaultBoard(): string {
    const vault = mkdtempSync(join(tmpdir(), "vault-"));
    dirs.push(vault);
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    const board = join(vault, "kanban", "Kanban.md");
    mkdirSync(join(dirname(board), "cards"), { recursive: true });
    writeFileSync(board, SKELETON);
    return board;
  }

  test("missing note blocks the move", () => {
    expect(noteProblem(vaultBoard(), "my-bug", "in progress")).toMatch(/no card note/);
  });

  test("a 0-byte note Obsidian created still blocks the move", () => {
    const board = vaultBoard();
    writeFileSync(join(dirname(board), "cards", "my-bug.md"), "");
    expect(noteProblem(board, "my-bug", "in progress")).toMatch(/empty or a stub/);
  });

  test("a real note passes, for every review column", () => {
    const board = vaultBoard();
    writeFileSync(join(dirname(board), "cards", "my-bug.md"),
      "# My bug\n\n## Problem\n\n" + "Enough prose to be a genuine note. ".repeat(4) +
      "\n\n![[kanban/evidence/my-bug/after.png]]\n");
    expect(noteProblem(board, "my-bug", "in progress")).toBeNull();
    expect(noteProblem(board, "my-bug", "Review")).toBeNull();
  });

  test("columns that promise nothing are never blocked", () => {
    const board = vaultBoard();
    for (const col of ["todo", "Need Attention", "Done", "Withdrawn"]) {
      expect(noteProblem(board, "my-bug", col)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Live card notes (2026-09-01). A note written once is a note that lies: this
// pipeline has already shipped two versions of "the card promises a note that
// isn't there". Timing and status are therefore MACHINE-owned — recorded in
// tasks.json, re-rendered into the note on every transition — and never left
// to an agent to remember.
// ---------------------------------------------------------------------------
import {
  MARK_END, MARK_START, STAGES, cardNotePath, checkItem, humanDuration,
  recordStage, stampNote, statusBlock,
} from "./kanban";

/** A vault-shaped board with a cards/ dir — what stamping and `check` need. */
function vault(): { board: string; cards: string } {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  dirs.push(v);
  mkdirSync(join(v, ".obsidian"), { recursive: true });
  const board = join(v, "kanban", "Kanban.md");
  const cards = join(dirname(board), "cards");
  mkdirSync(cards, { recursive: true });
  writeFileSync(board, SKELETON);
  return { board, cards };
}

/** Independent re-implementation of the local-time format, so the assertions
 *  do not simply echo the code under test — and no test ever calls Date.now(). */
const p2 = (n: number) => String(n).padStart(2, "0");
function localHM(iso: string): string {
  const d = new Date(iso);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function localStamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${localHM(iso)}`;
}

const T = {
  detected: "2026-09-01T04:48:54.337Z",
  investigating: "2026-09-01T04:59:03.000Z",
  approval: "2026-09-01T05:08:31.000Z",
  implementing: "2026-09-01T06:47:49.000Z",
  now: "2026-09-01T07:16:00.000Z",
} as const;

const liveTask = () => ({
  id: 6658, slug: "reset-button-greyed-out", status: "implementing",
  repo: "openmarket-chat", branch: "om-bug-loop/reset-button-greyed-out",
  mrUrl: null, seenAt: T.detected,
  stages: {
    detected: T.detected, investigating: T.investigating,
    planned: T.approval, implementing: T.implementing,
  } as Record<string, string>,
});

describe("human durations", () => {
  test("renders seconds, minutes, hours and days in the house style", () => {
    expect(humanDuration(0)).toBe("0s");
    expect(humanDuration(45_000)).toBe("45s");
    expect(humanDuration(59_999)).toBe("59s");
    expect(humanDuration(16 * 60_000)).toBe("16m");
    expect(humanDuration(64 * 60_000)).toBe("1h 04m");
    expect(humanDuration(3 * 3600_000 + 25 * 60_000)).toBe("3h 25m");
    expect(humanDuration(51 * 3600_000)).toBe("2d 03h");
    expect(humanDuration(-5_000)).toBe("0s"); // a clock skew must not print "-5s"
  });
});

describe("the machine-owned status block", () => {
  test("header omits the fields that are null", () => {
    const t = liveTask();
    const withAll = statusBlock({ ...t, mrUrl: "https://example.invalid/mr/1" }, T.now);
    expect(withAll).toContain("**Status** implementing");
    expect(withAll).toContain("**To-do** 6658");
    expect(withAll).toContain("**Repo** openmarket-chat");
    expect(withAll).toContain("**Branch** om-bug-loop/reset-button-greyed-out");
    expect(withAll).toContain("**MR** https://example.invalid/mr/1");

    const bare = statusBlock({ ...t, branch: null, mrUrl: null, repo: null }, T.now);
    expect(bare).toContain("**Status** implementing");
    expect(bare).not.toContain("**MR**");
    expect(bare).not.toContain("**Branch**");
    expect(bare).not.toContain("**Repo**");
  });

  test("detected / started / elapsed are computed from the recorded stamps", () => {
    const block = statusBlock(liveTask(), T.now);
    expect(block).toContain(`**Detected** ${localStamp(T.detected)}`);
    expect(block).toContain(`**Started** ${localStamp(T.investigating)}`);
    // 04:48:54Z → 07:16:00Z = 2h 27m 06s
    expect(block).toContain("**Elapsed** 2h 27m");
  });

  test("the timeline checks off finished stages with their span and duration", () => {
    const block = statusBlock(liveTask(), T.now);
    expect(block).toContain(
      `- [x] detected — ${localHM(T.detected)} → ${localHM(T.investigating)} (10m)`);
    expect(block).toContain(
      `- [x] investigated — ${localHM(T.investigating)} → ${localHM(T.approval)} (9m)`);
    expect(block).toContain(
      `- [x] planned — ${localHM(T.approval)} → ${localHM(T.implementing)} (1h 39m)`);
  });

  test("the current stage is in progress, and future stages are bare", () => {
    const block = statusBlock(liveTask(), T.now);
    expect(block).toContain(`- [ ] implementing — started ${localHM(T.implementing)} (in progress)`);
    expect(block).toContain("- [ ] reviewing\n");
    expect(block).toContain("- [ ] shipped\n");
    expect(block).not.toContain("- [x] reviewing");
    // one line per stage, no more and no fewer
    expect(block.match(/^- \[[ x]\] /gm)).toHaveLength(STAGES.length);
  });

  test("a shipped task freezes its elapsed at the shipped stamp", () => {
    const t = liveTask();
    t.status = "shipped";
    t.stages.reviewing = "2026-09-01T07:00:00.000Z";
    t.stages.shipped = "2026-09-01T07:30:00.000Z";
    // "now" is a day later; elapsed must NOT move.
    const block = statusBlock(t, "2026-09-02T07:30:00.000Z");
    expect(block).toContain("**Elapsed** 2h 41m"); // 04:48:54Z → 07:30:00Z
    expect(block).toContain(`- [x] shipped — ${localHM(t.stages.shipped)}`);
    expect(block).not.toContain("in progress");
    expect(statusBlock(t, "2026-09-05T00:00:00.000Z")).toBe(block); // frozen
  });

  test("a task with no stages yet still renders a legible skeleton", () => {
    const block = statusBlock(
      { id: 1, slug: "x", status: "new", stages: {}, seenAt: T.detected }, T.now);
    expect(block.match(/^- \[ \] /gm)).toHaveLength(STAGES.length);
    expect(block).toContain(`**Detected** ${localStamp(T.detected)}`); // seenAt is the fallback
  });

  test("the block is fenced by the markers so a re-stamp can find it", () => {
    const block = statusBlock(liveTask(), T.now);
    expect(block.startsWith(MARK_START)).toBe(true);
    expect(block.trimEnd().endsWith(MARK_END)).toBe(true);
  });

  test("the product lane renders, and is absent on entries that predate it", () => {
    const t = liveTask();
    const chart = statusBlock({ ...t, product: "chart", repo: "kiyotaka-frontend" }, T.now);
    expect(chart).toContain("**Product** chart");
    expect(chart).toContain("**Repo** kiyotaka-frontend");
    // The lane is read BEFORE the repo: which product a task is in explains
    // which repos are even possible, so it cannot come second.
    expect(chart.indexOf("**Product**")).toBeLessThan(chart.indexOf("**Repo**"));

    // An entry written before multi-product has no product. It renders without
    // the field rather than guessing — the same tolerance `ref` already has.
    expect(statusBlock(t, T.now)).not.toContain("**Product**");

    // The block is regenerated wholesale on every transition, so the lane has
    // to survive a re-stamp byte-for-byte — a field that drifts between two
    // renders of the same task is worse than no field.
    expect(statusBlock({ ...t, product: "chart", repo: "kiyotaka-frontend" }, T.now))
      .toBe(chart);
  });

  test("a backlog card carries its product lane too", () => {
    const block = statusBlock({ ...liveTask(), status: "backlog", product: "chart" }, T.now);
    expect(block).toContain("**Status** backlog");
    expect(block).toContain("**Product** chart");
    // Still no clock on a backlog card — the lane must not have revived one.
    expect(block).not.toContain("**Elapsed**");
  });
});

describe("stamping a note", () => {
  const PROSE = [
    "# Upload-too-large leaves Reset button greyed out",
    "",
    "## Problem",
    "",
    "Trailing prose that must survive byte-for-byte, including a table:",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "![[kanban/evidence/x/repro.png]]",
    "",
  ].join("\n");

  test("inserts the block after the H1, never above it", () => {
    const out = stampNote(PROSE, statusBlock(liveTask(), T.now));
    expect(out.split("\n")[0]).toBe("# Upload-too-large leaves Reset button greyed out");
    expect(out.indexOf(MARK_START)).toBeGreaterThan(0);
    expect(out.indexOf(MARK_START)).toBeLessThan(out.indexOf("## Problem"));
  });

  test("a second stamp rewrites only between the markers", () => {
    const once = stampNote(PROSE, statusBlock(liveTask(), T.now));
    const later = statusBlock(liveTask(), "2026-09-01T09:00:00.000Z");
    const twice = stampNote(once, later);

    const head = (s: string) => s.slice(0, s.indexOf(MARK_START));
    const tail = (s: string) => s.slice(s.indexOf(MARK_END) + MARK_END.length);
    expect(head(twice)).toBe(head(once));
    expect(tail(twice)).toBe(tail(once));
    expect(twice).toContain("**Elapsed** 4h 11m");
    expect(twice).not.toContain("**Elapsed** 2h 27m");
    // exactly one block — a re-stamp must never nest or duplicate
    expect(twice.match(new RegExp(MARK_START, "g"))).toHaveLength(1);
    expect(twice).toContain("| 1 | 2 |");
    expect(twice).toContain("![[kanban/evidence/x/repro.png]]");
  });

  test("re-stamping with an identical block is a byte-for-byte no-op", () => {
    const b = statusBlock(liveTask(), T.now);
    const once = stampNote(PROSE, b);
    expect(stampNote(once, b)).toBe(once);
  });

  test("a note with no H1 gets the block at the top", () => {
    const out = stampNote("no title here\n", statusBlock(liveTask(), T.now));
    expect(out.startsWith(MARK_START)).toBe(true);
    expect(out).toContain("no title here");
  });

  test("cardNotePath resolves beside the board", () => {
    const { board, cards } = vault();
    expect(cardNotePath(board, "my-bug")).toBe(join(cards, "my-bug.md"));
  });
});

describe("stages are append-only", () => {
  test("an existing stamp is never rewritten, so a re-run cannot erase when work began", () => {
    const tasks = { a: { slug: "a", status: "investigating", stages: { detected: T.detected } } };
    const once = recordStage(tasks, "a", "detected", T.now);
    expect(once.a!.stages.detected).toBe(T.detected); // NOT T.now
    const twice = recordStage(once, "a", "investigating", T.investigating);
    expect(twice.a!.stages.investigating).toBe(T.investigating);
    expect(recordStage(twice, "a", "investigating", T.now).a!.stages.investigating)
      .toBe(T.investigating);
  });

  test("status only ever moves forward through the pipeline", () => {
    const tasks = {
      a: { slug: "a", status: "reviewing", stages: { detected: T.detected } },
    };
    // a stale re-run of an earlier column must not regress the status
    expect(recordStage(tasks, "a", "implementing", T.now).a!.status).toBe("reviewing");
    expect(recordStage(tasks, "a", "shipped", T.now).a!.status).toBe("shipped");
  });

  test("an unknown slug is left alone — this tool never invents task entries", () => {
    const tasks = { a: { slug: "a", status: "new", stages: {} } };
    expect(recordStage(tasks, "ghost", "detected", T.now)).toEqual(tasks);
  });
});

describe("check — the task owner ticks its own work items", () => {
  const NOTE = [
    "# A bug", "",
    MARK_START, "**Status** implementing", MARK_END, "",
    "## Work items", "",
    "- [ ] `NotificationTones.tsx` — enable Reset while the slot has an error",
    "- [ ] `settings.css` — let the alert take its own line",
    "- [ ] `settings.css` — drop the stray margin",
    "- [ ] Parity port to openmarket-chat-cloud",
    "",
    "## Findings", "",
    "- [ ] not a work item, and must never be ticked by `check`",
    "",
  ].join("\n");

  test("ticks the one item whose text matches", () => {
    const out = checkItem(NOTE, "Parity port", true);
    expect(out).toContain("- [x] Parity port to openmarket-chat-cloud");
    expect(out).toContain("- [ ] `settings.css` — let the alert take its own line");
    expect(out).toContain("- [ ] not a work item"); // Findings untouched
  });

  test("unticks again", () => {
    const ticked = checkItem(NOTE, "Parity port", true);
    expect(checkItem(ticked, "Parity port", false)).toBe(NOTE);
  });

  test("refuses an ambiguous match and lists the candidates", () => {
    expect(() => checkItem(NOTE, "settings.css", true)).toThrow(/ambiguous/i);
    try { checkItem(NOTE, "settings.css", true); } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).toContain("let the alert take its own line");
      expect(msg).toContain("drop the stray margin");
      expect(msg).not.toContain("Parity port");
    }
  });

  test("refuses a no-match and lists what is actually there", () => {
    expect(() => checkItem(NOTE, "nonexistent step", true)).toThrow(/no work item/i);
    try { checkItem(NOTE, "nonexistent step", true); } catch (e) {
      expect(String((e as Error).message)).toContain("Parity port to openmarket-chat-cloud");
    }
  });

  test("refuses a note with no Work items section", () => {
    expect(() => checkItem("# A bug\n\n## Problem\n\nprose\n", "anything", true))
      .toThrow(/## Work items/);
  });

  test("a card note ticked to completion still passes the note guard", () => {
    const { board, cards } = vault();
    writeFileSync(join(cards, "b.md"),
      checkItem(NOTE, "Parity port", true) + "\n![[kanban/evidence/b/after.png]]\n");
    expect(noteProblem(board, "b", "Review")).toBeNull();
  });
});

describe("upsert re-stamps on every transition", () => {
  /** A board plus the coordinator's tasks.json — the single source of truth. */
  function live(stages: Record<string, string>, status = "implementing") {
    const { board, cards } = vault();
    const tasks = join(dirname(board), "tasks.json");
    writeFileSync(tasks, JSON.stringify({
      "my-bug": {
        id: 42, slug: "my-bug", status, repo: "openmarket-chat",
        branch: "om-bug-loop/my-bug", mrUrl: null, seenAt: T.detected, stages,
      },
    }));
    return { board, cards, tasks };
  }
  const body = "# My bug\n\n## Problem\n\n" + "Enough prose to be a genuine note. ".repeat(4);

  test("a move refreshes the note the card points at", () => {
    const { board, cards, tasks } = live({ detected: T.detected, investigating: T.investigating });
    writeFileSync(join(cards, "my-bug.md"), body);
    const r = run(["upsert", "my-bug", "--column", "in progress",
      "--board", board, "--tasks", tasks, "--now", T.now]);
    expect(r.code).toBe(0);
    const note = readFileSync(join(cards, "my-bug.md"), "utf8");
    expect(note).toContain(MARK_START);
    expect(note).toContain("**Detected**");
    expect(note.split("\n")[0]).toBe("# My bug");
    expect(note).toContain("## Problem"); // the body survived
  });

  test("the move also records the column's stage, append-only", () => {
    const { board, cards, tasks } = live({ detected: T.detected, investigating: T.investigating });
    writeFileSync(join(cards, "my-bug.md"), body);
    run(["upsert", "my-bug", "--column", "in progress",
      "--board", board, "--tasks", tasks, "--now", T.now]);
    const after = JSON.parse(readFileSync(tasks, "utf8"));
    expect(after["my-bug"].stages["planned"]).toBe(T.now);
    expect(after["my-bug"].stages.detected).toBe(T.detected); // untouched
    // re-running the same move must not re-stamp the stage
    run(["upsert", "my-bug", "--column", "in progress",
      "--board", board, "--tasks", tasks, "--now", "2026-09-02T00:00:00.000Z"]);
    expect(JSON.parse(readFileSync(tasks, "utf8"))["my-bug"].stages["planned"])
      .toBe(T.now);
  });

  test("stays silent when the note does not exist yet — `todo` precedes the note", () => {
    const { board, cards, tasks } = live({});
    const r = run(["upsert", "my-bug", "--column", "todo",
      "--board", board, "--tasks", tasks, "--now", T.now]);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(existsSync(join(cards, "my-bug.md"))).toBe(false);
  });

  test("--no-stamp leaves the note alone", () => {
    const { board, cards, tasks } = live({ detected: T.detected });
    writeFileSync(join(cards, "my-bug.md"), body);
    run(["upsert", "my-bug", "--column", "in progress", "--no-stamp",
      "--board", board, "--tasks", tasks, "--now", T.now]);
    expect(readFileSync(join(cards, "my-bug.md"), "utf8")).toBe(body);
  });

  test("the CLI stamp command is idempotent on a settled task", () => {
    const { board, cards, tasks } = live({
      detected: T.detected, investigating: T.investigating,
      planned: T.approval, implementing: T.implementing,
      reviewing: "2026-09-01T07:00:00.000Z", shipped: "2026-09-01T07:30:00.000Z",
    }, "shipped");
    writeFileSync(join(cards, "my-bug.md"), body);
    run(["stamp", "my-bug", "--board", board, "--tasks", tasks, "--now", T.now]);
    const first = readFileSync(join(cards, "my-bug.md"), "utf8");
    run(["stamp", "my-bug", "--board", board, "--tasks", tasks,
      "--now", "2026-09-09T00:00:00.000Z"]);
    expect(readFileSync(join(cards, "my-bug.md"), "utf8")).toBe(first);
  });

  test("the CLI stage command records a stage no column implies", () => {
    const { board, cards, tasks } = live({ detected: T.detected }, "new");
    writeFileSync(join(cards, "my-bug.md"), body);
    // `investigating` and `reviewing` have no column of their own, so a stage
    // the board cannot infer still has to be recordable.
    expect(run(["stage", "my-bug", "investigating",
      "--board", board, "--tasks", tasks, "--now", T.investigating]).code).toBe(0);
    const after = JSON.parse(readFileSync(tasks, "utf8"))["my-bug"];
    expect(after.stages.investigating).toBe(T.investigating);
    expect(after.status).toBe("investigating");
    expect(readFileSync(join(cards, "my-bug.md"), "utf8")).toContain("**Detected**");
    // an unknown stage name, and an unknown slug, both refuse
    expect(run(["stage", "my-bug", "teleporting", "--board", board, "--tasks", tasks]).code)
      .not.toBe(0);
    const ghost = run(["stage", "ghost", "investigating", "--board", board, "--tasks", tasks]);
    expect(ghost.code).not.toBe(0);
    expect(ghost.err).toMatch(/no entry/);
  });

  test("the CLI check command ticks an item in a real note", () => {
    const { board, cards, tasks } = live({ detected: T.detected });
    writeFileSync(join(cards, "my-bug.md"),
      body + "\n\n## Work items\n\n- [ ] first step\n- [ ] second step\n");
    const r = run(["check", "my-bug", "--item", "second", "--board", board, "--tasks", tasks]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(cards, "my-bug.md"), "utf8")).toContain("- [x] second step");
    const bad = run(["check", "my-bug", "--item", "step", "--board", board, "--tasks", tasks]);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toMatch(/ambiguous/i);
  });
});

// ---------------------------------------------------------------------------
// Short refs (2026-09-01). Nicholas approves tasks by saying "ok T5", never by
// typing a slug, so `T5` has to be a first-class handle: accepted anywhere a
// slug is, rendered first in the status block, and NEVER reused — a recycled
// ref would silently re-point an approval he already gave.
// ---------------------------------------------------------------------------
import { boardCardRef, knownRefs, listRows, nextRef, readBoardCards, resolveRef } from "./kanban";

/** A vault + a tasks.json carrying refs — the shape every ref test needs. */
function refVault(tasks: Record<string, unknown>): {
  board: string; cards: string; tasksPath: string;
} {
  const { board, cards } = vault();
  const tasksPath = join(dirname(board), "tasks.json");
  writeFileSync(tasksPath, JSON.stringify(tasks, null, 1));
  return { board, cards, tasksPath };
}

const refTasks = () => ({
  "alpha-bug": {
    id: 1, slug: "alpha-bug", ref: "T1", status: "shipped", repo: "openmarket-chat",
    seenAt: T.detected, stages: { detected: T.detected, shipped: T.now },
  },
  "beta-bug": {
    id: null, slug: "beta-bug", ref: "T2", status: "awaiting-approval",
    repo: "openmarket-chat", seenAt: T.detected,
    stages: { detected: T.detected, "awaiting-approval": T.approval },
  },
});

describe("resolveRef — a ref is a handle, and a wrong one must never resolve", () => {
  test("a ref resolves to its slug", () => {
    const { tasksPath } = refVault(refTasks());
    expect(resolveRef("T2", tasksPath)).toBe("beta-bug");
  });

  test("the ref is case-insensitive — Nicholas types t5 as often as T5", () => {
    const { tasksPath } = refVault(refTasks());
    expect(resolveRef("t2", tasksPath)).toBe("beta-bug");
    expect(resolveRef("T2", tasksPath)).toBe(resolveRef("t2", tasksPath));
  });

  test("a slug resolves to itself, known or not", () => {
    const { tasksPath } = refVault(refTasks());
    expect(resolveRef("beta-bug", tasksPath)).toBe("beta-bug");
    // an unknown slug passes through untouched: the COMMAND reports it (with
    // the message that fits it), and `upsert` legitimately precedes the entry.
    expect(resolveRef("brand-new-bug", tasksPath)).toBe("brand-new-bug");
  });

  test("an unknown ref throws and lists every known ref with its title", () => {
    const { board, tasksPath } = refVault(refTasks());
    run(["upsert", "alpha-bug", "--column", "todo", "--title", "T1 · Alpha breaks",
      "--board", board, "--tasks", tasksPath, "--now", T.now]);
    expect(() => resolveRef("T9", tasksPath, board)).toThrow(/unknown task ref/i);
    try { resolveRef("T9", tasksPath, board); } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).toContain("T1");
      expect(msg).toContain("alpha-bug");
      expect(msg).toContain("Alpha breaks"); // the title, so he can see what he meant
      expect(msg).toContain("T2");
      expect(msg).toContain("beta-bug");
    }
  });

  test("knownRefs is ordered numerically, not lexically (T10 after T9)", () => {
    const { tasksPath } = refVault({
      a: { slug: "a", ref: "T9", status: "new" },
      b: { slug: "b", ref: "T10", status: "new" },
      c: { slug: "c", ref: "T2", status: "new" },
    });
    expect(knownRefs(tasksPath).map(r => r.ref)).toEqual(["T2", "T9", "T10"]);
  });

  test("a task predating refs is simply absent, and breaks nothing", () => {
    const { tasksPath } = refVault({ old: { slug: "old", status: "new" } });
    expect(knownRefs(tasksPath)).toEqual([]);
    expect(resolveRef("old", tasksPath)).toBe("old");
  });
});

describe("nextRef — refs are permanent and are never reused", () => {
  test("skips the gap a deleted task left behind", () => {
    // T1, T2, T3 assigned; T2 deleted. The next ref is T4 — NOT T3, which
    // would silently re-point an approval Nicholas already gave to the old T3.
    const { tasksPath } = refVault({
      a: { slug: "a", ref: "T1", status: "shipped" },
      c: { slug: "c", ref: "T3", status: "new" },
    });
    expect(nextRef(tasksPath)).toBe("T4");
  });

  test("the first task of an empty pipeline is T1", () => {
    const { tasksPath } = refVault({});
    expect(nextRef(tasksPath)).toBe("T1");
  });

  test("entries with no ref do not count toward the maximum", () => {
    const { tasksPath } = refVault({
      old: { slug: "old", status: "new" },
      a: { slug: "a", ref: "T7", status: "new" },
    });
    expect(nextRef(tasksPath)).toBe("T8");
  });

  test("the CLI exposes it so the coordinator can assign one", () => {
    const { board, tasksPath } = refVault(refTasks());
    const r = run(["next-ref", "--tasks", tasksPath, "--board", board]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("T3");
  });
});

// ---------------------------------------------------------------------------
// The R namespace (2026-09-11). `om-research` answers a different KIND of
// question than `om-task` and ends somewhere different — a filed architecture
// doc and a decision, not a merged MR. The letter is what makes that visible
// on a board where both live, so the two counters must never see each other.
// ---------------------------------------------------------------------------
describe("the R namespace — research refs are counted separately from tasks", () => {
  test("an empty pipeline issues R1, not R-after-the-last-T", () => {
    const { tasksPath } = refVault({
      a: { slug: "a", ref: "T7", status: "shipped" },
      b: { slug: "b", ref: "T8", status: "new" },
    });
    // Eight tasks captured and not one research item: the first R is still R1.
    expect(nextRef(tasksPath, "R")).toBe("R1");
  });

  test("capturing research never consumes a task number, or the reverse", () => {
    const { tasksPath } = refVault({
      a: { slug: "a", ref: "T3", status: "shipped" },
      r: { slug: "r", ref: "R1", status: "researched" },
      s: { slug: "s", ref: "R2", status: "new" },
    });
    expect(nextRef(tasksPath, "T")).toBe("T4");
    expect(nextRef(tasksPath, "R")).toBe("R3");
  });

  test("the default prefix is still T — every existing caller is untouched", () => {
    const { tasksPath } = refVault(refTasks());
    expect(nextRef(tasksPath)).toBe(nextRef(tasksPath, "T"));
  });

  test("--research is what the CLI routes on", () => {
    const { board, tasksPath } = refVault({ r: { slug: "r", ref: "R4", status: "new" } });
    const iso = ["--tasks", tasksPath, "--board", board];
    expect(run(["next-ref", ...iso]).out.trim()).toBe("T1");
    expect(run(["next-ref", "--research", ...iso]).out.trim()).toBe("R5");
  });

  test("an R ref resolves to its slug, case-insensitively, like a T ref", () => {
    const { tasksPath } = refVault({
      r: { slug: "copy-link-affordance", ref: "R1", status: "new" },
    });
    expect(resolveRef("R1", tasksPath)).toBe("copy-link-affordance");
    expect(resolveRef("r1", tasksPath)).toBe("copy-link-affordance");
  });

  test("an unknown R ref throws rather than resolving to a near neighbour", () => {
    const { tasksPath } = refVault({ r: { slug: "r", ref: "R1", status: "new" } });
    expect(() => resolveRef("R9", tasksPath)).toThrow(/unknown task ref/i);
  });

  test("a burned R number stays burned, exactly as a burned T does", () => {
    // R2 withdrawn. R3 is next — reusing R2 would re-point a decision Nicholas
    // already made against the old R2's doc.
    const { tasksPath } = refVault({
      a: { slug: "a", ref: "R1", status: "researched" },
      c: { slug: "c", ref: "R3", status: "new" },
    });
    expect(nextRef(tasksPath, "R")).toBe("R4");
  });

  test("knownRefs keeps each namespace contiguous, numeric within it", () => {
    const { tasksPath } = refVault({
      a: { slug: "a", ref: "R2", status: "new" },
      b: { slug: "b", ref: "T10", status: "new" },
      c: { slug: "c", ref: "R10", status: "new" },
      d: { slug: "d", ref: "T9", status: "new" },
    });
    // T block first and numerically ordered, then the R block — never one
    // interleaved run, which is how a mixed board becomes unreadable.
    expect(knownRefs(tasksPath).map(r => r.ref)).toEqual(["T9", "T10", "R2", "R10"]);
  });

  test("a research task's elapsed clock stops when its doc is filed", () => {
    // `researched` is as terminal as `shipped`: the work is over, so the card
    // must stop growing a bigger number every time anything re-stamps it.
    const block = statusBlock(
      { slug: "r", ref: "R1", status: "researched",
        stages: { detected: T.detected, investigating: T.approval } },
      T.now);
    const later = statusBlock(
      { slug: "r", ref: "R1", status: "researched",
        stages: { detected: T.detected, investigating: T.approval } },
      new Date(Date.parse(T.now) + 86_400_000).toISOString());
    expect(block).toBe(later);
  });
});

// ---------------------------------------------------------------------------
// The F namespace (2026-09-11). A feature and a defect both end in a merged MR,
// so the letter is the only thing on the board that says which plan shape the
// card carries — a root cause and repro steps, or a user flow and acceptance
// criteria. Three counters, none of which can consume another's numbers.
// ---------------------------------------------------------------------------
describe("the F namespace — features counted apart from tasks and research", () => {
  test("three lanes, three independent counters", () => {
    const { tasksPath } = refVault({
      a: { slug: "a", ref: "T12", status: "shipped" },
      b: { slug: "b", ref: "R3", status: "researched" },
      c: { slug: "c", ref: "F1", status: "shipped" },
    });
    expect(nextRef(tasksPath, "T")).toBe("T13");
    expect(nextRef(tasksPath, "R")).toBe("R4");
    expect(nextRef(tasksPath, "F")).toBe("F2");
  });

  test("a board full of tasks still issues F1 for the first feature", () => {
    const { tasksPath } = refVault({
      a: { slug: "a", ref: "T88", status: "shipped" },
      b: { slug: "b", ref: "T90", status: "new" },
    });
    expect(nextRef(tasksPath, "F")).toBe("F1");
  });

  test("--feature is what the CLI routes on, and it beats no flag", () => {
    const { board, tasksPath } = refVault({ f: { slug: "f", ref: "F6", status: "new" } });
    const iso = ["--tasks", tasksPath, "--board", board];
    expect(run(["next-ref", ...iso]).out.trim()).toBe("T1");
    expect(run(["next-ref", "--feature", ...iso]).out.trim()).toBe("F7");
  });

  test("an F ref resolves to its slug, case-insensitively", () => {
    const { tasksPath } = refVault({
      f: { slug: "message-permalinks", ref: "F1", status: "new" },
    });
    expect(resolveRef("F1", tasksPath)).toBe("message-permalinks");
    expect(resolveRef("f1", tasksPath)).toBe("message-permalinks");
  });

  test("an unknown F ref throws and lists what does exist", () => {
    const { tasksPath } = refVault({ f: { slug: "f", ref: "F1", status: "new" } });
    expect(() => resolveRef("F9", tasksPath)).toThrow(/unknown task ref/i);
  });

  test("a burned F number stays burned", () => {
    const { tasksPath } = refVault({
      a: { slug: "a", ref: "F1", status: "shipped" },
      c: { slug: "c", ref: "F4", status: "new" },
    });
    expect(nextRef(tasksPath, "F")).toBe("F5");
  });

  test("knownRefs keeps all three namespaces contiguous, in declaration order", () => {
    const { tasksPath } = refVault({
      a: { slug: "a", ref: "F2", status: "new" },
      b: { slug: "b", ref: "R10", status: "new" },
      c: { slug: "c", ref: "T3", status: "new" },
      d: { slug: "d", ref: "F10", status: "new" },
      e: { slug: "e", ref: "R2", status: "new" },
      f: { slug: "f", ref: "T30", status: "new" },
    });
    // T block, then R, then F — each numerically ordered within itself. The
    // board is read one lane at a time; an interleaved run is unreadable.
    expect(knownRefs(tasksPath).map(r => r.ref))
      .toEqual(["T3", "T30", "R2", "R10", "F2", "F10"]);
  });

  test("a feature ref renders in the status block like any other", () => {
    const block = statusBlock({ ...liveTask(), ref: "F4" }, T.now);
    expect(block.split("\n")[1]!.startsWith("**F4** ·")).toBe(true);
  });
});

describe("the status block leads with the ref", () => {
  test("the ref is the first thing on the header line", () => {
    const block = statusBlock({ ...liveTask(), ref: "T5" }, T.now);
    const head = block.split("\n")[1]!;
    expect(head.startsWith("**T5** · **Status** implementing")).toBe(true);
    expect(head).toContain("**Repo** openmarket-chat");
  });

  test("a task with no ref renders the old header, unchanged", () => {
    const block = statusBlock(liveTask(), T.now);
    expect(block.split("\n")[1]!.startsWith("**Status** implementing")).toBe(true);
    expect(block).not.toContain("**undefined**");
    expect(block).not.toContain(" · **Status**");
  });
});

describe("every slug-taking command also takes a ref", () => {
  const body = "# Beta bug\n\n## Problem\n\n" + "Enough prose to be a genuine note. ".repeat(4) +
    "\n\n## Reproduction steps\n\n1. Open /rooms from a cold app.\n\n" +
    "**Expected:** The room opens.\n**Actual:** The room stays blank.\n";

  test("upsert moves the card the ref names", () => {
    const { board, cards, tasksPath } = refVault(refTasks());
    writeFileSync(join(cards, "beta-bug.md"), body);
    const r = run(["upsert", "T2", "--column", "in progress", "--title", "T2 · Beta breaks",
      "--board", board, "--tasks", tasksPath, "--now", T.now]);
    expect(r.code).toBe(0);
    expect(readFileSync(board, "utf8")).toContain("[[kanban/cards/beta-bug|details]]");
    expect(readFileSync(join(cards, "beta-bug.md"), "utf8")).toContain("**T2** · **Status**");
  });

  test("note writes the card the ref names", () => {
    const { board, cards, tasksPath } = refVault(refTasks());
    const src = join(dirname(board), "src.md");
    writeFileSync(src, body);
    const r = run(["note", "t2", "--file", src, "--board", board, "--tasks", tasksPath]);
    expect(r.code).toBe(0);
    // `note` writes the BODY and re-stamps: the author supplies prose, the tool
    // owns the status block (see "note preserves the machine-owned block").
    // The block is spliced BETWEEN the H1 and the body, so assert the parts,
    // not one contiguous string.
    const written = readFileSync(join(cards, "beta-bug.md"), "utf8");
    expect(written.startsWith("# Beta bug")).toBe(true);
    expect(written).toContain("Enough prose to be a genuine note.");
    expect(written).toContain("**T2**");
  });

  test("stamp re-renders the note the ref names", () => {
    const { board, cards, tasksPath } = refVault(refTasks());
    writeFileSync(join(cards, "beta-bug.md"), body);
    const r = run(["stamp", "T2", "--board", board, "--tasks", tasksPath, "--now", T.now]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(cards, "beta-bug.md"), "utf8")).toContain("**T2** · **Status**");
  });

  test("stage records against the ref's task", () => {
    const { board, cards, tasksPath } = refVault(refTasks());
    writeFileSync(join(cards, "beta-bug.md"), body);
    const r = run(["stage", "T2", "implementing",
      "--board", board, "--tasks", tasksPath, "--now", T.implementing]);
    expect(r.code).toBe(0);
    const after = JSON.parse(readFileSync(tasksPath, "utf8"))["beta-bug"];
    expect(after.stages.implementing).toBe(T.implementing);
    expect(after.ref).toBe("T2"); // the ref survives a write
  });

  test("check ticks a work item on the ref's note", () => {
    const { board, cards, tasksPath } = refVault(refTasks());
    writeFileSync(join(cards, "beta-bug.md"),
      body + "\n\n## Work items\n\n- [ ] first step\n- [ ] second step\n");
    const r = run(["check", "T2", "--item", "second",
      "--board", board, "--tasks", tasksPath, "--now", T.now]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(cards, "beta-bug.md"), "utf8")).toContain("- [x] second step");
  });

  test("a wrong ref exits non-zero and lists the known refs, on every command", () => {
    const { board, tasksPath } = refVault(refTasks());
    for (const args of [
      ["upsert", "T9", "--column", "todo"],
      ["note", "T9", "--file", board],
      ["stamp", "T9"],
      ["stage", "T9", "implementing"],
      ["check", "T9", "--item", "x"],
    ]) {
      const r = run([...args, "--board", board, "--tasks", tasksPath, "--now", T.now]);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/unknown task ref/i);
      expect(r.err).toContain("T1");
      expect(r.err).toContain("T2");
    }
  });
});

describe("list — what /om-bug-loop status prints", () => {
  test("one line per task, ordered by ref, with the column read from the board", () => {
    const { board, cards, tasksPath } = refVault(refTasks());
    writeFileSync(join(cards, "beta-bug.md"),
      "# Beta\n\n" + "Enough prose to be a genuine note. ".repeat(4) +
      "\n\n## Reproduction steps\n\n1. Open /rooms from a cold app.\n\n" +
      "**Expected:** The room opens.\n**Actual:** The room stays blank.\n" +
      "\n\n![[kanban/evidence/beta-bug/after.png]]\n");
    run(["upsert", "beta-bug", "--column", "in progress", "--title", "T2 · Beta breaks",
      "--board", board, "--tasks", tasksPath, "--now", T.approval]);
    run(["upsert", "alpha-bug", "--column", "Done", "--title", "T1 · Alpha breaks",
      "--board", board, "--tasks", tasksPath, "--now", T.now]);

    const r = run(["list", "--board", board, "--tasks", tasksPath]);
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith("T1")).toBe(true);
    expect(lines[1]!.startsWith("T2")).toBe(true);
    expect(lines[0]).toMatch(/T1\s+shipped\s+alpha-bug\s+Done\s+Alpha breaks/);
    expect(lines[1]).toMatch(/T2\s+planned\s+beta-bug\s+in progress\s+Beta breaks/);
    expect(r.out).not.toContain("drift");
  });

  test("flags a task whose tasks.json status is behind its board column", () => {
    // The board promises "ready to review"; tasks.json says it is still being
    // implemented. One of the two is lying, and a hidden lie is the whole
    // reason this row exists.
    const { board, cards, tasksPath } = refVault(refTasks());
    writeFileSync(join(cards, "beta-bug.md"),
      "# Beta\n\n" + "Enough prose to be a genuine note. ".repeat(4) +
      "\n\n## Reproduction steps\n\n1. Open /rooms from a cold app.\n\n" +
      "**Expected:** The room opens.\n**Actual:** The room stays blank.\n" +
      "\n\n![[kanban/evidence/beta-bug/after.png]]\n");
    run(["upsert", "alpha-bug", "--column", "Done", "--title", "T1 · Alpha breaks",
      "--board", board, "--tasks", tasksPath, "--now", T.now]);
    // `Review` is Feature-Map-gated, and this fixture is about drift, not about
    // the map — so it takes the declared escape hatch, the same way a real
    // surfaceless fix would.
    run(["feature", "T2", "--none", "drift fixture: no user-reachable surface",
      "--board", board, "--tasks", tasksPath, "--now", T.now]);
    run(["upsert", "beta-bug", "--column", "Review", "--title", "T2 · Beta breaks", "--no-stamp",
      "--board", board, "--tasks", tasksPath, "--now", T.now]);
    // hand-drag simulation: put the status back where it was
    const t = JSON.parse(readFileSync(tasksPath, "utf8"));
    t["beta-bug"].status = "implementing";
    writeFileSync(tasksPath, JSON.stringify(t, null, 1));

    const r = run(["list", "--board", board, "--tasks", tasksPath]);
    expect(r.code).toBe(0);
    const row = r.out.split("\n").find(l => l.includes("beta-bug"))!;
    expect(row).toContain("drift");
    expect(row).toContain("Review");
    expect(row).toContain("implementing");
    // the row is still one line, and the healthy row is NOT flagged
    expect(r.out.split("\n").find(l => l.includes("alpha-bug"))).not.toContain("drift");
  });

  test("flags a task with no card on the board at all", () => {
    const { board, tasksPath } = refVault(refTasks());
    const r = run(["list", "--board", board, "--tasks", tasksPath]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n").filter(l => l.includes("drift"))).toHaveLength(2);
    expect(r.out).toMatch(/not on the board/);
  });

  test("a status ahead of its column is normal in-flight work, not drift", () => {
    // The investigator records `investigating` while the card is still in
    // `todo` — flagging that would make the drift marker noise.
    const { board, tasksPath } = refVault({
      a: { slug: "a", ref: "T1", status: "investigating", stages: { detected: T.detected } },
    });
    run(["upsert", "a", "--column", "todo", "--title", "T1 · A",
      "--board", board, "--tasks", tasksPath, "--now", T.now]);
    expect(run(["list", "--board", board, "--tasks", tasksPath]).out).not.toContain("drift");
  });

  test("an empty pipeline prints nothing and still exits 0", () => {
    const { board, tasksPath } = refVault({});
    const r = run(["list", "--board", board, "--tasks", tasksPath]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("");
  });

  test("readBoardCards strips the ref prefix from the card title", () => {
    const { board } = refVault({});
    run(["upsert", "a", "--column", "todo", "--title", "T7 · A title", "--board", board]);
    expect(readBoardCards(board).get("a")).toMatchObject({ column: "todo", title: "A title" });
  });

  test("listRows is pure enough to test without the CLI", () => {
    const { board, tasksPath } = refVault(refTasks());
    const rows = listRows(tasksPath, board);
    expect(rows.map(r => r.ref)).toEqual(["T1", "T2"]);
    expect(rows[0]!.drift).toMatch(/not on the board/);
  });
});

describe("the template is a note the guard accepts", () => {
  test("a filled template-shaped note passes noteProblem", () => {
    const tpl = readFileSync(
      join(import.meta.dir, "..", "templates", "card-note-template.md"), "utf8");
    expect(tpl).toContain(MARK_START);
    expect(tpl).toContain("## Work items");
    expect(tpl).toContain("## Findings");
    expect(tpl).toContain("## Open questions");
    expect(tpl).toContain("![[kanban/evidence/");
    const { board, cards } = vault();
    writeFileSync(join(cards, "t.md"), tpl);
    expect(noteProblem(board, "t", "in progress")).toBeNull();
  });
});

// Regression (2026-09-01): `note` replaced the whole file, silently dropping the
// machine-owned status block — so every note-writing agent had to hand-carry it
// byte-for-byte. One agent noticed mid-task; the next would have got it wrong.
// `note` now re-stamps, so authors only ever write the body.
describe("note preserves the machine-owned block", () => {
  function vault(tasks: object): { board: string; tasksPath: string } {
    const v = mkdtempSync(join(tmpdir(), "vault-")); dirs.push(v);
    mkdirSync(join(v, ".obsidian"), { recursive: true });
    const board = join(v, "kanban", "Kanban.md");
    mkdirSync(join(dirname(board), "cards"), { recursive: true });
    writeFileSync(board, SKELETON);
    const tasksPath = join(v, "tasks.json");
    writeFileSync(tasksPath, JSON.stringify(tasks));
    return { board, tasksPath };
  }

  test("a body with no markers comes back stamped", () => {
    const { board, tasksPath } = vault({ "my-bug": {
      slug: "my-bug", ref: "T9", status: "investigating",
      stages: { detected: "2026-09-01T10:00:00Z" } } });
    const src = join(dirname(board), "body.md"); dirs.push(dirname(src));
    writeFileSync(src, "# My bug\n\n## Problem\n\nSomething is wrong here, at length.\n");
    const r = run(["note", "my-bug", "--file", src, "--board", board,
                   "--tasks", tasksPath, "--now", "2026-09-01T11:00:00Z"]);
    expect(r.code).toBe(0);
    const out = readFileSync(join(dirname(board), "cards", "my-bug.md"), "utf8");
    expect(out).toContain(MARK_START);
    expect(out).toContain("**T9**");
    expect(out).toContain("Something is wrong here");
    expect(out.indexOf("# My bug")).toBeLessThan(out.indexOf(MARK_START));
  });

  test("a terminal status freezes elapsed at the last stage reached", () => {
    const withdrawn = { slug: "gone", ref: "T9", status: "withdrawn",
      stages: { detected: "2026-09-01T10:00:00Z", investigating: "2026-09-01T10:20:00Z" } };
    const early = statusBlock(withdrawn, "2026-09-01T11:00:00Z");
    const later = statusBlock(withdrawn, "2026-09-05T11:00:00Z");
    expect(early).toBe(later);                       // does not grow forever
    expect(early).toContain("**Elapsed** 20m");
  });
});

// Retired 2026-09-22 (Nicholas: "drop it in the card notes, pictures should
// still exist in the MRs"). The 2026-09-02 rule required a screenshot embed in
// the card note before Review; pictures now live in the MR description only.
describe("Review cards no longer need an image in the note", () => {
  function noteVault(body: string): { board: string } {
    const v = mkdtempSync(join(tmpdir(), "vault-")); dirs.push(v);
    mkdirSync(join(v, ".obsidian"), { recursive: true });
    const board = join(v, "kanban", "Kanban.md");
    mkdirSync(join(dirname(board), "cards"), { recursive: true });
    writeFileSync(board, SKELETON);
    writeFileSync(join(dirname(board), "cards", "my-bug.md"), body);
    return { board };
  }
  const prose = "# My bug\n\n## Problem\n\n" + "A genuine note body, long enough to pass. ".repeat(3);

  test("a Review card with no embed and no declaration is accepted", () => {
    expect(noteProblem(noteVault(prose).board, "my-bug", "Review")).toBeNull();
  });

  test("an embed is still allowed", () => {
    const b = noteVault(prose + "\n\n![[kanban/evidence/my-bug/after.png]]\n").board;
    expect(noteProblem(b, "my-bug", "Review")).toBeNull();
  });

  test("a stub note is still refused", () => {
    expect(noteProblem(noteVault("# x\n").board, "my-bug", "Review")).toMatch(/empty or a stub/);
  });
});

// Requirement from Nicholas (2026-09-15): a bug nobody else can reproduce
// cannot be reviewed, and a built feature nobody can reach cannot be tried.
// The card carries those routes; the lane letter decides which one is owed.
describe("bug repro and feature how-to gates", () => {
  function gateVault(slug = "my-card"): { board: string; cards: string } {
    const v = mkdtempSync(join(tmpdir(), "vault-card-route-")); dirs.push(v);
    mkdirSync(join(v, ".obsidian"), { recursive: true });
    const board = join(v, "kanban", "Kanban.md");
    const cards = join(dirname(board), "cards");
    mkdirSync(cards, { recursive: true });
    writeFileSync(board, SKELETON);
    writeFileSync(join(cards, `${slug}.md`), routeNote(""));
    return { board, cards };
  }

  const routeNote = (section: string) =>
    "# Card\n\n## Problem\n\n" +
    "A genuine note body, long enough to pass the existing stub gate. ".repeat(3) +
    "\n\n![[kanban/evidence/my-card/after.png]]\n\n" + section;

  const writeRoute = (cards: string, slug: string, section: string) =>
    writeFileSync(join(cards, `${slug}.md`), routeNote(section));

  test("noteSection keeps H3 content, stops at the next H2, and returns null when absent", () => {
    const body = [
      "## Problem", "before", "## rEpRoDuCtIoN StEpS", "", "1. Open the app.",
      "### Starting state", "Signed out", "## Solution direction", "after",
    ].join("\n");
    expect(noteSection(body, "Reproduction steps"))
      .toBe("\n1. Open the app.\n### Starting state\nSigned out");
    expect(noteSection(body, "How to try it")).toBeNull();
  });

  test("T Review requires a real step and Expected line", () => {
    const { board, cards } = gateVault();
    writeRoute(cards, "my-card",
      "## Reproduction steps\n\n1. Open /rooms at 390px from a cold app.\n\n" +
      "**Expected:** The room opens.\n**Actual:** It stays blank.\n");
    expect(noteProblem(board, "my-card", "Review", "t12")).toBeNull();

    writeRoute(cards, "my-card", "## Evidence\n\nThe room stays blank.\n");
    expect(noteProblem(board, "my-card", "Review", "T12"))
      .toMatch(/no "## Reproduction steps" section/);

    writeRoute(cards, "my-card",
      "## Reproduction steps\n\n1. <From a cold app. Name the URL.>\n2. …\n\n" +
      "**Expected:** It opens.\n**Actual:** It does not.\n");
    expect(noteProblem(board, "my-card", "Review", "T12"))
      .toMatch(/has no numbered steps/);

    writeRoute(cards, "my-card",
      "## Reproduction steps\n\n1) Open /rooms from a cold app.\n\n**Actual:** It stays blank.\n");
    expect(noteProblem(board, "my-card", "Review", "T12"))
      .toMatch(/no \*\*Expected:\*\* line/);
  });

  test("T in progress requires only the heading", () => {
    const { board, cards } = gateVault();
    expect(noteProblem(board, "my-card", "in progress", "T2"))
      .toMatch(/no "## Reproduction steps" section/);
    writeRoute(cards, "my-card", "## Reproduction steps\n\n");
    expect(noteProblem(board, "my-card", "in progress", "T2")).toBeNull();
  });

  test("F Review requires a real step and You-should-see line", () => {
    const { board, cards } = gateVault();
    writeRoute(cards, "my-card",
      "## How to try it\n\n1. Open Library from a cold app.\n\n" +
      "**You should see:** The new document action.\n");
    expect(noteProblem(board, "my-card", "Review", "F4")).toBeNull();

    writeRoute(cards, "my-card", "## Evidence\n\nThe feature is built.\n");
    expect(noteProblem(board, "my-card", "Review", "F4"))
      .toMatch(/no "## How to try it" section/);

    writeRoute(cards, "my-card", "## How to try it\n\n1. <Open the feature.>\n2. ...\n\n" +
      "**You should see:** The new action.\n");
    expect(noteProblem(board, "my-card", "Review", "F4"))
      .toMatch(/has no numbered steps/);

    writeRoute(cards, "my-card", "## How to try it\n\n1) Open Library from a cold app.\n");
    expect(noteProblem(board, "my-card", "Review", "F4"))
      .toMatch(/no \*\*You should see:\*\* line/);
  });

  test("F in progress and non-T/F cards are exempt", () => {
    const { board } = gateVault();
    expect(noteProblem(board, "my-card", "in progress", "F8")).toBeNull();
    expect(noteProblem(board, "my-card", "Review", "R3")).toBeNull();
    expect(noteProblem(board, "my-card", "Review", "C12")).toBeNull();
    expect(noteProblem(board, "my-card", "Review")).toBeNull();
  });

  test("upsert uses the tasks.json ref and leaves the board untouched on refusal", () => {
    const slug = "ledger-bug";
    const { board, cards } = gateVault(slug);
    writeFileSync(board, moveCard(SKELETON, slug, "todo", "T8 · Ledger bug", board));
    const tasksPath = join(dirname(board), "tasks.json");
    writeFileSync(tasksPath, JSON.stringify({
      [slug]: { slug, ref: "T8", status: "implementing", stages: {} },
    }));
    const features = join(dirname(board), "features");
    mkdirSync(features);
    const before = readFileSync(board, "utf8");
    const r = run(["upsert", slug, "--column", "Review", "--board", board,
      "--tasks", tasksPath, "--features", features]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("refusing to move");
    expect(r.err).toContain("## Reproduction steps");
    expect(readFileSync(board, "utf8")).toBe(before);
    expect(readFileSync(join(cards, `${slug}.md`), "utf8")).toBe(routeNote(""));
  });

  test("upsert falls back to the ref rendered on a board-only card", () => {
    const slug = "board-bug";
    const { board } = gateVault(slug);
    const line = `- [ ] **T9 · Something** [[cards/${slug}|details]] #openmarket #low`;
    writeFileSync(board, SKELETON.replace("## todo\n", `## todo\n\n${line}\n`));
    const tasksPath = join(dirname(board), "tasks.json");
    writeFileSync(tasksPath, "{}\n");
    const before = readFileSync(board, "utf8");
    const r = run(["upsert", slug, "--column", "in progress", "--board", board,
      "--tasks", tasksPath]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("## Reproduction steps");
    expect(readFileSync(board, "utf8")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The Feature Map gate (2026-09-02). §7 has always listed "Feature Map entry"
// as a step of the review gate, and it was the ONLY step nothing enforced:
// twelve shipped tasks produced exactly one entry. The failure mode is not just
// an absent entry but an INHERITED one — a task naming a good file some earlier
// task wrote — so the gate is mtime-aware, not existence-aware.
//
// The map is reached through a SYMLINK (`references/features` → the Obsidian
// vault), and the vault side moved twice in one day, so every path comparison
// here happens through a link on purpose.
// ---------------------------------------------------------------------------
import { symlinkSync, utimesSync } from "node:fs";
import { FEATURE_MAP_DIR, featureMapDeclaration, featureMapDir, featureMapEntries, featureMapProblem, unknownProduct } from "./kanban";

describe("the Feature Map gate", () => {
  const REVIEW_NOTE = "# My bug\n\n## Problem\n\n" +
    "A genuine note body, long enough to pass the stub check. ".repeat(3) +
    "\n\n![[kanban/evidence/my-bug/after.png]]\n";

  const ENTRY = [
    "# Members tab", "",
    "## Sub-features", "",
    "The roster, the hover state, the presence dot. ".repeat(2), "",
    "## How to get to it (user POV)", "",
    "Open a space, click the members icon in the header.", "",
    "## Driving it (testing-harness / :31417)", "",
    "Navigate to /rooms, open a space, screenshot the rail.", "",
    "## Gotchas", "",
    "The daemon serves a prebuilt dist/ that can lag origin/main by hours.", "",
  ].join("\n");

  /** A vault + tasks.json + a Feature Map the tooling names through a symlink,
   *  exactly as `references/features` names the real one. */
  function featureVault(overrides: Record<string, unknown> = {}) {
    const { board, cards } = vault();
    const tasksPath = join(dirname(board), "tasks.json");
    const map = join(dirname(board), "Feature Map");   // the real directory
    mkdirSync(map, { recursive: true });
    const link = join(dirname(board), "features");     // how the skill names it
    symlinkSync(map, link);
    const task = {
      id: 42, slug: "my-bug", ref: "T7", status: "implementing",
      repo: "openmarket-chat", branch: "om-bug-loop/my-bug", mrUrl: null,
      worktree: "/tmp/wt-T7", retries: 0, seenAt: T.detected,
      stages: {
        detected: T.detected, investigating: T.investigating,
        planned: T.approval, implementing: T.implementing,
      },
      ...overrides,
    };
    writeFileSync(tasksPath, JSON.stringify({ "my-bug": task }, null, 1));
    writeFileSync(join(cards, "my-bug.md"), REVIEW_NOTE);
    return { board, cards, tasksPath, map, link, task };
  }

  /** An entry file with a chosen mtime — "was this touched for THIS task" is
   *  the whole question, so the clock is a fixture, never Date.now(). */
  function writeEntry(dir: string, name: string, mtime: string): string {
    const p = join(dir, name);
    writeFileSync(p, ENTRY);
    utimesSync(p, new Date(mtime), new Date(mtime));
    return p;
  }

  const AFTER = "2026-09-01T07:02:00.000Z";   // during this task's implementing
  const BEFORE = "2026-08-28T09:00:00.000Z";  // an earlier task's work

  test("a task with no featureMap is refused, and told how to fix it", () => {
    const { task, link } = featureVault();
    const problem = featureMapProblem(task, link)!;
    expect(problem).toMatch(/no Feature Map entry recorded/);
    expect(problem).toContain("kanban.ts feature T7 --file");
    expect(problem).toContain('--none "<why>"');
  });

  test("an entry written during the task passes", () => {
    const { map, link, task } = featureVault();
    const entry = writeEntry(map, "members-tab.md", AFTER);
    expect(featureMapProblem({ ...task, featureMap: [entry] }, link)).toBeNull();
  });

  test("an entry INHERITED from an earlier task is refused", () => {
    const { map, link, task } = featureVault();
    const entry = writeEntry(map, "members-tab.md", BEFORE);
    const problem = featureMapProblem({ ...task, featureMap: [entry] }, link)!;
    expect(problem).toMatch(/inherited from an earlier task/);
    expect(problem).toContain("members-tab.md");
    expect(problem).toContain("implementing"); // names the stamp it compared against
  });

  test("one entry written for this task is enough, even beside a stale one", () => {
    const { map, link, task } = featureVault();
    const stale = writeEntry(map, "old-surface.md", BEFORE);
    const fresh = writeEntry(map, "members-tab.md", AFTER);
    expect(featureMapProblem({ ...task, featureMap: [stale, fresh] }, link)).toBeNull();
  });

  test("a stub entry is refused — the four H2 sections are the contract", () => {
    const { map, link, task } = featureVault();
    const p = join(map, "stub.md");
    writeFileSync(p, "# Members tab\n");
    utimesSync(p, new Date(AFTER), new Date(AFTER));
    expect(featureMapProblem({ ...task, featureMap: [p] }, link)).toMatch(/empty or a stub/);
  });

  test("a path that does not exist is refused", () => {
    const { map, link, task } = featureVault();
    expect(featureMapProblem({ ...task, featureMap: [join(map, "ghost.md")] }, link))
      .toMatch(/does not exist/);
  });

  test("a file outside the Feature Map is refused — any file is not an entry", () => {
    const { board, link, task } = featureVault();
    const outside = join(dirname(board), "plan.md");
    writeFileSync(outside, ENTRY);
    utimesSync(outside, new Date(AFTER), new Date(AFTER));
    expect(featureMapProblem({ ...task, featureMap: [outside] }, link))
      .toMatch(/is not in the Feature Map/);
  });

  // The map is a symlink into the Obsidian vault, and the vault path has
  // already changed twice. Naming an entry through EITHER spelling must work,
  // which only holds if both sides are realpath'd.
  test("the symlinked map resolves: link-named and vault-named entries both pass", () => {
    const { map, link, task } = featureVault();
    writeEntry(map, "members-tab.md", AFTER);
    const viaLink = join(link, "members-tab.md");
    const viaVault = join(map, "members-tab.md");
    expect(featureMapProblem({ ...task, featureMap: [viaLink] }, link)).toBeNull();
    expect(featureMapProblem({ ...task, featureMap: [viaVault] }, link)).toBeNull();
    // …and with the ROOT itself named through the link or the real directory
    expect(featureMapProblem({ ...task, featureMap: [viaLink] }, map)).toBeNull();
    expect(featureMapProblem({ ...task, featureMap: [viaVault] }, map)).toBeNull();
  });

  test("the declaration is the escape hatch, and carries its reason", () => {
    const { link, task } = featureVault();
    const declared = { ...task, featureMap: ["No feature surface — a relay verdict, no UI"] };
    expect(featureMapProblem(declared, link)).toBeNull();
    expect(featureMapDeclaration(declared)).toContain("relay verdict");
  });

  test("a single string is read as one entry, not as nothing", () => {
    const { map, link, task } = featureVault();
    const entry = writeEntry(map, "members-tab.md", AFTER);
    expect(featureMapEntries({ ...task, featureMap: entry })).toEqual([entry]);
    expect(featureMapProblem({ ...task, featureMap: entry }, link)).toBeNull();
  });

  test("with no implementing stamp it falls back, and still catches inheritance", () => {
    const { map, link, task } = featureVault({
      stages: { detected: T.detected, investigating: T.investigating },
    });
    const stale = writeEntry(map, "old.md", BEFORE);      // predates the task
    expect(featureMapProblem({ ...task, featureMap: [stale] }, link))
      .toMatch(/inherited from an earlier task/);
    const fresh = writeEntry(map, "new.md", AFTER);
    expect(featureMapProblem({ ...task, featureMap: [fresh] }, link)).toBeNull();
  });
});

describe("the Review column is Feature-Map-gated", () => {
  const REVIEW_NOTE = "# My bug\n\n## Problem\n\n" +
    "A genuine note body, long enough to pass the stub check. ".repeat(3) +
    "\n\n## Reproduction steps\n\n1. Open /rooms from a cold app.\n\n" +
    "**Expected:** The room opens.\n**Actual:** The room stays blank.\n" +
    "\n\n![[kanban/evidence/my-bug/after.png]]\n";
  const ENTRY = [
    "# Members tab", "", "## Sub-features", "",
    "The roster, the hover state, the presence dot. ".repeat(2), "",
    "## How to get to it (user POV)", "", "Open a space.", "",
    "## Driving it (testing-harness / :31417)", "", "Navigate to /rooms.", "",
    "## Gotchas", "", "The daemon serves a prebuilt dist/.", "",
  ].join("\n");

  function live(extra: Record<string, unknown> = {}) {
    const { board, cards } = vault();
    const tasksPath = join(dirname(board), "tasks.json");
    const map = join(dirname(board), "Feature Map");
    mkdirSync(map, { recursive: true });
    const link = join(dirname(board), "features");
    symlinkSync(map, link);
    writeFileSync(tasksPath, JSON.stringify({
      "my-bug": {
        id: 42, slug: "my-bug", ref: "T7", status: "implementing",
        repo: "openmarket-chat", branch: "om-bug-loop/my-bug", mrUrl: null,
        worktree: "/tmp/wt-T7", seenAt: T.detected,
        stages: {
          detected: T.detected, investigating: T.investigating,
          planned: T.approval, implementing: T.implementing,
        },
        ...extra,
      },
    }, null, 1));
    writeFileSync(join(cards, "my-bug.md"), REVIEW_NOTE);
    return { board, cards, tasksPath, map, link };
  }
  const entryAt = (dir: string, name: string, mtime: string) => {
    const p = join(dir, name);
    writeFileSync(p, ENTRY);
    utimesSync(p, new Date(mtime), new Date(mtime));
    return p;
  };
  const AFTER = "2026-09-01T07:02:00.000Z";
  const BEFORE = "2026-08-28T09:00:00.000Z";

  test("a move into Review with no entry is refused and the board is untouched", () => {
    const { board, tasksPath, link } = live();
    const before = readFileSync(board, "utf8");
    const r = run(["upsert", "my-bug", "--column", "Review", "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/refusing to move "my-bug" into "Review"/);
    expect(r.err).toMatch(/no Feature Map entry recorded/);
    expect(readFileSync(board, "utf8")).toBe(before);
  });

  test("recording an entry releases the move", () => {
    const { board, tasksPath, map, link } = live();
    const entry = entryAt(map, "members-tab.md", AFTER);
    expect(run(["feature", "my-bug", "--file", entry, "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]).code).toBe(0);
    const r = run(["upsert", "my-bug", "--column", "Review", "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]);
    expect(r.code).toBe(0);
    expect(readFileSync(board, "utf8").split("## Review")[1]).toContain("cards/my-bug|");
  });

  test("a stale inherited entry is refused at the CLI too", () => {
    const { board, tasksPath, map, link } = live();
    const entry = entryAt(map, "members-tab.md", BEFORE);
    // recording it is fine — staleness is only answerable at the gate
    expect(run(["feature", "my-bug", "--file", entry, "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]).code).toBe(0);
    const r = run(["upsert", "my-bug", "--column", "Review", "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/inherited from an earlier task/);
  });

  test("in progress is NOT Feature-Map-gated — the fix does not exist yet", () => {
    const { board, tasksPath, link } = live();
    const r = run(["upsert", "my-bug", "--column", "in progress", "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]);
    expect(r.code).toBe(0);
  });

  test("a board-only card with no tasks.json entry is not blocked", () => {
    // This tool never invents task entries, so a slug it has never heard of has
    // nothing to check against — the same rule `advance` follows.
    const { board, cards, tasksPath, link } = live();
    writeFileSync(join(cards, "stranger.md"), REVIEW_NOTE);
    const r = run(["upsert", "stranger", "--column", "Review", "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]);
    expect(r.code).toBe(0);
  });

  test("the declaration releases the move, and shows on the card", () => {
    const { board, cards, tasksPath, link } = live();
    const r = run(["feature", "my-bug", "--none", "relay verdict — no user-reachable surface",
      "--board", board, "--tasks", tasksPath, "--features", link, "--now", T.now]);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(tasksPath, "utf8"))["my-bug"].featureMap)
      .toEqual(["No feature surface — relay verdict — no user-reachable surface"]);
    expect(readFileSync(join(cards, "my-bug.md"), "utf8"))
      .toContain("**Feature Map** No feature surface — relay verdict");
    expect(run(["upsert", "my-bug", "--column", "Review", "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]).code).toBe(0);
  });

  test("a declaration with no reason is refused — that is a silent bypass", () => {
    const { board, tasksPath, link } = live();
    for (const reason of ["", "   "]) {
      const r = run(["feature", "my-bug", "--none", reason, "--board", board,
        "--tasks", tasksPath, "--features", link, "--now", T.now]);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/needs a reason/);
    }
    expect(JSON.parse(readFileSync(tasksPath, "utf8"))["my-bug"].featureMap).toBeUndefined();
  });

  test("--file and --none together are refused", () => {
    const { board, tasksPath, map, link } = live();
    const entry = entryAt(map, "members-tab.md", AFTER);
    const r = run(["feature", "my-bug", "--file", entry, "--none", "why", "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]);
    expect(r.code).toBe(64);
    expect(r.err).toMatch(/opposites/);
  });

  test("recording refuses a file outside the map, at record time", () => {
    const { board, tasksPath, link } = live();
    const outside = join(dirname(board), "plan.md");
    writeFileSync(outside, ENTRY);
    const r = run(["feature", "my-bug", "--file", outside, "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/is not in the Feature Map/);
    expect(r.err).toContain("Sub-features"); // names the four-H2 contract
  });

  test("a ref, a lowercase ref and the slug all record against the same task", () => {
    const { board, tasksPath, map, link } = live();
    const a = entryAt(map, "a.md", AFTER);
    const b = entryAt(map, "b.md", AFTER);
    const c = entryAt(map, "c.md", AFTER);
    for (const [task, file] of [["T7", a], ["t7", b], ["my-bug", c]] as const) {
      expect(run(["feature", task, "--file", file, "--board", board,
        "--tasks", tasksPath, "--features", link, "--now", T.now]).code).toBe(0);
    }
    // additive across calls, and deduped
    expect(run(["feature", "T7", "--file", a, "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]).code).toBe(0);
    expect(JSON.parse(readFileSync(tasksPath, "utf8"))["my-bug"].featureMap)
      .toEqual([a, b, c]);
  });

  test("two --file flags in one call both land", () => {
    const { board, tasksPath, map, link } = live();
    const a = entryAt(map, "a.md", AFTER);
    const b = entryAt(map, "b.md", AFTER);
    run(["feature", "T7", "--file", a, "--file", b, "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]);
    expect(JSON.parse(readFileSync(tasksPath, "utf8"))["my-bug"].featureMap).toEqual([a, b]);
  });

  test("an unknown ref fails loudly and lists every known ref", () => {
    const { board, tasksPath, map, link } = live();
    const entry = entryAt(map, "a.md", AFTER);
    const r = run(["feature", "T9", "--file", entry, "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/unknown task ref/i);
    expect(r.err).toContain("T7");
    expect(r.err).toContain("my-bug");
  });

  test("an unknown slug is reported as a missing entry, never invented", () => {
    const { board, tasksPath, map, link } = live();
    const entry = entryAt(map, "a.md", AFTER);
    const r = run(["feature", "ghost", "--file", entry, "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no entry for "ghost"/);
    expect(JSON.parse(readFileSync(tasksPath, "utf8")).ghost).toBeUndefined();
  });

  // tasks.json has no locking and a concurrent agent writes it too, so every
  // write must be a read-modify-write of the file ON DISK.
  test("recording re-reads the file, preserving unknown keys and other tasks", () => {
    const { board, tasksPath, map, link } = live();
    const a = entryAt(map, "a.md", AFTER);
    const b = entryAt(map, "b.md", AFTER);
    run(["feature", "T7", "--file", a, "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]);
    // a concurrent agent lands a whole new task between the two calls
    const mid = JSON.parse(readFileSync(tasksPath, "utf8"));
    mid["other-bug"] = { id: 99, slug: "other-bug", ref: "T8", status: "new" };
    writeFileSync(tasksPath, JSON.stringify(mid, null, 1));

    run(["feature", "T7", "--file", b, "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]);
    const after = JSON.parse(readFileSync(tasksPath, "utf8"));
    expect(after["other-bug"].ref).toBe("T8");           // not clobbered
    expect(after["my-bug"].featureMap).toEqual([a, b]);
    expect(after["my-bug"].worktree).toBe("/tmp/wt-T7"); // unknown keys survive
    expect(after["my-bug"].stages.detected).toBe(T.detected);
    expect(after["my-bug"].status).toBe("implementing"); // recording is not a stage
  });

  // The recorded value keeps the spelling it was given. Storing the resolved
  // vault path would rot the moment the map moves — it moved twice on
  // 2026-09-02 — so the link-side name is what is written down.
  test("an entry named through the symlink is stored and read through it", () => {
    const { board, tasksPath, map, link } = live();
    entryAt(map, "members-tab.md", AFTER);
    const viaLink = join(link, "members-tab.md");
    expect(run(["feature", "T7", "--file", viaLink, "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]).code).toBe(0);
    expect(JSON.parse(readFileSync(tasksPath, "utf8"))["my-bug"].featureMap)
      .toEqual([viaLink]);
    // and the gate accepts it while naming the map by its OTHER spelling
    expect(run(["upsert", "my-bug", "--column", "Review", "--board", board,
      "--tasks", tasksPath, "--features", map, "--now", T.now]).code).toBe(0);
  });

  test("the card note names the entry, by basename", () => {
    const { board, cards, tasksPath, map, link } = live();
    const entry = entryAt(map, "members-tab.md", AFTER);
    run(["feature", "T7", "--file", entry, "--board", board,
      "--tasks", tasksPath, "--features", link, "--now", T.now]);
    const note = readFileSync(join(cards, "my-bug.md"), "utf8");
    expect(note).toContain("**Feature Map** members-tab.md");
    expect(note).not.toContain(map); // the directory is the same for every entry
  });
});

describe("the Feature Map root follows the product lane", () => {
  test("chat is the default, chart has its own root, unknown falls back to chat", () => {
    expect(featureMapDir("chat")).toBe(FEATURE_MAP_DIR);
    expect(featureMapDir(undefined)).toBe(FEATURE_MAP_DIR);
    expect(featureMapDir(null)).toBe(FEATURE_MAP_DIR);
    expect(featureMapDir("chart")).toContain("features-charts");
    // An unknown lane must not silently pass a gate against the wrong map.
    expect(featureMapDir("nonsense")).toBe(FEATURE_MAP_DIR);
  });

  test("a chart task's entry is judged against the chart map, not the chat one", () => {
    const chatRoot = mkdtempSync(join(tmpdir(), "fm-chat-"));
    const chartRoot = mkdtempSync(join(tmpdir(), "fm-chart-"));
    dirs.push(chatRoot, chartRoot);
    const entry = join(chartRoot, "watchlist.md");
    writeFileSync(entry, "## Sub-features\n\nEnough real content here to clear the eighty character stub gate that entries must pass.\n");

    const task = {
      ref: "T61", slug: "hip3-watchlist", product: "chart",
      featureMap: [entry],
      stages: { implementing: "2026-01-01T00:00:00.000Z" } as Record<string, string>,
    };
    // Judged against the chart root: the entry is inside it, so no problem.
    expect(featureMapProblem(task, chartRoot)).toBeNull();
    // Judged against the chat root, the same entry is out of the map.
    expect(featureMapProblem(task, chatRoot)).toContain("is not in the Feature Map");
  });

  test("an inherited key is not a lane — the prototype chain cannot pose as one", () => {
    // A bare object literal would return Object.prototype.constructor here,
    // which is truthy, so `??` would never reach the fallback.
    expect(featureMapDir("constructor")).toBe(FEATURE_MAP_DIR);
    expect(featureMapDir("toString")).toBe(FEATURE_MAP_DIR);
    expect(unknownProduct("constructor")).toBe("constructor");
  });

  test("the gate names an unrecognised lane instead of judging against chat", () => {
    expect(unknownProduct("chat")).toBeNull();
    expect(unknownProduct("chart")).toBeNull();
    expect(unknownProduct(undefined)).toBeNull();
    expect(unknownProduct(null)).toBeNull();
    expect(unknownProduct("charts")).toBe("charts");   // the likely typo

    const problem = featureMapProblem({
      ref: "T99", slug: "typo-lane", product: "charts",
      featureMap: ["/nonexistent/entry.md"],
      stages: { implementing: "2026-01-01T00:00:00.000Z" } as Record<string, string>,
    });
    expect(problem).toContain("not a known lane");
    expect(problem).not.toContain("is not in the Feature Map");
  });
});

// The plan-approval stop was removed 2026-09-11 and the stage it recorded was
// renamed `awaiting-approval` -> `planned`. 68 tasks in the live tasks.json
// carry the old key, and a stamp is the only record of when that task reached
// its plan — so the rename is a read-time alias, never a data migration that
// could drop a time.
describe("the pre-approval-gate stage name still reads", () => {
  test("an old stamp and status are read under the current name", () => {
    const t = normalizeTask({
      slug: "legacy", status: "awaiting-approval",
      stages: { detected: "2026-09-01T04:48:00Z", "awaiting-approval": "2026-09-01T05:08:00Z" },
    });
    expect(t.status).toBe("planned");
    expect(t.stages).toEqual({
      detected: "2026-09-01T04:48:00Z", planned: "2026-09-01T05:08:00Z",
    });
    expect(t.stages!["awaiting-approval"]).toBeUndefined();
  });

  test("a real stamp under the current name is never overwritten by an alias", () => {
    const t = normalizeTask({
      slug: "both",
      stages: { planned: "2026-09-01T05:00:00Z", "awaiting-approval": "2026-09-01T09:99:00Z" },
    });
    expect(t.stages!.planned).toBe("2026-09-01T05:00:00Z");
  });

  test("a task with no legacy key is returned untouched", () => {
    const t = { slug: "fresh", status: "planned", stages: { planned: "x" } };
    expect(normalizeTask(t)).toBe(t);
  });

  test("the renamed stage is still in the pipeline order, between the two it separates", () => {
    expect(STAGES.indexOf("planned")).toBe(STAGES.indexOf("investigating") + 1);
    expect(STAGES.indexOf("implementing")).toBe(STAGES.indexOf("planned") + 1);
  });
});

// The approval lane is gone; asserting its absence is what stops it being
// quietly reintroduced by a future edit that "just adds a column".
describe("the approval lane stays removed", () => {
  test("`todo review` is not a column", () => {
    expect(COLUMNS).not.toContain("todo review" as never);
  });

  test("the digest column is the one that carries the note gate", () => {
    expect(COLUMNS).toContain("in progress");
    const board = boardPath(SKELETON);
    expect(noteProblem(board, "nothing-here", "in progress")).toMatch(/no card note/);
  });
});

import { consumeLine } from "./kanban";

describe("consumeLine — a hand-written card becomes a pipeline card in place", () => {
  const B = "/Users/nicholas/Documents/Obisidian/kanban/Kanban.md";

  test("keeps the title, adds ref, details link and project tag", () => {
    const out = consumeLine("- [ ] restriction for openmarket chat #low", "T91", "restriction-for-openmarket-chat", B);
    expect(out).toBe(
      "- [ ] **T91 · restriction for openmarket chat** " +
      "[[kanban/cards/restriction-for-openmarket-chat|details]] #openmarket #low");
  });

  test("preserves an image embed — it is evidence, not decoration", () => {
    const out = consumeLine(
      "- [ ] restriction for openmarket chat #low ![[Pasted image 20260907171814.png]]",
      "T91", "restriction-for-openmarket-chat", B);
    expect(out).toContain("![[Pasted image 20260907171814.png]]");
    expect(out).toContain("**T91 · restriction for openmarket chat**");
  });

  test("preserves the routing tag — it records why the card was taken", () => {
    const out = consumeLine("- [ ] play around with the right click #low #pa", "T92", "play-around-right-click", B);
    expect(out).toContain("#pa");
    expect(out).toContain("#low");
  });

  test("defaults the priority when the card carries none", () =>
    expect(consumeLine("- [ ] weird logics", "T93", "weird-logics", B)).toContain("#low"));

  test("does not double the project tag when it is already there", () => {
    const out = consumeLine("- [ ] a thing #openmarket #low", "T94", "a-thing", B);
    expect(out.match(/#openmarket/g)).toHaveLength(1);
  });

  test("a chart card gets the charts project tag", () =>
    expect(consumeLine("- [ ] a chart thing #low", "T95", "a-chart-thing", B, "chart"))
      .toContain("#charts"));

  test("a card that is entirely a wikilink keeps the link and titles from it", () => {
    const out = consumeLine("- [ ] [[Invite Link server breaking down]] #low", "T96", "invite-link-server-breaking-down", B);
    expect(out).toContain("**T96 · Invite Link server breaking down**");
  });

  test("refuses a line that is not a card", () =>
    expect(() => consumeLine("## todo", "T97", "x", B)).toThrow(/not a card line/));
});

describe("stripRefPrefix accepts R refs, not just T", () => {
  test("an R-ref card title round-trips without its prefix", () => {
    const { board } = refVault({});
    run(["upsert", "a", "--column", "todo", "--title", "R12 · A question", "--board", board]);
    expect(readBoardCards(board).get("a")).toMatchObject({ column: "todo", title: "A question" });
  });
});

// ---------------------------------------------------------------------------
// Four defects hit live on 2026-09-11, all in this file. Each test below is
// the observation that caught one, not a restatement of the implementation.
// ---------------------------------------------------------------------------
import { boardRefs, nextRef as nextRefFn, rerenderLine, TERMINAL_STATUSES } from "./kanban";

describe("a re-render keeps what the card already carried", () => {
  // The line that was actually destroyed: the embed was the bug's only evidence.
  const LIVE = "- [ ] **T93 · invite restriction** [[kanban/cards/inv|details]] "
    + "#openmarket #low #bug ![[Pasted image 20260907171814.png]]";
  const boardOf = (line: string) => `## todo\n\n${line}\n\n\n## Done\n\n`;

  test("a retitle preserves foreign tags and image embeds, swapping only priority", () => {
    const out = moveCard(boardOf(LIVE), "inv", "todo", "T93 · invite restriction",
      DEFAULT_BOARD, "medium", "chat");
    expect(out).toContain("![[Pasted image 20260907171814.png]]");
    expect(out).toContain("#bug");
    expect(out).toContain("#medium");
    expect(out).not.toContain("#low");
    // and still exactly one details link, not two
    expect(out.match(/\|details\]\]/g)).toHaveLength(1);
  });

  test("cardLine alone cannot do this — which is why the lossy path was a bug", () => {
    expect(cardLine("inv", "T93 · invite restriction", DEFAULT_BOARD, "medium", "chat"))
      .not.toContain("Pasted image");
  });

  test("rerenderLine falls back to cardLine when handed a non-card line", () => {
    expect(rerenderLine("not a card", "inv", "T1 · x", DEFAULT_BOARD, "low", "chat"))
      .toContain("**T1 · x**");
  });

  test("a card created from nothing is unaffected", () => {
    const out = moveCard(boardOf(""), "fresh", "todo", "T1 · Fresh",
      DEFAULT_BOARD, "low", "chat");
    expect(out).toContain("**T1 · Fresh**");
  });
});

describe("every namespace nextRef can issue is stripped from its own title", () => {
  test("T, R and F alike", () => {
    const b = boardPath(`## todo\n\n`
      + `- [ ] **T5 · A defect** [[kanban/cards/t|details]] #low\n`
      + `- [ ] **R2 · A question** [[kanban/cards/r|details]] #low\n`
      + `- [ ] **F7 · A gap** [[kanban/cards/f|details]] #low\n\n\n## Done\n\n`);
    const cards = readBoardCards(b);
    expect(cards.get("t")!.title).toBe("A defect");
    expect(cards.get("r")!.title).toBe("A question");
    // F was accepted by REF_PATTERN but not by the stripper, so this read back
    // as "F7 · A gap" and any re-render wrote "F7 · F7 · A gap" to the board.
    expect(cards.get("f")!.title).toBe("A gap");
  });
});

describe("nextRef reads the shared board, not just this pipeline's ledger", () => {
  function refsVault(tasks: object, boardBody: string) {
    const v = mkdtempSync(join(tmpdir(), "vault-refs-")); dirs.push(v);
    mkdirSync(join(v, ".obsidian"), { recursive: true });
    const board = join(v, "kanban", "Kanban.md");
    mkdirSync(join(dirname(board), "cards"), { recursive: true });
    writeFileSync(board, `## todo\n\n${boardBody}\n\n\n## Done\n\n`);
    const tasksPath = join(v, "tasks.json");
    writeFileSync(tasksPath, JSON.stringify(tasks));
    return { board, tasksPath };
  }

  test("a ref live on the board is never handed out again", () => {
    // The exact shape of the collision: ledger stops at T68, board is at T90.
    const { board, tasksPath } = refsVault(
      { a: { slug: "a", ref: "T68", status: "shipped" } },
      "- [ ] **T90 · Someone else's card** [[kanban/cards/x|details]] #low");
    expect(nextRefFn(tasksPath, "T")).toBe("T69");          // ledger alone: the bug
    expect(nextRefFn(tasksPath, "T", board)).toBe("T91");   // with the board: correct
  });

  test("each namespace counts separately, and C is left to its owner", () => {
    const { board, tasksPath } = refsVault({},
      `- [ ] **C14 · Another pipeline's** [[kanban/cards/c|details]] #low\n`
      + `- [ ] **F3 · A gap** [[kanban/cards/f|details]] #low`);
    expect(boardRefs(board)).toEqual(["F3"]);
    expect(nextRefFn(tasksPath, "F", board)).toBe("F4");
    expect(nextRefFn(tasksPath, "T", board)).toBe("T1");
  });
});

describe("work that files findings instead of shipping a diff can be closed out", () => {
  test("swept is terminal and distinct from shipped", () => {
    expect(TERMINAL_STATUSES).toContain("swept");
    expect(TERMINAL_STATUSES).toContain("researched");
    // shipped must keep meaning "a diff landed" or delivery counts inflate.
    expect(TERMINAL_STATUSES.indexOf("swept")).not.toBe(TERMINAL_STATUSES.indexOf("shipped"));
  });

  test("the CLI sets one without hand-editing tasks.json", () => {
    const v = mkdtempSync(join(tmpdir(), "vault-status-")); dirs.push(v);
    mkdirSync(join(v, ".obsidian"), { recursive: true });
    const board = join(v, "kanban", "Kanban.md");
    mkdirSync(join(dirname(board), "cards"), { recursive: true });
    writeFileSync(board, SKELETON);
    const tasksPath = join(v, "tasks.json");
    writeFileSync(tasksPath, JSON.stringify({ sweep: {
      slug: "sweep", ref: "T91", status: "investigating",
      stages: { detected: "2026-09-11T10:00:00Z" } } }));

    const r = run(["status", "sweep", "swept", "--board", board, "--tasks", tasksPath]);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(tasksPath, "utf8")).sweep.status).toBe("swept");
  });

  test("a status that is not terminal is refused", () => {
    const v = mkdtempSync(join(tmpdir(), "vault-status2-")); dirs.push(v);
    const tasksPath = join(v, "tasks.json");
    writeFileSync(tasksPath, JSON.stringify({ a: { slug: "a", ref: "T1", status: "new" } }));
    expect(run(["status", "a", "investigating", "--tasks", tasksPath]).code).toBe(64);
  });
});

// ---------------------------------------------------------- the title cap
//
// The board is the monitoring surface, and every producer had the same escape
// hatch: with nowhere else to put the finding, the title became the brief. Live
// on 2026-09-14, T128's title ran 560 characters and carried three evidence
// paths; its `|details` note did not exist. These are the two gates that make
// that shape impossible rather than discouraged.

import {
  TITLE_MAX, titleProblem, readTitle, filedFindingNote, CARD_NOTE_SECTIONS, strayHeadings,
  PLAY_AROUND_ORIGIN, SOURCE_MARKER, hasPlayAroundMarker, isFeatureCard, playAroundCap,
} from "./kanban";
import { readTodoLane } from "./board-todos";

const LONG = "doc context menu: `History` on a doc pill just opens the doc — the pane "
  + "it renders is byte-identical to `Open` and no version panel appears";

describe("titleProblem — a title is a handle, not the brief", () => {
  test("passes a handle", () =>
    expect(titleProblem("doc menu History opens a plain pane")).toBeNull());

  test("passes exactly at the cap, and fails one past it", () => {
    expect(titleProblem("x".repeat(TITLE_MAX))).toBeNull();
    expect(titleProblem("x".repeat(TITLE_MAX + 1))).toMatch(/over the 60-character cap/);
  });

  test("names the length and shows the offending title, so the cut is informed", () => {
    const why = titleProblem(LONG)!;
    expect(why).toContain(String(LONG.length));
    expect(why).toContain("doc context menu");
    expect(why).toContain("cards/<slug>.md");
  });

  test("measures the trimmed title — trailing whitespace is not content", () =>
    expect(titleProblem(`${"x".repeat(TITLE_MAX)}    `)).toBeNull());
});

describe("readTitle — one extraction, shared by the line and the note", () => {
  test("strips tags, embeds, bold and a ref prefix", () =>
    expect(readTitle("**T91 · a thing broke** ![[shot.png]] #low #bug").title)
      .toBe("a thing broke"));

  test("strips an F ref prefix", () =>
    expect(readTitle("**F12 · names render literally** ![[shot.png]] #low #feature").title)
      .toBe("names render literally"));

  test("falls back to a wikilink's display text and says which link it took", () => {
    const r = readTitle("[[Invite Link Embeds|the invite bug]] #low");
    expect(r.title).toBe("the invite bug");
    expect(r.fromLinkIndex).toBe(0);
  });
});

import { linePriority } from "./kanban";

describe("consume priority — the board tag and ledger stay in agreement", () => {
  const fixtures = [
    {
      name: "inherits a high priority before another tag",
      title: "a high thing", tags: "#high #feature", expected: "high", other: "#feature",
    },
    {
      name: "finds a medium priority after another tag",
      title: "a medium thing", tags: "#feature #medium", expected: "medium", other: "#feature",
    },
    {
      name: "defaults a line without a priority tag",
      title: "a plain thing", tags: "#bug", expected: "low", other: "#bug",
    },
    {
      name: "an explicit priority replaces the line priority",
      title: "an overridden thing", tags: "#low #bug", expected: "high", other: "#bug",
      args: ["--priority", "high"],
    },
  ];

  for (const [i, fixture] of fixtures.entries()) {
    test(fixture.name, () => {
      const p = boardPath(`## todo\n\n- [ ] ${fixture.title} ${fixture.tags}\n\n\n## Done\n\n`);
      const tasksPath = join(dirname(p), "tasks.json");
      const slug = `priority-${i}`;
      const r = run(["consume", "2", "--ref", `T${i + 1}`, "--slug", slug,
        "--board", p, "--tasks", tasksPath, ...(fixture.args ?? [])]);
      expect(r.code).toBe(0);

      const entry = JSON.parse(readFileSync(tasksPath, "utf8"))[slug];
      const line = readFileSync(p, "utf8").split("\n")[2]!;
      expect(entry.priority).toBe(fixture.expected);
      expect(line).toContain(fixture.other);

      const priorityTags = (line.match(/#[A-Za-z0-9_-]+/g) ?? [])
        .filter(tag => ["#low", "#medium", "#high"].includes(tag.toLowerCase()));
      expect(priorityTags).toEqual([`#${entry.priority}`]);
      if (fixture.expected !== "low") expect(line).not.toContain("#low");
    });
  }

  test("linePriority extracts the first recognized tag case-insensitively", () => {
    expect(linePriority("- [ ] thing #high #feature")).toBe("high");
    expect(linePriority("- [ ] thing #feature #MEDIUM")).toBe("medium");
    expect(linePriority("- [ ] thing #bug")).toBeNull();
  });

  test("consumeLine replaces a priority without losing routing or evidence", () => {
    const line = consumeLine("- [ ] a thing #low #pa ![[shot.png]]", "T9", "a-thing",
      DEFAULT_BOARD, undefined, undefined, "medium");
    expect(line).toContain("#medium");
    expect(line).toContain("#pa");
    expect(line).toContain("![[shot.png]]");
    expect(line).not.toContain("#low");
  });
});

describe("consume --title — the short handle renders, the long text is banked", () => {
  const board = () => {
    const p = boardPath(`## todo\n\n- [ ] ${LONG} #low #bug\n\n\n## Done\n\n`);
    return p;
  };

  test("refuses a long title rather than cutting it blind", () => {
    const p = board();
    const r = run(["consume", "2", "--ref", "T1", "--slug", "doc-menu-history", "--board", p,
      "--tasks", join(dirname(p), "tasks.json")]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/over the 60-character cap/);
    expect(r.err).toMatch(/--title/);
    // Refusing must change NOTHING: a half-consumed card with a reserved ref
    // and a raw line is the state the watcher re-offers forever.
    expect(readFileSync(p, "utf8")).toContain(`- [ ] ${LONG} #low #bug`);
  });

  test("renders the handle and writes the original into the card note", () => {
    const p = board();
    const r = run(["consume", "2", "--ref", "T1", "--slug", "doc-menu-history",
      "--title", "doc menu History opens a plain pane", "--board", p,
      "--tasks", join(dirname(p), "tasks.json")]);
    expect(r.code).toBe(0);
    const md = readFileSync(p, "utf8");
    expect(md).toContain("**T1 · doc menu History opens a plain pane**");
    expect(md).toContain("[[cards/doc-menu-history|details]]");
    expect(md).not.toContain("byte-identical");

    const note = readFileSync(join(dirname(p), "cards", "doc-menu-history.md"), "utf8");
    expect(note).toContain("# doc menu History opens a plain pane");
    expect(note).toContain("## Problem");
    expect(note).toContain("byte-identical");
  });

  test("keeps tags and embeds on the line while retitling", () => {
    const p = boardPath(`## todo\n\n- [ ] ${LONG} #low #bug ![[shot.png]]\n\n\n## Done\n\n`);
    const r = run(["consume", "2", "--ref", "T2", "--slug", "doc-menu-history",
      "--title", "doc menu History opens a plain pane", "--board", p,
      "--tasks", join(dirname(p), "tasks.json")]);
    expect(r.code).toBe(0);
    const line = readFileSync(p, "utf8").split("\n").find(l => l.includes("T2 ·"))!;
    expect(line).toContain("#bug");
    expect(line).toContain("![[shot.png]]");
  });

  test("never clobbers a note the reporter already wrote", () => {
    const p = board();
    writeNote(p, "doc-menu-history");
    run(["consume", "2", "--ref", "T3", "--slug", "doc-menu-history",
      "--title", "doc menu History opens a plain pane", "--board", p,
      "--tasks", join(dirname(p), "tasks.json")]);
    // `consume` still stamps the status block, as it always has; what it must
    // not do is replace the body the reporter wrote with the board line's text.
    const after = readFileSync(join(dirname(p), "cards", "doc-menu-history.md"), "utf8");
    expect(after).toContain("A genuine note body");
    expect(after).not.toContain("byte-identical");
  });

  test("a short line needs no --title and is unchanged in behaviour", () => {
    const p = boardPath("## todo\n\n- [ ] weird logics #low\n\n\n## Done\n\n");
    const r = run(["consume", "2", "--ref", "T4", "--slug", "weird-logics", "--board", p,
      "--tasks", join(dirname(p), "tasks.json")]);
    expect(r.code).toBe(0);
    expect(readFileSync(p, "utf8")).toContain("**T4 · weird logics**");
  });
});

describe("file-finding — the brief exists before the card does", () => {
  const BODY = join(import.meta.dir, "..", "templates", "card-note-template.md");
  const findingBody = (board: string, name: string, section = "") => {
    const file = join(dirname(board), `${name}.md`);
    writeFileSync(file,
      "## Problem\n\n" + "The pane stays unchanged when the reporter opens it. ".repeat(3) +
      (section ? `\n\n${section}\n` : "\n"));
    return file;
  };
  const bugBody = (board: string) => findingBody(board, "bug-body",
    "## Reproduction steps\n\n1. Open /rooms at 390px from a cold app.\n\n" +
    "**Expected:** The pane opens.\n**Actual:** It stays unchanged.");

  test("writes the note at the slug the watcher will derive, and a RAW line", () => {
    const p = boardPath("## todo\n\n\n## Done\n\n");
    const r = run(["file-finding", "doc menu History opens a plain pane",
      "--file", bugBody(p), "--tags", "#low #bug", "--board", p]);
    expect(r.code).toBe(0);
    const md = readFileSync(p, "utf8");
    // Raw: the watcher only picks up lines that are NOT already pipeline cards.
    expect(md).toContain("- [ ] doc menu History opens a plain pane #low #bug");
    expect(md).not.toContain("|details]]");
    expect(md).not.toContain("**");
    // slugify() is the same function watch-board.ts calls on the same title —
    // five words, so the note and the future card share one name by construction.
    expect(existsSync(join(dirname(p), "cards", "doc-menu-history-opens-a.md"))).toBe(true);
  });

  test("the line it writes is one the todo reader sees as unclaimed", () => {
    const p = boardPath("## todo\n\n\n## Done\n\n");
    run(["file-finding", "doc menu History opens a plain pane",
      "--file", bugBody(p), "--tags", "#low #bug", "--board", p]);
    const todos = readTodoLane(readFileSync(p, "utf8"));
    expect(todos).toHaveLength(1);
    expect(todos[0]!.claimed).toBe(false);
    expect(todos[0]!.tags).toEqual(["#low", "#bug"]);
  });

  test("refuses a long title — the cap binds the reporter too", () => {
    const p = boardPath("## todo\n\n\n## Done\n\n");
    const r = run(["file-finding", LONG, "--file", BODY, "--board", p]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/over the 60-character cap/);
    expect(readFileSync(p, "utf8")).not.toContain("doc context menu");
  });

  test("refuses a stub body — a note nobody can act on is the bug being fixed", () => {
    const p = boardPath("## todo\n\n\n## Done\n\n");
    const stub = join(dirname(p), "stub.md");
    writeFileSync(stub, "it is broken\n");
    const r = run(["file-finding", "a thing broke", "--file", stub, "--board", p]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/stub/);
  });

  test("refuses a slug collision instead of overwriting the first finding", () => {
    const p = boardPath("## todo\n\n\n## Done\n\n");
    expect(run(["file-finding", "doc menu History opens a plain pane",
      "--file", BODY, "--board", p]).code).toBe(0);
    const second = run(["file-finding", "doc menu History opens a docked pane",
      "--file", BODY, "--board", p]);
    expect(second.code).toBe(1);
    expect(second.err).toMatch(/already exists/);
  });

  test("a #bug finding without repro is refused before either artifact is written", () => {
    const p = boardPath("## todo\n\n\n## Done\n\n");
    const before = readFileSync(p, "utf8");
    const r = run(["file-finding", "room pane stays blank", "--file",
      findingBody(p, "bug-without-repro"), "--tags", "#low #bug", "--board", p]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('a #bug finding needs a "## Reproduction steps" section');
    expect(readFileSync(p, "utf8")).toBe(before);
    expect(existsSync(join(dirname(p), "cards"))).toBe(false);
  });

  test("a #bug finding with real repro steps is accepted", () => {
    const p = boardPath("## todo\n\n\n## Done\n\n");
    const r = run(["file-finding", "room pane stays blank", "--file", bugBody(p),
      "--tags", "#low #BUG", "--board", p]);
    expect(r.code).toBe(0);
    expect(readFileSync(p, "utf8")).toContain("room pane stays blank #low #BUG");
  });

  test("a #feature finding needs a real How-to-try-it section", () => {
    const p = boardPath("## todo\n\n\n## Done\n\n");
    const before = readFileSync(p, "utf8");
    const refused = run(["file-finding", "library needs quick add", "--file",
      findingBody(p, "feature-without-how-to"), "--tags", "#feature", "--board", p]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('a #feature finding needs a "## How to try it" section');
    expect(readFileSync(p, "utf8")).toBe(before);
    expect(existsSync(join(dirname(p), "cards"))).toBe(false);

    const accepted = run(["file-finding", "library needs quick add", "--file",
      findingBody(p, "feature-with-how-to",
        "## How to try it\n\nCurrent behaviour (not built yet):\n\n" +
        "1. Open Library from a cold app and look for Quick add."),
      "--tags", "#feature", "--board", p]);
    expect(accepted.code).toBe(0);
  });

  test("findings without a bug or feature tag are unchanged", () => {
    const p = boardPath("## todo\n\n\n## Done\n\n");
    const r = run(["file-finding", "room pane observation", "--file",
      findingBody(p, "plain-finding"), "--tags", "#low", "--board", p]);
    expect(r.code).toBe(0);
  });
});

describe("file-finding --parent — a follow-up inherits its parent's priority", () => {
  // Nicholas ruled the mobile restyle wave #high (2026-09-19); its owners' follow-ups
  // kept landing at DEFAULT_PRIORITY, and he found them in the queue before anyone else.
  const seed = (board: string, tasks: Record<string, unknown>) =>
    writeFileSync(join(dirname(board), "tasks.json"), JSON.stringify(tasks));
  const parentTasks = {
    "restyle-parent": { slug: "restyle-parent", ref: "F129", status: "shipped", priority: "high" },
  };
  const featureBody = (board: string) => {
    const file = join(dirname(board), "feature-body.md");
    writeFileSync(file,
      "## Problem\n\n" + "The launch screen ignores the chosen scheme on a cold start. ".repeat(3) +
      "\n\n## How to try it\n\nCurrent behaviour (not built yet):\n\n1. Cold-start the app.\n");
    return file;
  };
  const todoLine = (board: string) =>
    readFileSync(board, "utf8").split("\n").find(l => l.includes("launch chrome follows"));

  test("CONTROL: without --parent a finding still starts at the default priority", () => {
    const p = boardPath("## todo\n\n\n## Done\n\n");
    seed(p, parentTasks);
    expect(run(["file-finding", "launch chrome follows scheme", "--file", featureBody(p),
      "--board", p]).code).toBe(0);
    expect(todoLine(p)).toContain(`#${DEFAULT_PRIORITY}`);
  });

  test("with --parent and no --tags, the parent's priority is inherited — and the cap still binds", () => {
    // Inheriting #high must not be a way around the play-around cap: a finding
    // that is not a #feature still maxes out at #medium, parent or no parent.
    const p = boardPath("## todo\n\n\n## Done\n\n");
    seed(p, parentTasks);
    const r = run(["file-finding", "launch chrome follows scheme", "--file", featureBody(p),
      "--parent", "F129", "--board", p]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("inherited #high from parent F129");
    expect(r.out).toContain("capped #high → #medium");
    expect(todoLine(p)).toContain("#medium");
    expect(todoLine(p)).not.toContain(`#${DEFAULT_PRIORITY}`);
  });

  test("a #feature follow-up of a #high parent lands at #high — the restyle case", () => {
    const p = boardPath("## todo\n\n\n## Done\n\n");
    seed(p, parentTasks);
    const r = run(["file-finding", "launch chrome follows scheme", "--file", featureBody(p),
      "--tags", "#feature", "--parent", "F129", "--board", p]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("capped");
    expect(todoLine(p)).toContain("#high");
  });

  test("--tags without a priority keeps its tags and gains the parent's", () => {
    const p = boardPath("## todo\n\n\n## Done\n\n");
    seed(p, parentTasks);
    expect(run(["file-finding", "launch chrome follows scheme", "--file", featureBody(p),
      "--tags", "#feature #mobile", "--parent", "f129", "--board", p]).code).toBe(0);
    const line = todoLine(p)!;
    expect(line).toContain("#feature");
    expect(line).toContain("#mobile");
    expect(line).toContain("#high");
  });

  test("an explicit priority in --tags beats the parent's", () => {
    const p = boardPath("## todo\n\n\n## Done\n\n");
    seed(p, parentTasks);
    const r = run(["file-finding", "launch chrome follows scheme", "--file", featureBody(p),
      "--tags", "#low #feature", "--parent", "F129", "--board", p]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("inherited");
    expect(todoLine(p)).toContain("#low");
    expect(todoLine(p)).not.toContain("#high");
  });

  test("an unknown --parent refuses and writes nothing — no silent fall back to #low", () => {
    const p = boardPath("## todo\n\n\n## Done\n\n");
    seed(p, parentTasks);
    const r = run(["file-finding", "launch chrome follows scheme", "--file", featureBody(p),
      "--parent", "F999", "--board", p]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--parent F999: no task with that ref/);
    expect(todoLine(p)).toBeUndefined();
  });

  test("END TO END: the inherited #high survives consume into tasks.json", () => {
    const p = boardPath("## todo\n\n\n## Done\n\n");
    seed(p, parentTasks);
    expect(run(["file-finding", "launch chrome follows scheme", "--file", featureBody(p),
      "--tags", "#feature", "--parent", "F129", "--board", p]).code).toBe(0);
    const lineNo = readFileSync(p, "utf8").split("\n")
      .findIndex(l => l.includes("launch chrome follows"));
    const c = run(["consume", String(lineNo), "--ref", "F200", "--slug", "launch-chrome-follows-scheme",
      "--board", p]);
    expect(c.code).toBe(0);
    const ledger = JSON.parse(readFileSync(join(dirname(p), "tasks.json"), "utf8"));
    const child = Object.values(ledger).find((t: any) => t.ref === "F200") as any;
    expect(child.priority).toBe("high");
  });
});

describe("play-around cap — #medium is the ceiling for non-feature findings", () => {
  const tasksFor = (board: string) => join(dirname(board), "tasks.json");
  const cardsDir = (board: string) => join(dirname(board), "cards");
  const lineFor = (board: string, text: string) =>
    readFileSync(board, "utf8").split("\n").find(line => line.includes(text))!;
  const lineIndex = (board: string, text: string) =>
    readFileSync(board, "utf8").split("\n").findIndex(line => line.includes(text));

  function bodyFor(board: string, name: string, feature = false): string {
    const path = join(dirname(board), `${name}.md`);
    writeFileSync(path, feature
      ? "## Problem\n\n" + "The requested control is absent from the current surface. ".repeat(3) +
        "\n\n## How to try it\n\nCurrent behaviour (not built yet):\n\n" +
        "1. Open Library from a cold app and look for Quick add.\n"
      : "## Problem\n\n" + "The pane stays unchanged when the reporter opens it. ".repeat(3) +
        "\n\n## Reproduction steps\n\n1. Open /rooms at 390px from a cold app.\n\n" +
        "**Expected:** The pane opens.\n**Actual:** It stays unchanged.\n");
    return path;
  }

  function fileFinding(
    board: string, title: string, tags: string, feature = false,
  ): ReturnType<typeof run> {
    return run(["file-finding", title, "--file", bodyFor(board, `${title}-body`, feature),
      "--tags", tags, "--board", board, "--tasks", tasksFor(board)]);
  }

  function consumeFinding(
    board: string, title: string, ref: string, slug: string, priority?: string,
  ): ReturnType<typeof run> {
    const args = ["consume", String(lineIndex(board, title)), "--ref", ref, "--slug", slug,
      "--board", board, "--tasks", tasksFor(board)];
    if (priority) args.push("--priority", priority);
    return run(args);
  }

  test("unit helpers identify only explicit features, origins, and marker lines", () => {
    expect(isFeatureCard("F12", [])).toBe(true);
    expect(isFeatureCard("f9", [])).toBe(true);
    expect(isFeatureCard("T12", ["#FEATURE"])).toBe(true);
    expect(isFeatureCard("T12", ["#bug"])).toBe(false);

    expect(playAroundCap("high", PLAY_AROUND_ORIGIN, false)).toBe("medium");
    expect(playAroundCap("HIGH", PLAY_AROUND_ORIGIN, false)).toBe("medium");
    expect(playAroundCap("medium", PLAY_AROUND_ORIGIN, false)).toBe("medium");
    expect(playAroundCap("low", PLAY_AROUND_ORIGIN, false)).toBe("low");
    expect(playAroundCap("high", PLAY_AROUND_ORIGIN, true)).toBe("high");
    expect(playAroundCap("high", undefined, false)).toBe("high");

    expect(hasPlayAroundMarker(`before\n  ${SOURCE_MARKER}  \nafter`)).toBe(true);
    expect(hasPlayAroundMarker(`${SOURCE_MARKER} extra`)).toBe(false);
    expect(hasPlayAroundMarker("ordinary note")).toBe(false);
  });

  test("file-finding caps a #bug #high line and marks its note", () => {
    const board = boardPath("## todo\n\n\n## Done\n\n");
    const title = "room pane stays blank";
    const result = fileFinding(board, title, "#bug #high");
    expect(result.code).toBe(0);
    expect(result.out).toContain("capped #high → #medium");
    expect(lineFor(board, title)).toContain("#bug #medium");
    expect(lineFor(board, title)).not.toContain("#high");
    expect(readFileSync(join(cardsDir(board), "room-pane-stays-blank.md"), "utf8")
      .split("\n")[0]).toBe(SOURCE_MARKER);
  });

  test("file-finding leaves a #feature #high line high and still marks its note", () => {
    const board = boardPath("## todo\n\n\n## Done\n\n");
    const title = "library needs quick add";
    const result = fileFinding(board, title, "#feature #high", true);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("capped #high");
    expect(lineFor(board, title)).toContain("#feature #high");
    expect(readFileSync(join(cardsDir(board), "library-needs-quick-add.md"), "utf8")
      .split("\n")[0]).toBe(SOURCE_MARKER);
  });

  test("file-finding leaves #low #bug unchanged and marks its note", () => {
    const board = boardPath("## todo\n\n\n## Done\n\n");
    const title = "composer loses draft";
    expect(fileFinding(board, title, "#low #bug").code).toBe(0);
    expect(lineFor(board, title)).toContain("#low #bug");
    expect(readFileSync(join(cardsDir(board), "composer-loses-draft.md"), "utf8")
      .split("\n")[0]).toBe(SOURCE_MARKER);
  });

  test("consume caps an explicit high play-around bug in the ledger and rendered line", () => {
    const board = boardPath("## todo\n\n\n## Done\n\n");
    const title = "room list stays blank";
    expect(fileFinding(board, title, "#bug #low").code).toBe(0);
    const result = consumeFinding(board, title, "T301", "room-list-stays-blank", "high");
    expect(result.code).toBe(0);
    expect(result.err).toContain("capped #high → #medium for T301");
    const entry = JSON.parse(readFileSync(tasksFor(board), "utf8"))["room-list-stays-blank"];
    expect(entry.priority).toBe("medium");
    expect(entry.origin).toBe(PLAY_AROUND_ORIGIN);
    const line = lineFor(board, "T301 ·");
    const priorities = (line.match(/#[A-Za-z0-9_-]+/g) ?? [])
      .filter(tag => ["#low", "#medium", "#high"].includes(tag.toLowerCase()));
    expect(priorities).toEqual(["#medium"]);
  });

  test("consume keeps play-around features high by tag or F ref and records origin", () => {
    const tagged = boardPath("## todo\n\n\n## Done\n\n");
    const taggedTitle = "library gets quick add";
    expect(fileFinding(tagged, taggedTitle, "#feature #high", true).code).toBe(0);
    expect(consumeFinding(tagged, taggedTitle, "T302", "library-gets-quick-add", "high").code)
      .toBe(0);
    const taggedEntry = JSON.parse(readFileSync(tasksFor(tagged), "utf8"))["library-gets-quick-add"];
    expect(taggedEntry.priority).toBe("high");
    expect(taggedEntry.origin).toBe(PLAY_AROUND_ORIGIN);
    expect(lineFor(tagged, "T302 ·")).toContain("#high");

    const byRef = boardPath("## todo\n\n\n## Done\n\n");
    const refTitle = "rooms need faster search";
    expect(fileFinding(byRef, refTitle, "#bug #low").code).toBe(0);
    expect(consumeFinding(byRef, refTitle, "F303", "rooms-need-faster-search", "high").code)
      .toBe(0);
    const refEntry = JSON.parse(readFileSync(tasksFor(byRef), "utf8"))["rooms-need-faster-search"];
    expect(refEntry.priority).toBe("high");
    expect(refEntry.origin).toBe(PLAY_AROUND_ORIGIN);
  });

  test("consume leaves hand-written short and long-title cards high and unmarked", () => {
    const shortBoard = boardPath("## todo\n\n- [ ] a hand thing #bug #high\n\n\n## Done\n\n");
    const shortResult = consumeFinding(shortBoard, "a hand thing", "T304", "a-hand-thing", "high");
    expect(shortResult.code).toBe(0);
    const shortEntry = JSON.parse(readFileSync(tasksFor(shortBoard), "utf8"))["a-hand-thing"];
    expect(shortEntry.priority).toBe("high");
    expect("origin" in shortEntry).toBe(false);

    const longBoard = boardPath(`## todo\n\n- [ ] ${LONG} #bug #high\n\n\n## Done\n\n`);
    const tasks = tasksFor(longBoard);
    const result = run(["consume", String(lineIndex(longBoard, LONG)), "--ref", "T305",
      "--slug", "hand-long-title", "--title", "doc menu opens a plain pane",
      "--priority", "high", "--board", longBoard, "--tasks", tasks]);
    expect(result.code).toBe(0);
    const entry = JSON.parse(readFileSync(tasks, "utf8"))["hand-long-title"];
    expect(entry.priority).toBe("high");
    expect("origin" in entry).toBe(false);
    expect(hasPlayAroundMarker(
      readFileSync(join(cardsDir(longBoard), "hand-long-title.md"), "utf8"))).toBe(false);
  });

  test("priority refuses high atomically for play-around bugs but allows all stated exceptions", () => {
    const bugBoard = boardPath("## todo\n\n\n## Done\n\n");
    const bugTitle = "thread pane stops loading";
    expect(fileFinding(bugBoard, bugTitle, "#bug #medium").code).toBe(0);
    expect(consumeFinding(bugBoard, bugTitle, "T306", "thread-pane-stops-loading").code)
      .toBe(0);
    const bugTasks = tasksFor(bugBoard);
    const before = [readFileSync(bugTasks, "utf8"), readFileSync(bugBoard, "utf8")];
    const refused = run(["priority", "T306", "high", "--board", bugBoard, "--tasks", bugTasks]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("Nicholas");
    expect(refused.err).toContain("by hand");
    expect([readFileSync(bugTasks, "utf8"), readFileSync(bugBoard, "utf8")]).toEqual(before);
    expect(run(["priority", "T306", "low", "--board", bugBoard, "--tasks", bugTasks]).code)
      .toBe(0);
    expect(run(["priority", "T306", "medium", "--board", bugBoard, "--tasks", bugTasks]).code)
      .toBe(0);

    const featureBoard = boardPath("## todo\n\n\n## Done\n\n");
    const featureTitle = "library gets pinned views";
    expect(fileFinding(featureBoard, featureTitle, "#feature #low", true).code).toBe(0);
    expect(consumeFinding(featureBoard, featureTitle, "T307", "library-gets-pinned-views").code)
      .toBe(0);
    expect(run(["priority", "T307", "high", "--board", featureBoard,
      "--tasks", tasksFor(featureBoard)]).code).toBe(0);

    const handBoard = boardPath("## todo\n\n- [ ] hand-authored bug #bug #low\n\n\n## Done\n\n");
    expect(consumeFinding(handBoard, "hand-authored bug", "T308", "hand-authored-bug").code)
      .toBe(0);
    expect(run(["priority", "T308", "high", "--board", handBoard,
      "--tasks", tasksFor(handBoard)]).code).toBe(0);
  });

  test("priority falls back to the note marker for ledgers that predate origin", () => {
    const board = boardPath("## todo\n\n\n## Done\n\n");
    const title = "sidebar stops updating";
    expect(fileFinding(board, title, "#bug #medium").code).toBe(0);
    expect(consumeFinding(board, title, "T309", "sidebar-stops-updating").code).toBe(0);
    const tasks = tasksFor(board);
    const ledger = JSON.parse(readFileSync(tasks, "utf8"));
    delete ledger["sidebar-stops-updating"].origin;
    writeFileSync(tasks, `${JSON.stringify(ledger, null, 1)}\n`);
    const result = run(["priority", "T309", "high", "--board", board, "--tasks", tasks]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("refusing #high for T309");
  });

  test("note preserves a marked source line and never invents one for an unmarked note", () => {
    const board = boardPath(SKELETON);
    const tasks = tasksFor(board);
    writeFileSync(tasks, `${JSON.stringify({
      marked: { slug: "marked", ref: "T310", status: "new", stages: {} },
      unmarked: { slug: "unmarked", ref: "T311", status: "new", stages: {} },
    }, null, 1)}\n`);
    mkdirSync(cardsDir(board), { recursive: true });
    writeFileSync(join(cardsDir(board), "marked.md"),
      `${SOURCE_MARKER}\n# Marked\n\n## Problem\n\nThe old marked body is long enough to be real.\n`);
    writeFileSync(join(cardsDir(board), "unmarked.md"),
      "# Unmarked\n\n## Problem\n\nThe old unmarked body is long enough to be real.\n");
    const markedSource = join(dirname(board), "marked-source.md");
    const unmarkedSource = join(dirname(board), "unmarked-source.md");
    writeFileSync(markedSource, "# Marked\n\n## Problem\n\nThe replacement body has no source line.\n");
    writeFileSync(unmarkedSource, "# Unmarked\n\n## Problem\n\nThe replacement body has no source line.\n");

    expect(run(["note", "marked", "--file", markedSource,
      "--board", board, "--tasks", tasks]).code).toBe(0);
    const marked = readFileSync(join(cardsDir(board), "marked.md"), "utf8");
    expect(marked.split("\n")[0]).toBe(SOURCE_MARKER);
    expect(marked.match(/om-bug-loop:source om-play-around/g)).toHaveLength(1);

    expect(run(["note", "unmarked", "--file", unmarkedSource,
      "--board", board, "--tasks", tasks]).code).toBe(0);
    expect(hasPlayAroundMarker(
      readFileSync(join(cardsDir(board), "unmarked.md"), "utf8"))).toBe(false);
  });
});

describe("filedFindingNote", () => {
  test("wraps a plain body under the template's own Problem heading", () => {
    const out = filedFindingNote("a thing broke", "the pane is byte-identical");
    expect(out).toBe("# a thing broke\n\n## Problem\n\nthe pane is byte-identical\n");
  });

  test("leaves a body that already has its own H1 alone", () =>
    expect(filedFindingNote("x", "# my own title\n\n## Problem\n\nbody"))
      .toBe("# my own title\n\n## Problem\n\nbody\n"));

  test("titles a body that opens on ## — the shape reporters actually write", () =>
    expect(filedFindingNote("doc menu: History opens a plain pane",
      "## Problem\n\nit opens a plain pane\n\n## Evidence\n\n![[a.png]]"))
      .toBe("# doc menu: History opens a plain pane\n\n## Problem\n\n" +
        "it opens a plain pane\n\n## Evidence\n\n![[a.png]]\n"));
});

describe("a filed finding may only use the card note template's headings", () => {
  test("CARD_NOTE_SECTIONS is exactly what the template defines", () => {
    const tpl = readFileSync(join(import.meta.dir, "..", "templates", "card-note-template.md"), "utf8");
    const inTemplate = (tpl.match(/^##\s+(.+?)\s*$/gm) ?? [])
      .map(h => h.replace(/^##\s+/, "").trim());
    // Drift here is the bug this constant exists to prevent: a section added to
    // the template and not here silently becomes a "stray" heading.
    expect([...CARD_NOTE_SECTIONS].sort()).toEqual([...new Set(inTemplate)].sort());
  });

  test("strayHeadings names what is not in the template", () => {
    expect(strayHeadings("## Problem\n\nx\n\n## Solution direction\n\ny")).toEqual([]);
    expect(strayHeadings("## Reference\n\nx\n\n## Suggested fix\n\ny"))
      .toEqual(["Reference", "Suggested fix"]);
  });

  test("file-finding refuses an invented heading, naming the allowed set", () => {
    const p = boardPath("## todo\n\n\n## Done\n\n");
    const body = join(dirname(p), "body.md");
    writeFileSync(body, "## Problem\n\n" + "a real observation. ".repeat(6) + "\n\n## Suggested fix\n\ndo the thing\n");
    const r = run(["file-finding", "doc menu: History opens a plain pane", "--file", body, "--board", p]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("## Suggested fix");
    expect(r.err).toContain("## Solution direction");
    expect(existsSync(join(dirname(p), "cards"))).toBe(false);
  });

  test("and accepts the shape om-play-around is told to write", () => {
    const p = boardPath("## todo\n\n\n## Done\n\n");
    const body = join(dirname(p), "body.md");
    writeFileSync(body,
      "## Problem\n\n" + "the pane it renders is byte-identical to Open. ".repeat(3) +
      "\n\n## Evidence\n\n![[kanban/evidence/pa-doc/19.png]]\n\n## Solution direction\n\nopen it expanded\n\nalt: keep it\n");
    const r = run(["file-finding", "doc menu: History opens a plain pane", "--file", body, "--board", p]);
    expect(r.code).toBe(0);
  });
});

describe("every door onto a card line honours the cap", () => {
  const LONG_TITLE = "x".repeat(TITLE_MAX + 1);

  test("upsert --title refuses one — otherwise the cap lasts until the first retitle", () => {
    const p = boardPath(SKELETON);
    writeNote(p, "a-slug");
    const r = run(["upsert", "a-slug", "--column", "todo", "--title", LONG_TITLE, "--board", p]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/over the 60-character cap/);
  });

  test("backlog refuses one — a backlog card sits on the board longest", () => {
    const p = boardPath(SKELETON);
    const r = run(["backlog", LONG_TITLE, "--board", p, "--tasks", join(dirname(p), "tasks.json")]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/over the 60-character cap/);
  });

  test("and both still accept a handle", () => {
    const p = boardPath(SKELETON);
    expect(run(["backlog", "doc menu: Archive strands a note", "--board", p,
      "--tasks", join(dirname(p), "tasks.json")]).code).toBe(0);
  });
});

describe("the review-skip tick is retired — grouping replaced it (2026-09-17)", () => {
  const SLUG = "agent-draft-dock-history-load";
  const REF = "T201";
  const TITLE = "agent draft dock: History Load is mouse-only";
  const RETIRED = "review-skip was retired on 2026-09-17 (Nicholas): cards are grouped by category instead. See references/card-categories.md.";
  const NOW = "2026-09-17T09:00:00.000Z";
  const SUMMARY = {
    problem: "Keyboard users cannot reach History Load.",
    solution: "Put History Load in the normal focus order.",
    repro: ["Open the dock.", "Press Tab."],
  };
  const cleanLine = (ref = REF, title = TITLE) =>
    `- [ ] **${ref} · ${title}** [[cards/${SLUG}|details]] #openmarket #bug #high ![[shot.png]]`;
  const legacyLine = (ref = REF, title = TITLE) =>
    cleanLine(ref, title).replace(`${ref} · `, `${ref} · ✓ `);
  const isolated = (board: string, tasks: string) =>
    ["--board", board, "--tasks", tasks, "--now", NOW];

  function noteFor(board: string, slug = SLUG): void {
    const cards = join(dirname(board), "cards");
    mkdirSync(cards, { recursive: true });
    writeFileSync(join(cards, `${slug}.md`), [
      `# ${slug}`, "", "## Problem", "",
      "Keyboard users cannot reach History Load from the agent draft dock. ".repeat(3),
      "", "## Reproduction steps", "", "1. Open the dock and press Tab.", "",
      "**Expected:** History Load receives focus.",
      "**Actual:** Focus skips History Load.", "",
      "## Work items", "", "- [ ] update the control", "",
      `![[kanban/evidence/${slug}/after.png]]`, "",
    ].join("\n"));
  }

  function fixture(line = legacyLine(), extra: Record<string, unknown> = {}) {
    const board = boardPath(SKELETON.replace(
      "## todo\n\n",
      `## todo\n\n- [ ] before this card #human\n${line}\n- [ ] after this card #human\n`,
    ));
    const tasks = join(dirname(board), "tasks.json");
    writeFileSync(tasks, `${JSON.stringify({
      [SLUG]: {
        id: 201, slug: SLUG, ref: REF, status: "implementing",
        priority: "high", product: "chat", reviewSkip: "keyboard",
        someFutureKey: { a: 1 },
        stages: { detected: "2026-09-17T07:00:00.000Z" },
        ...extra,
      },
    }, null, 1)}\n`);
    noteFor(board);
    return { board, tasks };
  }

  const cardLineFor = (board: string, slug = SLUG) =>
    readFileSync(board, "utf8").split("\n").find(line => line.includes(`cards/${slug}|`))!;

  test("review-skip always returns the retirement message without touching board or ledger", () => {
    const { board, tasks } = fixture();
    for (const command of [
      ["review-skip", "T5", "keyboard"],
      ["review-skip", "F5", "a11y", "--clear"],
      ["review-skip"],
    ]) {
      const before = [readFileSync(board), readFileSync(tasks)];
      const result = run([...command, ...isolated(board, tasks)]);
      expect(result.code).toBe(1);
      expect(result.out).toBe("");
      expect(result.err).toBe(`${RETIRED}\n`);
      expect(readFileSync(board).equals(before[0]!)).toBe(true);
      expect(readFileSync(tasks).equals(before[1]!)).toBe(true);
    }
  });

  test("stripReviewSkipMark removes repeated legacy marks only from bold card titles", () => {
    for (const ref of ["T5", "F5", "R5", "C5"]) {
      const line = `- [ ] **${ref}  ·   ✓ ✓ title** [[cards/x|details]] #tag ![[shot.png]]`;
      const expected = `- [ ] **${ref}  ·   title** [[cards/x|details]] #tag ![[shot.png]]`;
      expect(stripReviewSkipMark(line)).toBe(expected);
      expect(stripReviewSkipMark(expected)).toBe(expected);
    }
    for (const line of [
      "## todo",
      "- [ ] T5 · ✓ not bold [[cards/x|details]]",
      "- [ ] **plain ✓ title** [[cards/x|details]]",
      "prefix **T5 · ✓ title** [[cards/x|details]]",
    ]) {
      expect(stripReviewSkipMark(line)).toBe(line);
    }
  });

  test("upsert moves, upsert retitles, and priority purge a stale tick despite legacy ledger data", () => {
    for (const command of [
      ["upsert", SLUG, "--column", "in progress"],
      ["upsert", SLUG, "--column", "todo", "--title", `${REF} · renamed history control`],
      ["priority", SLUG, "medium"],
    ]) {
      const { board, tasks } = fixture();
      const beforeLines = readFileSync(board, "utf8").split("\n");
      const result = run([...command, ...isolated(board, tasks)]);
      expect(result.code).toBe(0);
      const line = cardLineFor(board);
      expect(line).not.toContain(LEGACY_TICK);
      expect(line).toContain("[[cards/agent-draft-dock-history-load|details]]");
      expect(line).toContain("![[shot.png]]");
      const afterLines = readFileSync(board, "utf8").split("\n");
      for (const sentinel of ["- [ ] before this card #human", "- [ ] after this card #human"]) {
        expect(afterLines.filter(value => value === sentinel))
          .toEqual(beforeLines.filter(value => value === sentinel));
      }
      expect(JSON.parse(readFileSync(tasks, "utf8"))[SLUG].someFutureKey).toEqual({ a: 1 });
    }
  });

  test("stamp, status, and stage do not rewrite board lines", () => {
    for (const command of [
      ["stamp", SLUG],
      ["status", SLUG, "swept"],
      ["stage", SLUG, "reviewing"],
    ]) {
      const { board, tasks } = fixture();
      const before = readFileSync(board);
      expect(run([...command, ...isolated(board, tasks)]).code).toBe(0);
      expect(readFileSync(board).equals(before)).toBe(true);
    }
  });

  test("all board parsers and list keep reading legacy-ticked T and F cards", () => {
    const featureSlug = "screen-reader-labels";
    const tLine = legacyLine();
    const fLine = `- [ ] **F204 · ✓ Screen reader labels** [[cards/${featureSlug}|details]] #openmarket #feature #low`;
    const board = boardPath(SKELETON.replace("## todo\n\n", `## todo\n\n${tLine}\n${fLine}\n`));
    const tasks = join(dirname(board), "tasks.json");
    writeFileSync(tasks, `${JSON.stringify({
      [SLUG]: { slug: SLUG, ref: REF, status: "new" },
      [featureSlug]: { slug: featureSlug, ref: "F204", status: "new" },
    }, null, 1)}\n`);

    expect(readBoardCards(board).get(SLUG)).toMatchObject({ title: TITLE, column: "todo" });
    expect(readBoardCards(board).get(featureSlug)).toMatchObject({
      title: "Screen reader labels", column: "todo",
    });
    expect(boardCardRef(board, SLUG)).toBe(REF);
    expect(boardCardRef(board, featureSlug)).toBe("F204");
    expect(boardRefs(board)).toEqual([REF, "F204"]);
    expect(nextRef(tasks, "T", board)).toBe("T202");
    expect(nextRef(tasks, "F", board)).toBe("F205");
    expect(readTitle(`**${REF} · ✓ ${TITLE}** ![[shot.png]] #high`).title).toBe(TITLE);
    expect(readTitle("**F204 · ✓ Screen reader labels** #feature").title)
      .toBe("Screen reader labels");

    const listed = run(["list", ...isolated(board, tasks)]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(TITLE);
    expect(listed.out).toContain("Screen reader labels");
    expect(listed.out).not.toContain(LEGACY_TICK);
  });

  test("group notes and restored members purge stale review-skip fields and marks", () => {
    const group = groupId("Review", "keyboard-focus");
    const parked = legacyLine();
    const board = boardPath(SKELETON.replace(
      "## Review\n\n", `## Review\n\n${groupLine("/tmp/Kanban.md", "Review", "keyboard-focus", 1)}\n`,
    ));
    const tasks = join(dirname(board), "tasks.json");
    writeFileSync(tasks, `${JSON.stringify({
      [SLUG]: {
        slug: SLUG, ref: REF, status: "shipped", priority: "high", product: "chat",
        reviewSkip: "keyboard", category: "keyboard-focus", summary: SUMMARY,
        groupedIn: group, groupedLine: parked, title: TITLE,
        mrUrl: "https://example.test/pr/201",
      },
    }, null, 1)}\n`);
    noteFor(board);

    expect(run(["stamp", SLUG, ...isolated(board, tasks)]).code).toBe(0);
    const groupNotePath = join(dirname(board), "cards", `${group}.md`);
    const note = readFileSync(groupNotePath, "utf8");
    expect(note).toContain(`## ${REF} · ${TITLE}`);
    expect(note).toContain("PR https://example.test/pr/201");
    expect(note).not.toContain(LEGACY_TICK);
    expect(note).not.toContain("skip-review:");

    expect(run(["upsert", SLUG, "--column", "Done", ...isolated(board, tasks)]).code).toBe(0);
    const restored = cardLineFor(board);
    expect(restored).toContain(`**${REF} · ${TITLE}**`);
    expect(restored).toContain("#bug #high ![[shot.png]]");
    expect(restored).not.toContain(LEGACY_TICK);
  });

  const rotate = "/Users/nicholas/.local/bin/om-kanban-rotate-lib.py";
  const hasPython = Bun.spawnSync({ cmd: ["which", "python3"], stdout: "ignore", stderr: "ignore" })
    .exitCode === 0;
  test.skipIf(!existsSync(rotate) || !hasPython)(
    "weekly rotation preserves ordinary T/F and grouped lines without relying on a tick",
    () => {
      const tLine = cleanLine();
      const fLine = cleanLine("F207", "Screen reader labels").replace("#bug", "#feature");
      const grouped = groupLine("/tmp/Kanban.md", "Review", "keyboard-focus", 3);
      const board = boardPath([
        "---", "week: 38", "week-of: 2026-09-14", "kanban-plugin: board", "---", "",
        "## todo", "", "", "## in progress", "", "", "## Need Attention", "", "",
        "## Review", "", tLine, fLine, grouped, "", "## Done", "", "", "## Withdrawn", "", "",
        "## backlog", "", "", "%% kanban:settings", "```",
        '{"kanban-plugin":"board"}', "```", "%%", "",
      ].join("\n"));
      const archive = join(dirname(board), "archive");
      const result = Bun.spawnSync({
        cmd: ["python3", rotate, "rotate", board, archive, "38", "39", "2026-09-21"],
        stdout: "pipe", stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      for (const line of [tLine, fLine, grouped]) {
        expect(readFileSync(board, "utf8")).toContain(line);
        expect(readFileSync(join(archive, "Kanban 38.md"), "utf8")).toContain(line);
      }
    },
  );
});

// ---------------------------------- the todo lane: what is loose, what is indexed
//
// Nicholas, 2026-09-20: a card he filed himself is feature-scale and wants its
// own review, so it stays LOOSE and is dispatched ahead of the sweep backlog;
// an om-play-around finding folds into the queue card. Two different questions
// meet on this lane and they take two different predicates:
//
//   fold     — ORIGIN. What keeps its own row on the board.
//   lanecard — POSITION. What the index lists, so nothing is listed twice.
//
// Selecting the index by origin too is the trap. It reads as the same rule and
// is not: `origin` only exists on cards filed after the source marker landed on
// 2026-09-17, so on 2026-09-20 that predicate dropped 61 unstarted tasks whose
// cards sit in `Withdrawn` or nowhere — no row, no index line, invisible to the
// coordinator that reads this card to choose what to dispatch.
describe("the todo lane: fold picks by origin, the queue card picks by position", () => {
  function vault(name: string) {
    const v = mkdtempSync(join(tmpdir(), `vault-${name}-`)); dirs.push(v);
    const board = join(v, "kanban", "Kanban.md");
    mkdirSync(join(dirname(board), "cards"), { recursive: true });
    writeFileSync(board, SKELETON);
    return { v, board, tasksPath: join(v, "tasks.json") };
  }
  const SWEPT = { slug: "swept-finding", ref: "T900", status: "new",
    priority: "medium", title: "sweep finding", origin: "om-play-around" };
  const BY_HAND = { slug: "hand-filed", ref: "F900", status: "new",
    priority: "high", title: "hand filed feature" };
  function place(board: string, rows: string) {
    writeFileSync(board, readFileSync(board, "utf8").replace("## todo\n", `## todo\n\n${rows}`));
  }
  const ROW = (ref: string, title: string, slug: string, tag: string) =>
    `- [ ] **${ref} · ${title}** [[kanban/cards/${slug}|details]] #openmarket ${tag}\n`;

  test("a task whose card is loose in the column is not also listed on the queue card", () => {
    const { board, tasksPath } = vault("lanecard-position");
    writeFileSync(tasksPath, JSON.stringify({ "swept-finding": SWEPT, "hand-filed": BY_HAND }));
    place(board, ROW("F900", "hand filed feature", "hand-filed", "#high"));

    expect(run(["lanecard", "todo", "--board", board, "--tasks", tasksPath]).code).toBe(0);
    const note = readFileSync(join(dirname(board), "cards", "lane-todo.md"), "utf8");
    expect(note).toContain("T900");     // no card of its own — the index is its visibility
    expect(note).not.toContain("F900"); // already a row in the column
  });

  // The regression that made me rewrite the predicate. A pre-marker task sits in
  // `Withdrawn` with no `origin` at all; the index is the only place it appears.
  test("an unstarted task with no origin, whose card was already folded, stays indexed", () => {
    const { board, tasksPath } = vault("lanecard-withdrawn");
    writeFileSync(tasksPath, JSON.stringify({
      "pre-marker": { slug: "pre-marker", ref: "T901", status: "new",
                      priority: "medium", title: "filed before the marker existed" },
    }));
    writeNote(board, "pre-marker");
    writeFileSync(board, readFileSync(board, "utf8").replace("## Withdrawn\n",
      `## Withdrawn\n\n${ROW("T901", "filed before the marker existed", "pre-marker", "#medium")}`));

    expect(run(["lanecard", "todo", "--board", board, "--tasks", tasksPath]).code).toBe(0);
    expect(readFileSync(join(dirname(board), "cards", "lane-todo.md"), "utf8")).toContain("T901");
  });

  test("fold bins the sweep card and leaves the hand-filed one on the board", () => {
    const { board, tasksPath } = vault("fold-origin");
    writeFileSync(tasksPath, JSON.stringify({ "swept-finding": SWEPT, "hand-filed": BY_HAND }));
    for (const slug of ["swept-finding", "hand-filed"]) writeNote(board, slug);
    // Both refs sit on an index, so `indexed` cannot be what separates them.
    writeFileSync(join(dirname(board), "cards", "lane-todo.md"),
      "## Summary\n- T900 · sweep finding #medium\n- F900 · hand filed feature #high\n");
    place(board, ROW("T900", "sweep finding", "swept-finding", "#medium")
               + ROW("F900", "hand filed feature", "hand-filed", "#high"));

    const r = run(["fold", "--board", board, "--tasks", tasksPath]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("folded 1 card(s)");
    expect(r.out).toContain("F900 — filed by hand");

    const after = readFileSync(board, "utf8");
    const todo = after.slice(after.indexOf("## todo"), after.indexOf("## in progress"));
    expect(todo).toContain("hand-filed");
    expect(todo).not.toContain("swept-finding");
  });
});

// ---------------------------------------------------------------------------
// Tiers (2026-09-24). `consume` records the tier the coordinator dispatches
// by; `tier` is the owner's escalation and only ever moves up. The policy is
// `tier()` in routing.ts — these pin the plumbing, not the rule.
// ---------------------------------------------------------------------------
describe("consume --tier and the up-only tier command", () => {
  const consumeWith = (tags: string, args: string[] = [], slug = "tiered") => {
    const p = boardPath(`## todo\n\n- [ ] a tiered thing ${tags}\n\n\n## Done\n\n`);
    const tasksPath = join(dirname(p), "tasks.json");
    const r = run(["consume", "2", "--ref", "T1", "--slug", slug, "--board", p, "--tasks", tasksPath, ...args]);
    const entry = existsSync(tasksPath) ? JSON.parse(readFileSync(tasksPath, "utf8"))[slug] : undefined;
    return { r, entry, p, tasksPath };
  };

  test("no --tier and no tag records normal, sourced as the default", () => {
    const { r, entry } = consumeWith("#bug");
    expect(r.code).toBe(0);
    expect(entry.tier).toBe("normal");
    expect(entry.tierSource).toBe("default");
  });

  test("the coordinator's --tier is recorded", () => {
    const { entry } = consumeWith("#bug", ["--tier", "trivial"]);
    expect(entry.tier).toBe("trivial");
    expect(entry.tierSource).toBe("judged");
  });

  test("an important category floors a trivial judgement to normal, and says so", () => {
    const { r, entry } = consumeWith("#bug", ["--tier", "trivial", "--category", "write-safety"]);
    expect(r.code).toBe(0);
    expect(entry.tier).toBe("normal");
    expect(r.err).toMatch(/floored trivial → normal/);
  });

  test("a #high feature floors at normal", () =>
    expect(consumeWith("#high #feature", ["--tier", "trivial"]).entry.tier).toBe("normal"));

  test("Nicholas's #trivial tag beats the floor", () =>
    expect(consumeWith("#trivial #bug", ["--category", "write-safety"]).entry.tier).toBe("trivial"));

  test("an unknown --tier is refused before anything is written", () => {
    const { r, entry } = consumeWith("#bug", ["--tier", "easy"]);
    expect(r.code).toBe(64);
    expect(entry).toBeUndefined();
  });

  test("tier escalates up and appends a record", () => {
    const { p, tasksPath } = consumeWith("#bug", ["--tier", "trivial"]);
    const r = run(["tier", "tiered", "normal", "--why", "cause is in the store, not the render",
      "--board", p, "--tasks", tasksPath, "--now", "2026-09-24T10:00:00.000Z"]);
    expect(r.code).toBe(0);
    const entry = JSON.parse(readFileSync(tasksPath, "utf8")).tiered;
    expect(entry.tier).toBe("normal");
    expect(entry.tierEscalations).toEqual([{
      from: "trivial", to: "normal", at: "2026-09-24T10:00:00.000Z",
      why: "cause is in the store, not the render",
    }]);
  });

  test("tier refuses to move down or sideways", () => {
    const { p, tasksPath } = consumeWith("#bug", ["--tier", "hard"]);
    const down = run(["tier", "tiered", "normal", "--why", "looks easy", "--board", p, "--tasks", tasksPath]);
    expect(down.code).toBe(1);
    expect(down.err).toMatch(/only move up/);
    const same = run(["tier", "tiered", "hard", "--why", "x", "--board", p, "--tasks", tasksPath]);
    expect(same.code).toBe(1);
  });

  test("tier demands a --why — the record is the point", () => {
    const { p, tasksPath } = consumeWith("#bug", ["--tier", "trivial"]);
    expect(run(["tier", "tiered", "normal", "--board", p, "--tasks", tasksPath]).code).toBe(64);
  });

  test("a legacy entry with no tier escalates from normal", () => {
    const { p, tasksPath } = consumeWith("#bug");
    const raw = JSON.parse(readFileSync(tasksPath, "utf8"));
    delete raw.tiered.tier; delete raw.tiered.tierSource;
    writeFileSync(tasksPath, JSON.stringify(raw));
    const r = run(["tier", "tiered", "hard", "--why", "session shape", "--board", p, "--tasks", tasksPath]);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(tasksPath, "utf8")).tiered.tierEscalations[0].from).toBe("normal");
  });
});
