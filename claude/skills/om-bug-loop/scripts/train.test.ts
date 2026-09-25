// train.test.ts — trains are tested against real local Git history and a fake
// GitHub boundary so no test can read or mutate production pipeline state.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendSurface,
  assertCommandSafe,
  buildTestCommand,
  ciSummary,
  commitRef,
  leadingRef,
  normalizeTestPath,
  parseBunSummary,
  parseBodyNotes,
  parseBodySections,
  parseBodyTable,
  parseSection,
  parseSurfaces,
  parseTestList,
  renderBody,
  trainTitle,
  withRef,
} from "./train";
import { listRows } from "./kanban";

const SCRIPT = join(import.meta.dir, "train.ts");
const KANBAN = join(import.meta.dir, "kanban.ts");
const BUN_LOG =
  "bun test v1.3.14\n\n 3 pass\n 0 fail\nRan 3 tests across 1 file. [0.10s]\n";
const F64_COMMAND =
  "bun test --isolate --tsconfig-override ./tsconfig.json # om-bug-loop:provenance arm=after commit=a3156856 at=2026-09-15T10:56:43.899Z | record, not a measurement test/account-foot-stand-down.test.tsx test/mirror-health-cue.test.ts";
setDefaultTimeout(30_000);
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function commandEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
function command(cmd: string[], cwd: string, env = commandEnv()) {
  const p = Bun.spawnSync({
    cmd,
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
function git(cwd: string, ...args: string[]): string {
  const r = command(["git", ...args], cwd, commandEnv(gitEnv(cwd)));
  if (r.code) throw new Error(`git ${args.join(" ")} failed:\n${r.err}${r.out}`);
  return r.out.trim();
}
function gitEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Train Test",
    GIT_AUTHOR_EMAIL: "train@example.test",
    GIT_COMMITTER_NAME: "Train Test",
    GIT_COMMITTER_EMAIL: "train@example.test",
  };
}
function withoutCommitterEnv(env: Record<string, string>): Record<string, string> {
  const clean = { ...env };
  delete clean.GIT_COMMITTER_NAME;
  delete clean.GIT_COMMITTER_EMAIL;
  return clean;
}

const GH_STUB = `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
const statePath = process.env.GH_STUB_STATE!;
const origin = process.env.GH_STUB_ORIGIN!;
let state = JSON.parse(readFileSync(statePath, "utf8"));
const value = (f) => {
  const i = a.indexOf(f);
  return i < 0 ? undefined : a[i + 1];
};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 1) + "\\n");
const commits = (head) => {
  const p = Bun.spawnSync({
    cmd: [
      "git",
      "--git-dir",
      origin,
      "log",
      "--reverse",
      "--format=%s",
      "refs/heads/main..refs/heads/" + head,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  return p.exitCode
    ? []
    : p.stdout
        .toString()
        .trim()
        .split(/\\r?\\n/)
        .filter(Boolean)
        .map(messageHeadline => ({ messageHeadline }));
};
if (a[0] === "repo" && a[1] === "view") {
  console.log("acme/chat");
  process.exit(0);
}
if (a[0] === "pr" && a[1] === "list") {
  const wanted = value("--state");
  const head = value("--head");
  const rows = state.prs.filter(
    p =>
      (!head || p.headRefName === head) &&
      (wanted === "all" || p.state.toLowerCase() === wanted),
  );
  console.log(JSON.stringify(rows));
  process.exit(0);
}
if (a[0] === "pr" && a[1] === "create") {
  const n = state.next++;
  const headRefName = value("--head");
  const body = readFileSync(value("--body-file"), "utf8");
  const p = {
    number: n,
    url: "https://github.com/acme/chat/pull/" + n,
    state: "OPEN",
    title: value("--title"),
    body,
    headRefName,
    createdAt: "2026-09-15T01:00:00.000Z",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [],
  };
  state.prs.push(p);
  save();
  console.log(p.url);
  process.exit(0);
}
if (a[0] === "pr" && a[1] === "view") {
  const p = state.prs.find(p => p.number === Number(a[2]));
  if (!p) process.exit(1);
  const headlines = p.commitHeadlines?.map(messageHeadline => ({ messageHeadline }));
  console.log(JSON.stringify({ ...p, commits: headlines ?? commits(p.headRefName) }));
  process.exit(0);
}
if (a[0] === "pr" && a[1] === "edit") {
  const p = state.prs.find(p => p.number === Number(a[2]));
  p.title = value("--title");
  p.body = readFileSync(value("--body-file"), "utf8");
  save();
  process.exit(0);
}
if (a[0] === "pr" && a[1] === "close") {
  const p = state.prs.find(p => p.number === Number(a[2]));
  p.state = "CLOSED";
  save();
  process.exit(0);
}
console.error("unsupported gh call: " + a.join(" "));
process.exit(2);
`;

type World = ReturnType<typeof world>;
function world() {
  const root = mkdtempSync(join(tmpdir(), "train-test-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const shared = join(root, "shared");
  mkdirSync(seed);
  git(seed, "init", "-b", "main");
  writeFileSync(join(seed, "base.txt"), "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "base");
  writeFileSync(join(seed, "common.txt"), "common\nmiddle-1\nmiddle-2\nmiddle-3\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "second base");
  git(root, "init", "--bare", origin);
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-u", "origin", "main");
  git(root, "clone", origin, shared);
  const home = join(root, "pipeline");
  const board = join(root, "vault", "kanban", "Kanban.md");
  const tasks = join(root, "tasks.json");
  mkdirSync(dirname(board), { recursive: true });
  mkdirSync(home, { recursive: true });
  const taskData = {
    "first-fix": {
      slug: "first-fix",
      ref: "T1",
      title: "First fix",
      status: "implementing",
      featureMap: "No feature surface — integration fixture",
      mystery: { keep: true },
    },
    "second-fix": {
      slug: "second-fix",
      ref: "T2",
      title: "Second fix",
      status: "implementing",
      featureMap: "No feature surface — integration fixture",
      untouched: "yes",
    },
  };
  writeFileSync(tasks, JSON.stringify(taskData, null, 1) + "\n");
  command(["bun", KANBAN, "init", "--board", board], root, commandEnv(gitEnv(root)));
  for (const [slug, ref, title] of [
    ["first-fix", "T1", "First fix"],
    ["second-fix", "T2", "Second fix"],
  ]) {
    const note = join(dirname(board), "cards", `${slug}.md`);
    mkdirSync(dirname(note), { recursive: true });
    writeFileSync(
      note,
      `# ${title}\n\nNo UI surface — integration fixture.\n\n## Reproduction steps\n\n1. Run fixture.\n\n**Expected:** fixed\n\n**Actual:** broken\n`,
    );
    command(
      [
        "bun",
        KANBAN,
        "upsert",
        ref,
        "--column",
        "in progress",
        "--title",
        title,
        "--tasks",
        tasks,
        "--board",
        board,
      ],
      root,
      commandEnv(gitEnv(root)),
    );
  }
  const surfaces = join(root, "surfaces.md");
  writeFileSync(surfaces, "# Surfaces\n\n- `sidebar` — sidebar behavior\n");
  const gh = join(root, "gh-stub");
  writeFileSync(gh, GH_STUB);
  chmodSync(gh, 0o755);
  const ghState = join(root, "gh.json");
  writeFileSync(ghState, JSON.stringify({ next: 1, prs: [] }, null, 1));
  const env = commandEnv({
    ...gitEnv(root),
    TRAIN_GH: gh,
    GH_STUB_STATE: ghState,
    GH_STUB_ORIGIN: origin,
    TRAIN_KANBAN: KANBAN,
  });
  return { root, origin, shared, home, board, tasks, surfaces, ghState, env };
}
function owner(w: World, slug: string, ref: string, file: string) {
  const path = join(w.root, slug);
  git(w.shared, "worktree", "add", "-b", `owner/${ref.toLowerCase()}`, path, "origin/main");
  writeFileSync(join(path, file), `${ref}\n`);
  git(path, "add", file);
  git(path, "commit", "-m", `fix ${slug}`);
  const section = join(w.root, `${ref}.md`);
  writeFileSync(
    section,
    `---\ntitle: ${ref === "T1" ? "First fix" : "Second fix"}\nverdict: bun test ${ref}\ntry: open ${file}\n---\n\nVerified ${slug}.\n`,
  );
  return { path, branch: `owner/${ref.toLowerCase()}`, section };
}
function runTrain(
  w: World,
  args: string[],
  repo = w.shared,
  env: Record<string, string> = w.env,
) {
  return command(
    [
      "bun",
      SCRIPT,
      ...args,
      "--home",
      w.home,
      "--tasks",
      w.tasks,
      "--board",
      w.board,
      "--surfaces",
      w.surfaces,
      "--repo",
      repo,
      "--now",
      "2026-09-15T02:00:00.000Z",
    ],
    repo,
    env,
  );
}
function first(
  w: World,
  o: ReturnType<typeof owner>,
  ref: string,
  env: Record<string, string> = w.env,
) {
  return runTrain(
    w,
    [
      "ship",
      ref,
      "--surface",
      "sidebar",
      "--branch",
      o.branch,
      "--section",
      o.section,
      "--test-cmd",
      "bun test scoped",
    ],
    o.path,
    env,
  );
}
function finish(
  w: World,
  o: ReturnType<typeof owner>,
  ref: string,
  env: Record<string, string> = w.env,
) {
  const pending = JSON.parse(
    readFileSync(join(w.home, "trains/sidebar", `${ref}.pending.json`), "utf8"),
  );
  writeFileSync(pending.logPath, BUN_LOG);
  const future = new Date("2026-09-15T02:00:01.000Z");
  utimesSync(pending.logPath, future, future);
  return runTrain(
    w,
    [
      "ship",
      ref,
      "--surface",
      "sidebar",
      "--branch",
      o.branch,
      "--section",
      o.section,
      "--verified",
      pending.logPath,
    ],
    o.path,
    env,
  );
}

function handBuiltTrain(w: World) {
  const scratch = join(w.root, "scratch");
  git(w.root, "clone", w.origin, scratch);
  git(scratch, "checkout", "-b", "main", "origin/main");
  writeFileSync(join(scratch, "hand.txt"), "hand fix\n");
  git(scratch, "add", "hand.txt");
  git(scratch, "commit", "-m", "fix sidebar thing (T2)");
  writeFileSync(join(scratch, "notes.txt"), "notes\n");
  git(scratch, "add", "notes.txt");
  git(scratch, "commit", "-m", "Document T2 notes");
  git(scratch, "push", "origin", "HEAD:refs/heads/train/sidebar");
  const body = [
    "Merge with **Rebase and merge** so each fix stays separately revertible.",
    "",
    "| fix | ref | was | files | lines ± | verifier verdict (from original PR) |",
    "|---|---|---|---|---|---|",
    "| Hand fix | T2 | #9 | 2 | +2 −0 | Original independent verifier text |",
    "",
    "Commits are cherry-picked in the order above …",
    "",
    "- #9 was approved individually, but that approval does not carry over.",
    "",
    "## Conflict resolutions",
    "",
    "None. Every commit applied cleanly in order.",
    "",
    "## Combined verification",
    "",
    "| gate | origin/main | this branch |",
    "|---|---|---|",
    "| root `tsc --noEmit` | 0 errors | **0 errors** |",
    "",
    "### Open review comments carried over",
    "",
    "None.",
    "",
    "---",
    "",
    "## T2 · Hand fix (was #9)",
    "",
    "## Problem",
    "",
    "The hand-built train needs adopting.",
    "",
    "## Root cause",
    "",
    "Its commits use existing subject conventions.",
    "",
  ].join("\n");
  const state = {
    next: 2,
    prs: [
      {
        number: 1,
        url: "https://github.com/acme/chat/pull/1",
        state: "OPEN",
        title: "train(sidebar): 1 fixes — T2",
        body,
        headRefName: "train/sidebar",
        createdAt: "2026-09-15T01:00:00.000Z",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [],
      },
    ],
  };
  writeFileSync(w.ghState, `${JSON.stringify(state, null, 1)}\n`);
}

describe("pure helpers", () => {
  test("surface parsing and appending are exact", () => {
    expect([...parseSurfaces("- `side-bar` — Side\nnot a key").entries()]).toEqual([
      ["side-bar", "Side"],
    ]);
    expect(appendSurface("# x\n", "docs", "Docs")).toBe("# x\n- `docs` — Docs\n");
  });
  test("commit refs are recognized and safely added", () => {
    expect(leadingRef("[F12] fix it")).toBe("F12");
    expect(leadingRef("t1 nope")).toBeNull();
    expect(withRef("fix it", "T1")).toBe("T1 fix it");
    expect(withRef("T1: fix it", "T1")).toBe("T1: fix it");
  });
  test("commit refs recognize real train subject conventions", () => {
    expect(commitRef("fix(right-panel): let the phone sheet fill the screen (T135)")).toBe(
      "T135",
    );
    expect(commitRef("T137: fix: keep the right panel open across a phone rotate")).toBe(
      "T137",
    );
    expect(commitRef("Document T128 session mass growth")).toBe("T128");
    expect(
      commitRef("feat(library): show the ↓ / Enter key hint beside the filter count (F13)"),
    ).toBe("F13");
    expect(commitRef("Document T128 and T129 together")).toBeNull();
    expect(commitRef("fix(right-panel): give To-dos the phone sheet header (T…")).toBeNull();
  });
  test("sections, titles, bodies, tables, and CI round-trip", () => {
    expect(parseSection("---\nverdict: yes\ntry: click\n---\nBody\n")).toEqual({
      meta: { verdict: "yes", try: "click" },
      body: "Body",
    });
    expect(trainTitle("sidebar", ["T1"])).toBe("train(sidebar): 1 fixes — T1");
    const body = renderBody(
      [
        {
          ref: "T1",
          title: "A | B",
          files: 2,
          added: 3,
          deleted: 1,
          verdict: "ok | yes",
          try: "click",
          body: "Proof",
        },
      ],
      ["loose"],
    );
    expect(
      body.startsWith(
        "**Merge with Rebase and merge.** Each fix is one or more commits whose subject starts with its ref, so any single fix can be reverted on its own.\n\n",
      ),
    ).toBe(true);
    expect(parseBodySections(body).get("T1")).toEqual({
      title: "A | B",
      body: "Proof\n\n## unattributed\n\nCommits without a leading task ref:\n\n- loose",
    });
    expect(parseBodyTable(body).get("T1")).toEqual({ verdict: "ok | yes", try: "click" });
    expect(
      ciSummary([
        { conclusion: "SUCCESS" },
        { state: "FAILURE" },
        { conclusion: null },
        { conclusion: "SKIPPED" },
      ]),
    ).toBe("1✓ 1✗ 1… 1↷");
    expect(ciSummary([])).toBe("none");
  });
  test("real-shaped body tables and notes round-trip", () => {
    const notes = [
      "Commits are cherry-picked in the order above …",
      "",
      "- #876 and #879 were approved individually.",
      "",
      "## Conflict resolutions",
      "",
      "None.",
      "",
      "## Combined verification",
      "",
      "| gate | origin/main | this branch |",
      "|---|---|---|",
      "| tsc | 0 errors | **0 errors** |",
      "",
      "---",
    ].join("\n");
    const real = [
      "Intro",
      "",
      "| fix | ref | was | files | lines ± | verifier verdict (from original PR) |",
      "|---|---|---|---|---|---|",
      "| Phone sheet | T135 | #876 | 2 | +390 −6 | Independent verifier text |",
      "",
      notes,
      "",
      "## T135 · Phone sheet (was #876)",
      "",
      "## Problem",
    ].join("\n");
    expect(parseBodyTable(real).get("T135")).toEqual({
      verdict: "Independent verifier text",
      try: "—",
    });
    expect(parseBodyNotes(real)).toBe(notes);
    const rendered = renderBody(
      [
        {
          ref: "T135",
          title: "Phone sheet",
          files: 2,
          added: 390,
          deleted: 6,
          verdict: "Independent verifier text",
          try: "—",
          body: "Proof",
        },
      ],
      [],
      notes,
    );
    expect(parseBodyNotes(rendered)).toBe(notes);
    expect(parseBodyTable(rendered).get("T135")?.verdict).toBe(
      "Independent verifier text",
    );
  });
  test("test lists drop stamp and junk lines before building an exact command", () => {
    const stamp =
      "# om-bug-loop:provenance arm=after commit=a3156856 at=2026-09-15T10:56:43.899Z | record";
    const parsed = parseTestList(
      `test/a.test.ts\n${stamp}\ntest/b.test.tsx\n`,
    );
    expect(parsed.files).toEqual(["test/a.test.ts", "test/b.test.tsx"]);
    expect(parsed.dropped).toContain(stamp);
    const command = buildTestCommand("bun test --isolate", parsed.files);
    expect(command).toBe("bun test --isolate test/a.test.ts test/b.test.tsx");
    expect(command).not.toContain("#");

    const top = parseTestList(
      `${stamp}\n<!-- om-bug-loop:provenance arm=after -->\n// om-bug-loop:provenance arm=after\n\nsee notes\n--bail\ntest/c.spec.mjs\n`,
    );
    expect(top.files).toEqual(["test/c.spec.mjs"]);
    expect(top.dropped).toEqual([
      stamp,
      "<!-- om-bug-loop:provenance arm=after -->",
      "// om-bug-loop:provenance arm=after",
      "see",
      "notes",
      "--bail",
    ]);
  });
  test("test paths normalise inside the repository and refuse escapes", () => {
    const root = mkdtempSync(join(tmpdir(), "train-path-test-"));
    roots.push(root);
    const repo = join(root, "repo");
    const inside = join(repo, "test/a.test.ts");
    mkdirSync(dirname(inside), { recursive: true });
    writeFileSync(inside, "export {};\n");
    const outside = join(root, "outside.test.ts");
    writeFileSync(outside, "export {};\n");
    const linkedRepo = join(root, "repo-link");
    symlinkSync(repo, linkedRepo);

    expect(normalizeTestPath("./test/a.test.ts", repo)).toBe("test/a.test.ts");
    expect(normalizeTestPath("test//a.test.ts", repo)).toBe("test/a.test.ts");
    expect(normalizeTestPath("test/./sub/../a.test.ts", repo)).toBe("test/a.test.ts");
    expect(normalizeTestPath(inside, repo)).toBe("test/a.test.ts");
    expect(normalizeTestPath(join(linkedRepo, "test/a.test.ts"), linkedRepo)).toBe(
      "test/a.test.ts",
    );
    expect(normalizeTestPath("test/missing.test.ts", repo)).toBe("test/missing.test.ts");
    expect(() => normalizeTestPath("../x.test.ts", repo)).toThrow(/\.\.\/x\.test\.ts/);
    expect(() => normalizeTestPath(outside, repo)).toThrow(outside);
    expect(() => normalizeTestPath("", repo)).toThrow(/""/);
    expect(() => normalizeTestPath(".", repo)).toThrow(/"\."/);
  });
  test("comments-only test lists cannot produce an unscoped command", () => {
    const parsed = parseTestList(
      "# om-bug-loop:provenance arm=after commit=a3156856\n# note\n\n",
    );
    expect(parsed.files).toEqual([]);
    expect(() => buildTestCommand("bun test", parsed.files)).toThrow(/zero test files/);
  });
  test("newline and space-separated test lists match a hand-built command", () => {
    const prefix = "bun test --isolate";
    const expected =
      "bun test --isolate test/a.test.ts test/b_test.tsx test/c.spec.mjs";
    for (const text of [
      "test/a.test.ts\ntest/b_test.tsx\ntest/c.spec.mjs\n",
      "test/a.test.ts test/b_test.tsx test/c.spec.mjs",
    ]) {
      const parsed = parseTestList(text);
      expect(buildTestCommand(prefix, parsed.files)).toBe(expected);
    }
  });
  test("unsafe test commands fail closed and bun summaries are parsed", () => {
    expect(() => assertCommandSafe(F64_COMMAND)).toThrow(/comment out part/);
    expect(() => assertCommandSafe("bun test test/a.test.ts\necho hidden")).toThrow(
      /newline/,
    );
    expect(() => assertCommandSafe('bun test "#12"')).toThrow(/#12/);
    expect(() => assertCommandSafe("bun test test/a.test.ts")).not.toThrow();
    expect(parseBunSummary("Ran 1 test across 1 file.\nRan 20 tests across 4 files.")).toEqual(
      [
        { tests: 1, files: 1 },
        { tests: 20, files: 4 },
      ],
    );
  });
  test("a mid-line comment token makes a flattened test list ambiguous", () => {
    expect(() =>
      parseTestList("test/a.test.ts # note test/b.test.ts\n"),
    ).toThrow(/test\/a\.test\.ts # note test\/b\.test\.ts/);
  });
  test("a leading provenance stamp is ignored by section parsing", () => {
    const parsed = parseSection(
      "<!-- om-bug-loop:provenance arm=after commit=a3156856 at=2026-09-15T10:56:43.899Z -->\n---\nverdict: yes\ntry: click\n---\nBody\n",
    );
    expect(parsed).toEqual({
      meta: { verdict: "yes", try: "click" },
      body: "Body",
    });
    expect(JSON.stringify(parsed)).not.toContain("provenance");
  });
  test("multiple leading provenance stamps and a blank line are ignored", () => {
    expect(
      parseSection(
        "<!-- om-bug-loop:provenance arm=before commit=11111111 at=2026-09-15T10:55:00.000Z -->\n<!-- om-bug-loop:provenance arm=after commit=a3156856 at=2026-09-15T10:56:43.899Z | record -->\n\n---\nverdict: yes\ntry: click\n---\nBody\n",
      ),
    ).toEqual({
      meta: { verdict: "yes", try: "click" },
      body: "Body",
    });
  });
  test("a provenance stamp without front matter is refused", () => {
    expect(() =>
      parseSection(
        "<!-- om-bug-loop:provenance arm=after commit=a3156856 at=2026-09-15T10:56:43.899Z -->\nverdict: yes\nBody\n",
      ),
    ).toThrow("section must start with --- front matter");
  });
  test("a non-provenance HTML comment before front matter is refused", () => {
    expect(() => parseSection("<!-- hello -->\n---\nverdict: yes\ntry: click\n---\nBody\n")).toThrow(
      "section must start with --- front matter",
    );
  });
});

test("case 1: first ship rebases, prefixes, records pending, and does not push", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt"),
    r = first(w, o, "T1");
  expect(r.code, r.err + r.out).toBe(3);
  const pending = JSON.parse(readFileSync(join(w.home, "trains/sidebar/T1.pending.json"), "utf8"));
  expect(r.out).toContain("0 commit(s) from no other fixes");
  expect(r.out).toContain(`test "$(git rev-parse HEAD)" = ${pending.head}`);
  expect(r.out).toContain(`tee ${pending.logPath}`);
  expect(git(o.path, "log", "-1", "--format=%s")).toBe("T1 fix first-fix");
  expect(git(o.path, "merge-base", "HEAD", "origin/main")).toBe(
    git(o.path, "rev-parse", "origin/main"),
  );
  expect(
    command(["git", "ls-remote", "--heads", w.origin, "train/sidebar"], w.root, w.env).out.trim(),
  ).toBe("");
});

test("case 1b: ship forces the house committer over config and env while preserving authors", () => {
  for (const ambient of ["repo config", "committer environment"] as const) {
    const w = world();
    const o = owner(w, "first-fix", "T1", "one.txt");
    git(w.shared, "config", "user.name", "wyznicholas");
    git(w.shared, "config", "user.email", "wyz@example.test");
    expect(git(o.path, "config", "user.name")).toBe("wyznicholas");

    const env = ambient === "repo config" ? withoutCommitterEnv(w.env) : w.env;
    const rebased = first(w, o, "T1", env);
    expect(rebased.code, rebased.err + rebased.out).toBe(3);
    expect(git(o.path, "log", "-1", "--format=%s")).toBe("T1 fix first-fix");
    const identities = git(
      o.path,
      "log",
      "--format=%cn%x00%ce%x00%an%x00%ae",
      "origin/main..HEAD",
    ).split(/\r?\n/);
    expect(identities.length).toBeGreaterThan(0);
    for (const identity of identities) {
      expect(identity).toBe(
        "Nicholas Wong\0nicholaswong@trontalgroup.com\0Train Test\0train@example.test",
      );
    }
  }
});

test("test-list ship drops a spliced stamp and records the scoped files", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt");
  mkdirSync(join(o.path, "test"));
  writeFileSync(join(o.path, "test/a.test.ts"), "export {};\n");
  writeFileSync(join(o.path, "test/b.test.tsx"), "export {};\n");
  const list = join(w.root, "scoped-tests.txt");
  writeFileSync(
    list,
    "test/a.test.ts\n# om-bug-loop:provenance arm=after commit=a3156856 at=2026-09-15T10:56:43.899Z | record\ntest/b.test.tsx\n",
  );
  const r = runTrain(
    w,
    [
      "ship",
      "T1",
      "--surface",
      "sidebar",
      "--branch",
      o.branch,
      "--section",
      o.section,
      "--test-cmd",
      "bun test --isolate",
      "--test-list",
      list,
    ],
    o.path,
  );
  expect(r.code, r.err + r.out).toBe(3);
  expect(r.err).toContain("dropped from test list: # om-bug-loop:provenance");
  const line = r.out.split("\n").find((part) => part.includes("git rev-parse HEAD"))!;
  expect(line).toContain("bun test --isolate test/a.test.ts test/b.test.tsx");
  expect(line).not.toContain("#");
  expect(line).not.toContain("provenance");
  const pending = JSON.parse(
    readFileSync(join(w.home, "trains/sidebar/T1.pending.json"), "utf8"),
  );
  expect(pending.testFiles).toEqual(["test/a.test.ts", "test/b.test.tsx"]);
});

test("dot-prefixed test-list entries ship with normalised command and counts", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt");
  mkdirSync(join(o.path, "test"));
  writeFileSync(join(o.path, "test/a.test.ts"), "export {};\n");
  writeFileSync(join(o.path, "test/b.test.ts"), "export {};\n");
  const list = join(w.root, "dot-prefixed-tests.txt");
  writeFileSync(list, "./test/a.test.ts\n./test/b.test.ts\n");
  const prepared = runTrain(
    w,
    [
      "ship",
      "T1",
      "--surface",
      "sidebar",
      "--branch",
      o.branch,
      "--section",
      o.section,
      "--test-list",
      list,
    ],
    o.path,
  );
  expect(prepared.code, prepared.err + prepared.out).toBe(3);
  const commandLine = prepared.out.split("\n").find((line) => line.includes("bun test"))!;
  expect(commandLine).toContain("bun test test/a.test.ts test/b.test.ts");
  expect(commandLine).not.toContain("./test/");
  const pending = JSON.parse(
    readFileSync(join(w.home, "trains/sidebar/T1.pending.json"), "utf8"),
  );
  expect(pending.testFiles).toEqual(["test/a.test.ts", "test/b.test.ts"]);
  writeFileSync(pending.logPath, "Ran 2 tests across 2 files.\n");
  const future = new Date("2026-09-15T02:00:01.000Z");
  utimesSync(pending.logPath, future, future);
  const verified = runTrain(
    w,
    [
      "ship",
      "T1",
      "--surface",
      "sidebar",
      "--branch",
      o.branch,
      "--section",
      o.section,
      "--verified",
      pending.logPath,
    ],
    o.path,
  );
  expect(verified.code, verified.err + verified.out).toBe(0);
});

test("mixed and duplicate test-list entries normalise and de-duplicate", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt");
  mkdirSync(join(o.path, "test"));
  writeFileSync(join(o.path, "test/a.test.ts"), "export {};\n");
  writeFileSync(join(o.path, "test/b.test.ts"), "export {};\n");
  const list = join(w.root, "mixed-tests.txt");
  writeFileSync(list, "./test/a.test.ts\ntest/b.test.ts\ntest/a.test.ts\n");
  const prepared = runTrain(
    w,
    [
      "ship",
      "T1",
      "--surface",
      "sidebar",
      "--branch",
      o.branch,
      "--section",
      o.section,
      "--test-list",
      list,
    ],
    o.path,
  );
  expect(prepared.code, prepared.err + prepared.out).toBe(3);
  const pending = JSON.parse(
    readFileSync(join(w.home, "trains/sidebar/T1.pending.json"), "utf8"),
  );
  expect(pending.testFiles).toEqual(["test/a.test.ts", "test/b.test.ts"]);
  expect(pending.testCmd).toBe("bun test test/a.test.ts test/b.test.ts");
  writeFileSync(pending.logPath, "Ran 2 tests across 2 files.\n");
  const future = new Date("2026-09-15T02:00:01.000Z");
  utimesSync(pending.logPath, future, future);
  const verified = runTrain(
    w,
    [
      "ship",
      "T1",
      "--surface",
      "sidebar",
      "--branch",
      o.branch,
      "--section",
      o.section,
      "--verified",
      pending.logPath,
    ],
    o.path,
  );
  expect(verified.code, verified.err + verified.out).toBe(0);
});

test("absolute test-list paths must stay inside the owner worktree", () => {
  const insideWorld = world(),
    insideOwner = owner(insideWorld, "first-fix", "T1", "one.txt");
  mkdirSync(join(insideOwner.path, "test"));
  const inside = join(insideOwner.path, "test/a.test.ts");
  writeFileSync(inside, "export {};\n");
  const insideList = join(insideWorld.root, "absolute-inside.txt");
  writeFileSync(insideList, `${inside}\n`);
  const accepted = runTrain(
    insideWorld,
    [
      "ship",
      "T1",
      "--surface",
      "sidebar",
      "--branch",
      insideOwner.branch,
      "--section",
      insideOwner.section,
      "--test-list",
      insideList,
    ],
    insideOwner.path,
  );
  expect(accepted.code, accepted.err + accepted.out).toBe(3);
  const pending = JSON.parse(
    readFileSync(join(insideWorld.home, "trains/sidebar/T1.pending.json"), "utf8"),
  );
  expect(pending.testFiles).toEqual(["test/a.test.ts"]);
  expect(pending.testCmd).toBe("bun test test/a.test.ts");

  const outsideWorld = world(),
    outsideOwner = owner(outsideWorld, "first-fix", "T1", "one.txt"),
    outside = join(outsideWorld.root, "outside.test.ts"),
    outsideList = join(outsideWorld.root, "absolute-outside.txt");
  writeFileSync(outside, "export {};\n");
  writeFileSync(outsideList, `${outside}\n`);
  const refused = runTrain(
    outsideWorld,
    [
      "ship",
      "T1",
      "--surface",
      "sidebar",
      "--branch",
      outsideOwner.branch,
      "--section",
      outsideOwner.section,
      "--test-list",
      outsideList,
    ],
    outsideOwner.path,
  );
  expect(refused.code).toBe(64);
  expect(refused.err).toContain(outside);
  expect(existsSync(join(outsideWorld.home, "trains/sidebar/T1.pending.json"))).toBe(false);
});

test("verified list mode normalises legacy dot-prefixed pending entries", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt");
  mkdirSync(join(o.path, "test"));
  writeFileSync(join(o.path, "test/a.test.ts"), "export {};\n");
  writeFileSync(join(o.path, "test/b.test.ts"), "export {};\n");
  const list = join(w.root, "legacy-pending-tests.txt");
  writeFileSync(list, "test/a.test.ts\ntest/b.test.ts\n");
  const prepared = runTrain(
    w,
    [
      "ship",
      "T1",
      "--surface",
      "sidebar",
      "--branch",
      o.branch,
      "--section",
      o.section,
      "--test-list",
      list,
    ],
    o.path,
  );
  expect(prepared.code, prepared.err + prepared.out).toBe(3);
  const pendingPath = join(w.home, "trains/sidebar/T1.pending.json");
  const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
  pending.testFiles = ["./test/a.test.ts", "./test/b.test.ts"];
  writeFileSync(pendingPath, `${JSON.stringify(pending, null, 1)}\n`);
  writeFileSync(pending.logPath, "Ran 2 tests across 2 files.\n");
  const future = new Date("2026-09-15T02:00:01.000Z");
  utimesSync(pending.logPath, future, future);
  const verified = runTrain(
    w,
    [
      "ship",
      "T1",
      "--surface",
      "sidebar",
      "--branch",
      o.branch,
      "--section",
      o.section,
      "--verified",
      pending.logPath,
    ],
    o.path,
  );
  expect(verified.code, verified.err + verified.out).toBe(0);
  expect(verified.err).not.toContain("can match at most 0");
});

test("comments-only test-list refuses before changing the branch or pending state", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt"),
    before = git(o.path, "rev-parse", "HEAD"),
    list = join(w.root, "comments-only.txt");
  writeFileSync(list, "# om-bug-loop:provenance arm=after commit=a3156856\n# note\n\n");
  const r = runTrain(
    w,
    [
      "ship",
      "T1",
      "--surface",
      "sidebar",
      "--branch",
      o.branch,
      "--section",
      o.section,
      "--test-list",
      list,
    ],
    o.path,
  );
  expect(r.code).toBe(64);
  expect(r.err).toContain("zero test files");
  expect(existsSync(join(w.home, "trains/sidebar/T1.pending.json"))).toBe(false);
  expect(git(o.path, "rev-parse", "HEAD")).toBe(before);
});

test("an F64-style inline stamp in test-cmd refuses without pending state", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt");
  const r = runTrain(
    w,
    [
      "ship",
      "T1",
      "--surface",
      "sidebar",
      "--branch",
      o.branch,
      "--section",
      o.section,
      "--test-cmd",
      F64_COMMAND,
    ],
    o.path,
  );
  expect(r.code).toBe(64);
  expect(r.err).toContain("comment out part of the test run");
  expect(existsSync(join(w.home, "trains/sidebar/T1.pending.json"))).toBe(false);
});

test("list-mode verification requires one bun summary within the file-count bounds", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt");
  mkdirSync(join(o.path, "test"));
  writeFileSync(join(o.path, "test/a.test.ts"), "export {};\n");
  writeFileSync(join(o.path, "test/b.test.ts"), "export {};\n");
  const list = join(w.root, "bounded-tests.txt");
  writeFileSync(list, "test/a.test.ts\ntest/b.test.ts\n");
  const prepared = runTrain(
    w,
    [
      "ship",
      "T1",
      "--surface",
      "sidebar",
      "--branch",
      o.branch,
      "--section",
      o.section,
      "--test-list",
      list,
    ],
    o.path,
  );
  expect(prepared.code, prepared.err + prepared.out).toBe(3);
  const pending = JSON.parse(
    readFileSync(join(w.home, "trains/sidebar/T1.pending.json"), "utf8"),
  );
  const verifiedArgs = [
    "ship",
    "T1",
    "--surface",
    "sidebar",
    "--branch",
    o.branch,
    "--section",
    o.section,
    "--verified",
    pending.logPath,
  ];
  const future = new Date("2026-09-15T02:00:01.000Z");
  const verify = (contents: string) => {
    writeFileSync(pending.logPath, contents);
    utimesSync(pending.logPath, future, future);
    return runTrain(w, verifiedArgs, o.path);
  };

  let r = verify("bun test v1.3.14\n3 pass\n");
  expect(r.code).toBe(1);
  expect(r.err).toContain("no bun test summary line");
  r = verify("Ran 2 tests across 1 file.\n");
  expect(r.code).toBe(1);
  expect(r.err).toContain("log ran 1 files but the list names 2 existing test files");
  r = verify("Ran 4 tests across 3 files.\n");
  expect(r.code).toBe(1);
  expect(r.err).toContain("list can match at most 2");
  r = verify("Ran 3 tests across 2 files.\n");
  expect(r.code, r.err + r.out).toBe(0);
});

test("case 3: full ship creates the exact PR manifest, ledger, section, and stamp", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt");
  const prepared = first(w, o, "T1");
  expect(prepared.code, prepared.err + prepared.out).toBe(3);
  const r = finish(w, o, "T1");
  expect(r.code).toBe(0);
  expect(
    command(["git", "ls-remote", "--heads", w.origin, "train/sidebar"], w.root, w.env).out,
  ).toContain("refs/heads/train/sidebar");
  const state = JSON.parse(readFileSync(w.ghState, "utf8")),
    pr = state.prs[0];
  expect(pr.title).toBe("train(sidebar): 1 fixes — T1");
  expect(pr.body.split("\n")[0]).toBe(
    "**Merge with Rebase and merge.** Each fix is one or more commits whose subject starts with its ref, so any single fix can be reverted on its own.",
  );
  expect(pr.body).toContain("| First fix | T1 | 1 | +1 −0 | bun test T1 | open one.txt |");
  expect(pr.body).toContain("## T1 · First fix");
  const tasks = JSON.parse(readFileSync(w.tasks, "utf8"));
  expect(tasks["first-fix"].mrUrl).toBe(pr.url);
  expect(tasks["first-fix"].train).toBe("sidebar");
  expect(tasks["first-fix"].mystery).toEqual({ keep: true });
  expect(tasks["second-fix"].untouched).toBe("yes");
  expect(readFileSync(join(w.home, "trains/sidebar/T1.md"), "utf8")).toContain(
    "Verified first-fix",
  );
  expect(readFileSync(join(dirname(w.board), "cards/first-fix.md"), "utf8")).toContain(
    `**MR** ${pr.url}`,
  );
});

test("verified ship moves a gate-passing card to Review and marks it shipped", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt");
  const prepared = first(w, o, "T1");
  expect(prepared.code, prepared.err + prepared.out).toBe(3);
  const shipped = finish(w, o, "T1");
  expect(shipped.code, shipped.err + shipped.out).toBe(0);

  const state = JSON.parse(readFileSync(w.ghState, "utf8"));
  const pr = state.prs[0];
  const row = listRows(w.tasks, w.board).find((candidate) => candidate.slug === "first-fix");
  const tasks = JSON.parse(readFileSync(w.tasks, "utf8"));
  expect(row?.column).toBe("Review");
  expect(tasks["first-fix"].status).toBe("shipped");
  expect(tasks["first-fix"].stages.shipped).toBeDefined();
  expect(readFileSync(join(dirname(w.board), "cards/first-fix.md"), "utf8")).toContain(
    `**MR** ${pr.url}`,
  );
});

test("a Review gate refusal leaves the shipped train intact and returns exit 5", () => {
  const w = world();
  const tasksBefore = JSON.parse(readFileSync(w.tasks, "utf8"));
  delete tasksBefore["first-fix"].featureMap;
  writeFileSync(w.tasks, `${JSON.stringify(tasksBefore, null, 1)}\n`);
  const o = owner(w, "first-fix", "T1", "one.txt");
  const prepared = first(w, o, "T1");
  expect(prepared.code, prepared.err + prepared.out).toBe(3);
  const shipped = finish(w, o, "T1");

  expect(shipped.code).toBe(5);
  expect(
    command(["git", "ls-remote", "--heads", w.origin, "train/sidebar"], w.root, w.env).out,
  ).toContain("refs/heads/train/sidebar");
  const subjects = command(
    ["git", "--git-dir", w.origin, "log", "--format=%s", "main..train/sidebar"],
    w.root,
    w.env,
  );
  expect(subjects.code, subjects.err + subjects.out).toBe(0);
  expect(subjects.out.split(/\r?\n/).some((subject) => subject.startsWith("T1 "))).toBe(true);

  const state = JSON.parse(readFileSync(w.ghState, "utf8"));
  const openPrs = state.prs.filter((pr: { state: string }) => pr.state === "OPEN");
  expect(openPrs).toHaveLength(1);
  const pr = openPrs[0];
  expect(pr.body).toContain("## T1 · First fix");
  const tasks = JSON.parse(readFileSync(w.tasks, "utf8"));
  expect(tasks["first-fix"].mrUrl).toBe(pr.url);
  expect(tasks["first-fix"].train).toBe("sidebar");
  expect(shipped.err).toContain('refusing to move "first-fix" into "Review"');
  expect(shipped.err).toContain(
    `SHIPPED onto ${pr.url}, but the card could not move to Review. Fix the note, then run: kanban.ts upsert first-fix --column Review`,
  );
  expect(shipped.out).toContain("T1 shipped on train/sidebar");
  expect(listRows(w.tasks, w.board).find((row) => row.slug === "first-fix")?.column).toBe(
    "in progress",
  );
  expect(readFileSync(join(dirname(w.board), "cards/first-fix.md"), "utf8")).toContain(
    `**MR** ${pr.url}`,
  );
  expect(existsSync(join(w.home, "trains/sidebar/T1.pending.json"))).toBe(false);
});

test("an already-Review shipped card only receives the final stamp", () => {
  const w = world();
  const moved = command(
    [
      "bun",
      KANBAN,
      "upsert",
      "first-fix",
      "--column",
      "Review",
      "--tasks",
      w.tasks,
      "--board",
      w.board,
    ],
    w.root,
    w.env,
  );
  expect(moved.code, moved.err + moved.out).toBe(0);
  const status = command(
    [
      "bun",
      KANBAN,
      "status",
      "first-fix",
      "shipped",
      "--tasks",
      w.tasks,
      "--board",
      w.board,
    ],
    w.root,
    w.env,
  );
  expect(status.code, status.err + status.out).toBe(0);
  const stagesBefore = JSON.parse(readFileSync(w.tasks, "utf8"))["first-fix"].stages;
  const boardBefore = readFileSync(w.board, "utf8");

  const o = owner(w, "first-fix", "T1", "one.txt");
  const prepared = first(w, o, "T1");
  expect(prepared.code, prepared.err + prepared.out).toBe(3);
  const commandLog = join(w.root, "kanban-commands.log");
  const wrapper = join(w.root, "kanban-wrapper.ts");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.TRAIN_KANBAN_LOG, args.join("\\t") + "\\n");
const child = Bun.spawnSync({
  cmd: ["bun", process.env.REAL_KANBAN, ...args],
  env: process.env,
  stdout: "pipe",
  stderr: "pipe",
});
process.stdout.write(child.stdout.toString());
process.stderr.write(child.stderr.toString());
process.exit(child.exitCode);
`,
  );
  const wrapperEnv = commandEnv({
    ...w.env,
    TRAIN_KANBAN: wrapper,
    TRAIN_KANBAN_LOG: commandLog,
    REAL_KANBAN: KANBAN,
  });
  const shipped = finish(w, o, "T1", wrapperEnv);
  expect(shipped.code, shipped.err + shipped.out).toBe(0);

  const state = JSON.parse(readFileSync(w.ghState, "utf8"));
  const pr = state.prs[0];
  const tasks = JSON.parse(readFileSync(w.tasks, "utf8"));
  expect(listRows(w.tasks, w.board).find((row) => row.slug === "first-fix")?.column).toBe(
    "Review",
  );
  expect(tasks["first-fix"].status).toBe("shipped");
  expect(tasks["first-fix"].stages).toEqual(stagesBefore);
  expect(readFileSync(w.board, "utf8")).toBe(boardBefore);
  expect(readFileSync(join(dirname(w.board), "cards/first-fix.md"), "utf8")).toContain(
    `**MR** ${pr.url}`,
  );
  const invocations = readFileSync(commandLog, "utf8").trim().split(/\r?\n/);
  expect(invocations.some((line) => line.startsWith("stamp\tfirst-fix\t"))).toBe(true);
  expect(invocations.some((line) => /^(stage|status|upsert)\t/.test(line))).toBe(false);
});

test("a stamped section ships and the PR body carries no stamp", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt");
  const section =
    "<!-- om-bug-loop:provenance arm=after commit=a3156856 at=2026-09-15T10:56:43.899Z | record -->\n" +
    readFileSync(o.section, "utf8");
  writeFileSync(o.section, section);
  const prepared = first(w, o, "T1");
  expect(prepared.code, prepared.err + prepared.out).toBe(3);
  const shipped = finish(w, o, "T1");
  expect(shipped.code, shipped.err + shipped.out).toBe(0);
  const state = JSON.parse(readFileSync(w.ghState, "utf8")),
    pr = state.prs[0];
  expect(pr.body).toContain("## T1 · First fix");
  expect(pr.body).toContain("| First fix | T1 | 1 | +1 −0 | bun test T1 | open one.txt |");
  expect(pr.body).not.toContain("provenance");
  expect(pr.body).not.toContain("_No section stored");
  expect(readFileSync(join(w.home, "trains/sidebar/T1.md"), "utf8")).toContain(
    "om-bug-loop:provenance",
  );
  expect(readFileSync(o.section, "utf8")).toBe(section);
});

test("two stamps and a blank line ship", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt");
  writeFileSync(
    o.section,
    "<!-- om-bug-loop:provenance arm=before commit=11111111 at=2026-09-15T10:55:00.000Z -->\n<!-- om-bug-loop:provenance arm=after commit=a3156856 at=2026-09-15T10:56:43.899Z | record -->\n\n" +
      readFileSync(o.section, "utf8"),
  );
  const prepared = first(w, o, "T1");
  expect(prepared.code, prepared.err + prepared.out).toBe(3);
  const shipped = finish(w, o, "T1");
  expect(shipped.code, shipped.err + shipped.out).toBe(0);
  const state = JSON.parse(readFileSync(w.ghState, "utf8")),
    pr = state.prs[0];
  expect(pr.body).toContain("## T1 · First fix");
  expect(pr.body).not.toContain("provenance");
  expect(pr.body).not.toContain("_No section stored");
});

test("a stamp without front matter is refused", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt");
  writeFileSync(
    o.section,
    "<!-- om-bug-loop:provenance arm=after commit=a3156856 at=2026-09-15T10:56:43.899Z -->\nverdict: yes\nBody\n",
  );
  const refused = first(w, o, "T1");
  expect(refused.code).not.toBe(0);
  expect(refused.err).toContain("section must start with --- front matter");
  expect(existsSync(join(w.home, "trains/sidebar/T1.pending.json"))).toBe(false);
});

test("case 2: missing, empty, and pre-rebase verification logs cannot push", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt");
  expect(first(w, o, "T1").code).toBe(3);
  const pending = JSON.parse(readFileSync(join(w.home, "trains/sidebar/T1.pending.json"), "utf8"));
  const verifiedArgs = [
    "ship",
    "T1",
    "--surface",
    "sidebar",
    "--branch",
    o.branch,
    "--section",
    o.section,
    "--verified",
    pending.logPath,
  ];
  let r = runTrain(w, verifiedArgs, o.path);
  expect(r.code).toBe(1);
  expect(r.err).toContain("does not exist");
  writeFileSync(pending.logPath, "");
  r = runTrain(w, verifiedArgs, o.path);
  expect(r.code).toBe(1);
  expect(r.err).toContain("is empty");
  writeFileSync(pending.logPath, "old result\n");
  const old = new Date("2026-09-14T00:00:00Z");
  utimesSync(pending.logPath, old, old);
  r = runTrain(w, verifiedArgs, o.path);
  expect(r.code).toBe(1);
  expect(r.err).toContain("older than the rebase");
  expect(
    command(["git", "ls-remote", "--heads", w.origin, "train/sidebar"], w.root, w.env).out.trim(),
  ).toBe("");
});

test("cases 4 and 9: append edits one PR, then drop surgically removes one fix", () => {
  const w = world(),
    one = owner(w, "first-fix", "T1", "one.txt");
  first(w, one, "T1");
  expect(finish(w, one, "T1").code).toBe(0);
  const two = owner(w, "second-fix", "T2", "two.txt");
  const prep = first(w, two, "T2");
  expect(prep.code).toBe(3);
  expect(prep.out).toContain("tip ");
  expect(prep.out).toContain("1 commit(s) from T1");
  expect(finish(w, two, "T2").code).toBe(0);
  let state = JSON.parse(readFileSync(w.ghState, "utf8"));
  expect(state.prs).toHaveLength(1);
  expect(state.prs[0].title).toBe("train(sidebar): 2 fixes — T1, T2");
  expect(state.prs[0].body).toContain("## T1 · First fix");
  expect(state.prs[0].body).toContain("## T2 · Second fix");
  expect(git(w.shared, "fetch", "origin")).toBe("");
  expect(
    git(w.shared, "log", "--reverse", "--format=%s", "origin/main..origin/train/sidebar"),
  ).toBe("T1 fix first-fix\nT2 fix second-fix");
  git(w.shared, "config", "user.name", "wyznicholas");
  git(w.shared, "config", "user.email", "wyz@example.test");
  const dropped = runTrain(
    w,
    ["drop", "T1", "--surface", "sidebar", "--reason", "test"],
    w.shared,
    withoutCommitterEnv(w.env),
  );
  expect(dropped.code).toBe(0);
  git(w.shared, "fetch", "origin");
  expect(git(w.shared, "log", "--format=%s", "origin/main..origin/train/sidebar")).toBe(
    "T2 fix second-fix",
  );
  const identities = git(
    w.shared,
    "log",
    "--format=%cn%x00%ce%x00%an%x00%ae",
    "origin/main..origin/train/sidebar",
  ).split(/\r?\n/);
  expect(identities.length).toBeGreaterThan(0);
  for (const identity of identities) {
    expect(identity).toBe(
      "Nicholas Wong\0nicholaswong@trontalgroup.com\0Train Test\0train@example.test",
    );
  }
  state = JSON.parse(readFileSync(w.ghState, "utf8"));
  expect(state.prs[0].title).toBe("train(sidebar): 1 fixes — T2");
  expect(state.prs[0].body).not.toContain("## T1 ·");
  const tasks = JSON.parse(readFileSync(w.tasks, "utf8"));
  expect(tasks["first-fix"].mrUrl).toBeNull();
  expect("train" in tasks["first-fix"]).toBe(false);
  const board = readFileSync(w.board, "utf8");
  expect(board.split("## Need Attention")[1].split("\n## ")[0]).toContain("cards/first-fix|");
});

test("case 5a: a disjoint train move is adopted without a second verification", () => {
  const w = world();
  const one = owner(w, "first-fix", "T1", "one.txt");
  expect(first(w, one, "T1").code).toBe(3);
  const two = owner(w, "second-fix", "T2", "two.txt");
  expect(first(w, two, "T2").code).toBe(3);
  expect(finish(w, two, "T2").code).toBe(0);
  const shipped = finish(w, one, "T1");
  expect(shipped.code, shipped.err + shipped.out).toBe(0);
  expect(shipped.out).toContain("train base moved by");
  git(w.shared, "fetch", "origin");
  expect(
    git(w.shared, "log", "--reverse", "--format=%s", "origin/main..origin/train/sidebar"),
  ).toBe("T2 fix second-fix\nT1 fix first-fix");
});

test("case 5b: an overlapping clean train move requires reverification", () => {
  const w = world();
  const one = owner(w, "first-fix", "T1", "one.txt");
  writeFileSync(
    join(one.path, "common.txt"),
    "common\nmiddle-1\nmiddle-2\nmiddle-3\nT1 appended\n",
  );
  git(one.path, "add", "common.txt");
  git(one.path, "commit", "-m", "append common");
  expect(first(w, one, "T1").code).toBe(3);
  const two = owner(w, "second-fix", "T2", "two.txt");
  writeFileSync(join(two.path, "common.txt"), "T2 changed\nmiddle-1\nmiddle-2\nmiddle-3\n");
  git(two.path, "add", "common.txt");
  git(two.path, "commit", "-m", "change common first line");
  expect(first(w, two, "T2").code).toBe(3);
  expect(finish(w, two, "T2").code).toBe(0);
  const moved = finish(w, one, "T1");
  expect(moved.code, moved.err + moved.out).toBe(3);
  expect(moved.out).toContain("common.txt");
  git(w.shared, "fetch", "origin");
  expect(
    git(w.shared, "log", "--reverse", "--format=%s", "origin/main..origin/train/sidebar"),
  ).toBe("T2 fix second-fix\nT2 change common first line");
});

test("case 6: a cherry-pick conflict restores the branch and leaves no pending state", () => {
  const w = world();
  const one = owner(w, "first-fix", "T1", "one.txt");
  writeFileSync(join(one.path, "common.txt"), "A\n");
  git(one.path, "add", "common.txt");
  git(one.path, "commit", "-m", "change common to A");
  expect(first(w, one, "T1").code).toBe(3);
  expect(finish(w, one, "T1").code).toBe(0);
  const two = owner(w, "second-fix", "T2", "two.txt");
  writeFileSync(join(two.path, "common.txt"), "B\n");
  git(two.path, "add", "common.txt");
  git(two.path, "commit", "-m", "change common to B");
  const original = git(two.path, "rev-parse", "HEAD");
  const conflicted = first(w, two, "T2");
  expect(conflicted.code, conflicted.err + conflicted.out).toBe(4);
  expect(conflicted.err).toContain("common.txt");
  expect(git(two.path, "rev-parse", "HEAD")).toBe(original);
  expect(existsSync(join(w.home, "trains/sidebar/T2.pending.json"))).toBe(false);
});

test("case 8: a hand-built train is adopted without losing evidence", () => {
  const w = world();
  handBuiltTrain(w);
  const one = owner(w, "first-fix", "T1", "one.txt");
  expect(first(w, one, "T1").code).toBe(3);
  expect(finish(w, one, "T1").code).toBe(0);
  let state = JSON.parse(readFileSync(w.ghState, "utf8"));
  const updated = state.prs[0].body;
  expect(state.prs[0].title).toBe("train(sidebar): 2 fixes — T2, T1");
  expect(updated).toContain("Commits are cherry-picked in the order above");
  expect(updated).toContain("## Combined verification");
  expect(updated).toContain("## T2 · Hand fix (was #9)");
  expect(updated).toContain("## Root cause");
  expect(updated).toContain("Original independent verifier text");
  expect(updated).toContain("## T1 · First fix");
  expect(updated).not.toContain("## unattributed");
  expect(readFileSync(join(w.home, "trains/sidebar/T2.md"), "utf8")).toContain(
    "source: imported",
  );
  expect(readFileSync(join(w.home, "trains/sidebar/_notes.md"), "utf8")).toContain(
    "## Combined verification",
  );
  state.prs[0].state = "MERGED";
  state.prs[0].commitHeadlines = [
    "fix sidebar thing (T…",
    "T1 fix first-fix",
  ];
  writeFileSync(w.ghState, `${JSON.stringify(state, null, 1)}\n`);
  const landed = runTrain(w, ["landed"]);
  expect(landed.code, landed.err + landed.out).toBe(0);
  expect(landed.out).toContain("T2 → Done");
  expect(landed.out).toContain("T1 → Done");
});

test("case 8b: drop removes suffix and sole-token commits from an adopted train", () => {
  const w = world();
  handBuiltTrain(w);
  const one = owner(w, "first-fix", "T1", "one.txt");
  expect(first(w, one, "T1").code).toBe(3);
  expect(finish(w, one, "T1").code).toBe(0);
  const dropped = runTrain(w, ["drop", "T2", "--surface", "sidebar"]);
  expect(dropped.code, dropped.err + dropped.out).toBe(0);
  git(w.shared, "fetch", "origin");
  expect(git(w.shared, "log", "--format=%s", "origin/main..origin/train/sidebar")).toBe(
    "T1 fix first-fix",
  );
});

test("case 8c: ship refuses a surface owned by another repository", () => {
  const w = world();
  mkdirSync(join(w.home, "trains/sidebar"), { recursive: true });
  writeFileSync(
    join(w.home, "trains/sidebar/train.json"),
    JSON.stringify({ repo: "other/repo", pr: { number: 44 } }),
  );
  const one = owner(w, "first-fix", "T1", "one.txt");
  const result = first(w, one, "T1");
  expect(result.code).toBe(1);
  expect(result.err).toContain(
    'surface "sidebar" is already a train in other/repo (PR #44)',
  );
  expect(result.err).toContain("--surface chat-sidebar");
});

test("case 7: a merged train is archived and replaced by a fresh PR", () => {
  const w = world(),
    one = owner(w, "first-fix", "T1", "one.txt");
  first(w, one, "T1");
  finish(w, one, "T1");
  let state = JSON.parse(readFileSync(w.ghState, "utf8"));
  state.prs[0].state = "MERGED";
  writeFileSync(w.ghState, JSON.stringify(state, null, 1) + "\n");
  const two = owner(w, "second-fix", "T2", "two.txt");
  const prep = first(w, two, "T2");
  expect(prep.code).toBe(3);
  expect(prep.out).toContain("fresh from origin/main");
  const shipped = finish(w, two, "T2");
  expect(shipped.code, shipped.err + shipped.out).toBe(0);
  state = JSON.parse(readFileSync(w.ghState, "utf8"));
  expect(state.prs).toHaveLength(2);
  expect(state.prs[1].title).toBe("train(sidebar): 1 fixes — T2");
  git(w.shared, "fetch", "origin");
  expect(git(w.shared, "log", "--format=%s", "origin/main..origin/train/sidebar")).toBe(
    "T2 fix second-fix",
  );
  expect(readFileSync(join(w.home, "trains/sidebar/archive/1/T1.md"), "utf8")).toContain(
    "Verified first-fix",
  );
  expect(state.prs[1].body).not.toContain("## T1 ·");
});

test("case 10: dropping the last ref closes the PR", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt");
  first(w, o, "T1");
  finish(w, o, "T1");
  const r = runTrain(w, ["drop", "T1", "--surface", "sidebar"]);
  expect(r.code, r.err + r.out).toBe(0);
  const state = JSON.parse(readFileSync(w.ghState, "utf8"));
  expect(state.prs[0].state).toBe("CLOSED");
  expect(JSON.parse(readFileSync(join(w.home, "trains/sidebar/train.json"), "utf8")).pr).toBeNull();
});

test("case 11: landed moves every known ref once", () => {
  const w = world(),
    one = owner(w, "first-fix", "T1", "one.txt");
  first(w, one, "T1");
  finish(w, one, "T1");
  const two = owner(w, "second-fix", "T2", "two.txt");
  first(w, two, "T2");
  finish(w, two, "T2");
  const state = JSON.parse(readFileSync(w.ghState, "utf8"));
  state.prs[0].state = "MERGED";
  writeFileSync(w.ghState, JSON.stringify(state, null, 1) + "\n");
  const landed = runTrain(w, ["landed"]);
  expect(landed.code).toBe(0);
  expect(landed.out).toContain("T1 → Done");
  expect(landed.out).toContain("T2 → Done");
  const done = readFileSync(w.board, "utf8").split("## Done")[1];
  expect(done).toContain("cards/first-fix|");
  expect(done).toContain("cards/second-fix|");
  expect(JSON.parse(readFileSync(w.tasks, "utf8"))["first-fix"].status).toBe("shipped");
  const again = runTrain(w, ["landed"]);
  expect(again.code).toBe(0);
  expect(again.out).toBe("");
});

test("case 12: status reports refs, mergeability, CI, emptiness, and unlanded merges", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt");
  first(w, o, "T1");
  finish(w, o, "T1");
  let state = JSON.parse(readFileSync(w.ghState, "utf8"));
  state.prs[0].createdAt = "2026-09-14T22:48:00.000Z";
  state.prs[0].statusCheckRollup = [
    { conclusion: "SUCCESS" },
    { state: "FAILURE" },
    { conclusion: null },
  ];
  writeFileSync(w.ghState, JSON.stringify(state, null, 1) + "\n");
  let r = runTrain(w, ["status"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("sidebar  #1  3h 12m  MERGEABLE/CLEAN  CI 1✓ 1✗ 1…  T1");
  state.prs[0].state = "MERGED";
  writeFileSync(w.ghState, JSON.stringify(state, null, 1) + "\n");
  r = runTrain(w, ["status"]);
  expect(r.out).toContain("no open trains");
  expect(r.out).toContain("merged, not landed: sidebar #1");
  state.prs = [];
  writeFileSync(w.ghState, JSON.stringify(state, null, 1) + "\n");
  r = runTrain(w, ["status"]);
  expect(r.out.trim()).toBe("no open trains");
});

test("case 13: dead and live locks refuse with exit 75 without stealing", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt"),
    lock = join(w.home, "locks/train-sidebar.lock");
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(
    lock,
    JSON.stringify({
      pid: 99999999,
      ref: "T9",
      command: "ship",
      startedAt: "2026-09-15T00:00:00Z",
    }),
  );
  let r = first(w, o, "T1");
  expect(r.code, r.err + r.out).toBe(75);
  expect(r.err).toContain("stale lock:");
  expect(r.err).toContain(`rm ${lock}`);
  expect(statSync(lock).isFile()).toBe(true);
  writeFileSync(
    lock,
    JSON.stringify({
      pid: process.pid,
      ref: "T9",
      command: "ship",
      startedAt: "2026-09-15T00:00:00Z",
    }),
  );
  const began = Date.now();
  r = runTrain(
    w,
    [
      "ship",
      "T1",
      "--surface",
      "sidebar",
      "--branch",
      o.branch,
      "--section",
      o.section,
      "--test-cmd",
      "bun test scoped",
      "--lock-wait",
      "1",
    ],
    o.path,
  );
  expect(r.code).toBe(75);
  expect(Date.now() - began).toBeLessThan(4000);
  expect(r.err).toContain("lock wait expired");
});

test("case 14: unknown surfaces list known keys, while new-surface appends and proceeds", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt");
  let r = runTrain(
    w,
    [
      "ship",
      "T1",
      "--surface",
      "composer",
      "--branch",
      o.branch,
      "--section",
      o.section,
      "--test-cmd",
      "bun test scoped",
    ],
    o.path,
  );
  expect(r.code).toBe(1);
  expect(r.err).toContain('unknown surface "composer"');
  expect(r.err).toContain("sidebar");
  expect(r.err).toContain("--new-surface");
  r = runTrain(
    w,
    [
      "ship",
      "T1",
      "--surface",
      "composer",
      "--new-surface",
      "composer controls",
      "--branch",
      "wrong",
      "--section",
      o.section,
      "--test-cmd",
      "bun test scoped",
    ],
    o.path,
  );
  expect(r.code).toBe(1);
  expect(readFileSync(w.surfaces, "utf8")).not.toContain("`composer`");
  r = runTrain(
    w,
    [
      "ship",
      "T1",
      "--surface",
      "composer",
      "--new-surface",
      "composer controls",
      "--branch",
      o.branch,
      "--section",
      o.section,
      "--test-cmd",
      "bun test scoped",
    ],
    o.path,
  );
  expect(r.code, r.err + r.out).toBe(3);
  expect(readFileSync(w.surfaces, "utf8")).toContain("- `composer` — composer controls");
});

test("case 15: another ref in the range and tracked dirt both refuse", () => {
  const w = world(),
    o = owner(w, "first-fix", "T1", "one.txt");
  writeFileSync(join(o.path, "foreign.txt"), "foreign\n");
  git(o.path, "add", "foreign.txt");
  git(o.path, "commit", "-m", "T2 foreign fix");
  let r = first(w, o, "T1");
  expect(r.code).toBe(1);
  expect(r.err).toContain("carries different ref T2");
  writeFileSync(join(o.path, "base.txt"), "dirty\n");
  r = first(w, o, "T1");
  expect(r.code).toBe(1);
  expect(r.err).toContain("dirty tracked worktree");
});
