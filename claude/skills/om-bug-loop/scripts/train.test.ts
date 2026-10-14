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
  parseBodyPreamble,
  parseBodySections,
  parseBodyTable,
  parseSection,
  parseSurfaces,
  parseTestList,
  parseRemoteUrl,
  gitlabCiSummary,
  resolveForge,
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
state.calls ??= [];
state.calls.push(a);
save();
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
  console.log(process.env.GH_STUB_REPO ?? "acme/chat");
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
  if (process.env.GH_STUB_TASKS) {
    const tasks = JSON.parse(readFileSync(process.env.GH_STUB_TASKS, "utf8"));
    tasks["second-fix"].otherOwnerWrite = "survives";
    writeFileSync(process.env.GH_STUB_TASKS, JSON.stringify(tasks, null, 1) + "\\n");
  }
  process.exit(0);
}
console.error("unsupported gh call: " + a.join(" "));
process.exit(2);
`;

const GLAB_STUB = `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
const statePath = process.env.GLAB_STUB_STATE;
let state = JSON.parse(readFileSync(statePath, "utf8"));
const value = f => { const i = a.indexOf(f); return i < 0 ? undefined : a[i + 1]; };
const input = value("--input") ? JSON.parse(readFileSync(value("--input"), "utf8")) : undefined;
state.calls ??= [];
state.calls.push({ argv: a, ...(input === undefined ? {} : { input }) });
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 1) + "\\n");
save();
const path = a.find(x => x.startsWith("projects/"));
const method = value("-X") ?? "GET";
const base = path.split("?")[0];
const iid = Number(/\\/merge_requests\\/(\\d+)(?:\\/|$)/.exec(base)?.[1]);
const mr = () => state.mrs.find(x => x.iid === iid);
const branch = head => {
  const p = Bun.spawnSync({ cmd: ["git", "--git-dir", process.env.GH_STUB_ORIGIN,
    "log", "--reverse", "--format=%H%x00%s", "refs/heads/main..refs/heads/" + head],
    stdout: "pipe", stderr: "pipe" });
  const rows = p.exitCode ? [] : p.stdout.toString().trim().split(/\\r?\\n/).filter(Boolean);
  return { sha: rows.at(-1)?.split("\\0")[0] ?? "", commits: rows.map(x => x.split("\\0")[1]) };
};
if (method === "POST" && /\\/merge_requests$/.test(base)) {
  const n = state.next++;
  const pushed = branch(input.source_branch);
  const row = { iid: n, web_url: "https://gitlab.com/acme/chat/-/merge_requests/" + n,
    state: "opened", title: input.title, description: input.description,
    source_branch: input.source_branch, target_branch: input.target_branch,
    created_at: "2026-09-15T01:00:00.000Z", sha: state.branchSha ?? pushed.sha,
    has_conflicts: false, detailed_merge_status: "mergeable", head_pipeline: null,
    commits: state.nextCommits ?? pushed.commits };
  state.mrs.push(row); state.nextCommits = undefined; save(); console.log(JSON.stringify(row)); process.exit(0);
}
if (method === "POST" && /\\/notes$/.test(base)) {
  mr().notes ??= []; mr().notes.push(input.body); save(); console.log("{}"); process.exit(0);
}
if (method === "PUT") {
  const row = mr();
  if (input.title !== undefined) row.title = input.title;
  if (input.description !== undefined) row.description = input.description;
  if (input.state_event === "close") row.state = "closed";
  save(); console.log(JSON.stringify(row)); process.exit(0);
}
if (/\\/commits$/.test(base)) {
  console.log(JSON.stringify((mr()?.commits ?? []).map(title => ({ title })))); process.exit(0);
}
if (iid) { console.log(JSON.stringify(mr())); process.exit(mr() ? 0 : 1); }
if (/\\/merge_requests$/.test(base)) {
  const q = new URLSearchParams(path.split("?")[1] ?? "");
  let rows = state.mrs;
  if (q.get("source_branch")) rows = rows.filter(x => x.source_branch === q.get("source_branch"));
  if (q.get("state") && q.get("state") !== "all") rows = rows.filter(x => x.state === q.get("state"));
  console.log(JSON.stringify(rows)); process.exit(0);
}
save(); console.error("unsupported glab call: " + a.join(" ")); process.exit(2);
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
  const glab = join(root, "glab-stub");
  writeFileSync(glab, GLAB_STUB);
  chmodSync(glab, 0o755);
  const glabState = join(root, "glab.json");
  writeFileSync(glabState, JSON.stringify({ next: 1, mrs: [], calls: [] }, null, 1));
  const env = commandEnv({
    ...gitEnv(root),
    TRAIN_GH: gh,
    GH_STUB_STATE: ghState,
    GH_STUB_ORIGIN: origin,
    TRAIN_GLAB: glab,
    GLAB_STUB_STATE: glabState,
    TRAIN_KANBAN: KANBAN,
  });
  return { root, origin, shared, home, board, tasks, surfaces, ghState, glabState, env };
}
function forgeWorld(kind: "gitlab" | "github", ghRepo = "acme/chat") {
  const w = world();
  const raw = `https://${kind}.com/acme/chat.git`;
  git(w.root, "config", "--global", `url.${w.origin}.insteadOf`, raw);
  git(w.shared, "remote", "set-url", "origin", raw);
  w.env = commandEnv({ ...w.env, GH_STUB_REPO: ghRepo });
  return w;
}
function migrationWorld(conflict = false) {
  const w = forgeWorld("gitlab");
  const github = join(w.root, "github.git");
  git(w.root, "init", "--bare", github);
  const source = join(w.root, "source");
  git(w.root, "clone", w.origin, source);
  git(source, "checkout", "-B", "main", "origin/main");
  writeFileSync(join(source, "source-main.txt"), "source main\n");
  git(source, "add", "source-main.txt");
  git(source, "commit", "-m", "source main");
  git(source, "remote", "set-url", "origin", github);
  git(source, "push", "-u", "origin", "main");
  git(source, "checkout", "-b", "train/sidebar");
  if (conflict) writeFileSync(join(source, "common.txt"), "source train\n");
  else writeFileSync(join(source, "one.txt"), "T1\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "T1 first migration fix");
  writeFileSync(join(source, "two.txt"), "T2\n");
  git(source, "add", "two.txt");
  git(source, "commit", "-m", "T2 second migration fix");
  git(source, "push", "-u", "origin", "train/sidebar");
  const sourceTip = git(source, "rev-parse", "HEAD");

  const destination = join(w.root, "destination");
  git(w.root, "clone", w.origin, destination);
  git(destination, "checkout", "-B", "main", "origin/main");
  if (conflict) writeFileSync(join(destination, "common.txt"), "destination main\n");
  else writeFileSync(join(destination, "destination-main.txt"), "destination main\n");
  git(destination, "add", ".");
  git(destination, "commit", "-m", "destination main");
  git(destination, "push", "origin", "main");
  git(destination, "checkout", "-b", "stale");
  writeFileSync(join(destination, "stale.txt"), "stale\n");
  git(destination, "add", "stale.txt");
  git(destination, "commit", "-m", "T99 stale train");
  git(destination, "push", "origin", "HEAD:refs/heads/train/sidebar");
  const stale = git(destination, "rev-parse", "HEAD");

  const githubUrl = "https://github.com/acme/chat.git";
  git(w.root, "config", "--global", `url.${github}.insteadOf`, githubUrl);
  git(w.shared, "remote", "add", "github", githubUrl);
  const gh = JSON.parse(readFileSync(w.ghState, "utf8"));
  gh.prs = [{ number: 9, url: "https://github.com/acme/chat/pull/9", state: "OPEN",
    title: "train(sidebar): 2 fixes — T1, T2", body: "Source body byte-for-byte.\n",
    headRefName: "train/sidebar", headRefOid: sourceTip,
    createdAt: "2026-09-15T01:00:00.000Z", mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN", statusCheckRollup: [],
    commitHeadlines: ["T1 first migration fix", "T2 second migration fix"] }];
  writeFileSync(w.ghState, JSON.stringify(gh, null, 1));
  const taskData = JSON.parse(readFileSync(w.tasks, "utf8"));
  for (const slug of ["first-fix", "second-fix"]) {
    taskData[slug].train = "sidebar";
    taskData[slug].mrUrl = "https://github.com/acme/chat/pull/9";
  }
  writeFileSync(w.tasks, JSON.stringify(taskData, null, 1));
  return { w, sourceTip, stale };
}
function pushDestinationTrain(w: World, refs: string[]): string {
  const destination = join(w.root, "destination-order");
  git(w.root, "clone", w.origin, destination);
  git(destination, "checkout", "-B", "destination-order", "origin/main");
  refs.forEach((ref, index) => {
    const file = `destination-${index}.txt`;
    writeFileSync(join(destination, file), `${ref}\n`);
    git(destination, "add", file);
    git(destination, "commit", "-m", `${ref} destination fix ${index}`);
  });
  git(destination, "push", "--force", "origin", "HEAD:refs/heads/train/sidebar");
  return git(destination, "rev-parse", "HEAD");
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
  test("train titles cap a long train with an accurate omitted count", () => {
    const refs = Array.from({ length: 95 }, (_, index) => `F${index + 1}`);
    const prefix = "train(mobile-redesign): 95 fixes — ";
    const title = trainTitle("mobile-redesign", refs);

    expect(title.length).toBeLessThanOrEqual(255);
    expect(title.startsWith(prefix)).toBe(true);
    const suffix = /, \+(\d+) more$/.exec(title);
    expect(suffix).not.toBeNull();
    const shown = title.slice(prefix.length, -suffix![0].length).split(", ");
    const omitted = Number(suffix![1]);
    expect(omitted).toBeGreaterThan(0);
    expect(omitted).toBe(95 - shown.length);
  });
  test("train titles preserve an unrestricted title at exactly 255 characters", () => {
    const surface = "boundary";
    const prefix = `train(${surface}): 1 fixes — `;
    const refs = ["x".repeat(255 - prefix.length)];
    const unrestricted = `train(${surface}): ${refs.length} fixes — ${refs.join(", ")}`;

    expect(unrestricted.length).toBe(255);
    expect(trainTitle(surface, refs)).toBe(unrestricted);
  });
  test("train titles summarize an unrestricted title at 256 characters", () => {
    const surface = "boundary";
    const prefix = `train(${surface}): 1 fixes — `;
    const refs = [`${"x".repeat(255 - prefix.length)}x`];
    const unrestricted = `train(${surface}): ${refs.length} fixes — ${refs.join(", ")}`;

    expect(unrestricted.length).toBe(256);
    const title = trainTitle(surface, refs);
    expect(title.length).toBeLessThanOrEqual(255);
    const suffix = /\+(\d+) more$/.exec(title);
    expect(suffix).not.toBeNull();
    expect(Number(suffix![1])).toBeGreaterThanOrEqual(1);
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
    expect(body).toBe(
      [
        "**Merge with Rebase and merge.** Each fix is one or more commits whose subject starts with its ref, so any single fix can be reverted on its own.",
        "",
        "| fix | ref | files | lines ± | verifier | how to try |",
        "| --- | --- | ---: | ---: | --- | --- |",
        "| A \\| B | T1 | 2 | +3 −1 | ok \\| yes | click |",
        "",
        "## T1 · A | B",
        "",
        "Proof",
        "",
        "## unattributed",
        "",
        "Commits without a leading task ref:",
        "",
        "- loose",
        "",
      ].join("\n"),
    );
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
  test("duplicate ref headings are stripped and round-trip cleanly", () => {
    const render = (body: string) =>
      renderBody(
        [
          {
            ref: "T167",
            title: "Keep one heading",
            files: 1,
            added: 2,
            deleted: 0,
            verdict: "ok",
            try: "read",
            body,
          },
        ],
        [],
      );
    const expected = render("Proof");
    const bare = render("## T167\n\nProof");
    const titled = render("## T167 · Keep one heading\n\nProof");

    expect(bare).toBe(expected);
    expect(titled).toBe(expected);
    for (const body of [bare, titled]) {
      expect(body.match(/^## T167\b/gm)).toHaveLength(1);
      expect(body).toContain("## T167 · Keep one heading\n\nProof");
      expect(parseBodySections(body).get("T167")?.body).toBe("Proof");
      expect(parseBodySections(body).get("T167")?.body).not.toMatch(/^## T167\b/);
    }
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
  // The only board change is the train card, the one card for this MR.
  const added = readFileSync(w.board, "utf8").split("\n").filter((line) => !boardBefore.includes(line));
  expect(added).toEqual([expect.stringContaining("[[cards/train-sidebar|details]]")]);
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

test("an already-pushed ref finalizes on a verified retry without a second push", () => {
  const w = world();
  const one = owner(w, "first-fix", "T1", "one.txt");
  expect(first(w, one, "T1").code).toBe(3);
  git(one.path, "push", "origin", "HEAD:refs/heads/train/sidebar");
  git(w.shared, "fetch", "origin");
  const before = git(w.shared, "rev-parse", "origin/train/sidebar");

  const shipped = finish(w, one, "T1");
  expect(shipped.code, shipped.err + shipped.out).toBe(0);
  expect(shipped.out).toContain("commits are already ancestors of train/sidebar");
  git(w.shared, "fetch", "origin");
  expect(git(w.shared, "rev-parse", "origin/train/sidebar")).toBe(before);
  const tasks = JSON.parse(readFileSync(w.tasks, "utf8"));
  expect(tasks["first-fix"].mrUrl).toBe("https://github.com/acme/chat/pull/1");
  expect(tasks["first-fix"].train).toBe("sidebar");
  const state = JSON.parse(readFileSync(w.ghState, "utf8"));
  expect(state.prs[0].title).toBe("train(sidebar): 1 fixes — T1");
  expect(state.prs[0].body).toContain("## T1 · First fix");
  expect(existsSync(join(w.home, "trains/sidebar/T1.pending.json"))).toBe(false);
});

test("an already-pushed ref finalizes on the first call without a second push", () => {
  const w = world();
  const one = owner(w, "first-fix", "T1", "one.txt");
  expect(first(w, one, "T1").code).toBe(3);
  git(one.path, "push", "origin", "HEAD:refs/heads/train/sidebar");
  rmSync(join(w.home, "trains/sidebar/T1.pending.json"), { force: true });
  git(w.shared, "fetch", "origin");
  const before = git(w.shared, "rev-parse", "origin/train/sidebar");

  const shipped = first(w, one, "T1");
  expect(shipped.code, shipped.err + shipped.out).toBe(0);
  expect(shipped.out).toContain("commits are already ancestors of train/sidebar");
  git(w.shared, "fetch", "origin");
  expect(git(w.shared, "rev-parse", "origin/train/sidebar")).toBe(before);
  const tasks = JSON.parse(readFileSync(w.tasks, "utf8"));
  expect(tasks["first-fix"].mrUrl).toBe("https://github.com/acme/chat/pull/1");
  expect(tasks["first-fix"].train).toBe("sidebar");
  const state = JSON.parse(readFileSync(w.ghState, "utf8"));
  expect(state.prs[0].title).toBe("train(sidebar): 1 fixes — T1");
  expect(state.prs[0].body).toContain("## T1 · First fix");
  expect(existsSync(join(w.home, "trains/sidebar/T1.pending.json"))).toBe(false);
});

test("a fully shipped branch still refuses when there is nothing new to ship", () => {
  const w = world();
  const one = owner(w, "first-fix", "T1", "one.txt");
  expect(first(w, one, "T1").code).toBe(3);
  expect(finish(w, one, "T1").code).toBe(0);

  const repeated = first(w, one, "T1");
  expect(repeated.code).not.toBe(0);
  expect(repeated.err).toContain("nothing new to ship");
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

test("case 5c: movePendingBase skips an empty cherry-pick in a multi-commit ref", () => {
  const w = world();
  const one = owner(w, "first-fix", "T1", "one.txt");
  writeFileSync(join(one.path, "identical.txt"), "same content\n");
  git(one.path, "add", "identical.txt");
  git(one.path, "commit", "-m", "add identical content");
  writeFileSync(join(one.path, "after.txt"), "after collision\n");
  git(one.path, "add", "after.txt");
  git(one.path, "commit", "-m", "add trailing content");
  expect(first(w, one, "T1").code).toBe(3);

  const two = owner(w, "second-fix", "T2", "two.txt");
  writeFileSync(join(two.path, "identical.txt"), "same content\n");
  git(two.path, "add", "identical.txt");
  git(two.path, "commit", "-m", "add identical content");
  expect(first(w, two, "T2").code).toBe(3);
  expect(finish(w, two, "T2").code).toBe(0);

  const moved = finish(w, one, "T1");
  expect(moved.code, moved.err + moved.out).toBe(3);
  expect(moved.code).not.toBe(4);
  expect(moved.out).toContain("identical.txt");
  const subjects = git(one.path, "log", "--reverse", "--format=%s", "origin/main..HEAD");
  expect(subjects).toContain("T1 fix first-fix");
  expect(subjects).toContain("T1 add trailing content");
  expect(subjects).not.toContain("T1 add identical content");
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
  // Landed members fold into the train card rather than each taking a Done
  // line: an MR is on exactly one card.
  const boardText = readFileSync(w.board, "utf8");
  expect(boardText).not.toContain("cards/first-fix|");
  expect(boardText).not.toContain("cards/second-fix|");
  expect(boardText).toContain("cards/train-sidebar|");
  const landedTasks = JSON.parse(readFileSync(w.tasks, "utf8"));
  expect(landedTasks["first-fix"].trainLine).toContain("cards/first-fix|");
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

describe("T309 GitLab forge verification", () => {
  const glState = (w: World) => JSON.parse(readFileSync(w.glabState, "utf8"));
  const ghState = (w: World) => JSON.parse(readFileSync(w.ghState, "utf8"));
  const writes = (state: any) => state.calls.filter((c: any) => c.argv.includes("-X"));

  test("V1 GitLab ship creates one MR, no GitHub PR, and records the GitLab train", () => {
    const w = forgeWorld("gitlab"), o = owner(w, "first-fix", "T1", "one.txt");
    expect(first(w, o, "T1").code).toBe(3);
    const shipped = finish(w, o, "T1");
    expect(shipped.code, shipped.err + shipped.out).toBe(0);
    const state = glState(w);
    const posts = writes(state).filter((c: any) => c.argv.includes("POST") &&
      c.argv.some((x: string) => x === "projects/acme%2Fchat/merge_requests"));
    expect(posts).toHaveLength(1);
    expect(posts[0].input).toMatchObject({ source_branch: "train/sidebar", target_branch: "main", squash: false,
      title: "train(sidebar): 1 fixes — T1" });
    expect(posts[0].input.description.startsWith("**Merge as a fast-forward — press Rebase first if GitLab asks, and never squash.**")).toBe(true);
    expect(ghState(w).calls ?? []).toHaveLength(0);
    expect(JSON.parse(readFileSync(w.tasks, "utf8"))["first-fix"].mrUrl)
      .toBe("https://gitlab.com/acme/chat/-/merge_requests/1");
    expect(JSON.parse(readFileSync(join(w.home, "trains/sidebar/train.json"), "utf8")).repo).toBe("acme/chat");
    const review = readFileSync(w.board, "utf8").split("## Review\n")[1]!.split("## Done")[0]!;
    expect(review).toContain("cards/train-sidebar");
  });

  test("V2 second GitLab ship edits the existing MR with both sections", () => {
    const w = forgeWorld("gitlab"), one = owner(w, "first-fix", "T1", "one.txt");
    first(w, one, "T1"); finish(w, one, "T1");
    const two = owner(w, "second-fix", "T2", "two.txt");
    first(w, two, "T2");
    const shipped = finish(w, two, "T2");
    expect(shipped.code, shipped.err + shipped.out).toBe(0);
    const state = glState(w);
    const creates = writes(state).filter((c: any) => c.argv.includes("POST") &&
      c.argv.some((x: string) => x === "projects/acme%2Fchat/merge_requests"));
    const edits = writes(state).filter((c: any) => c.argv.includes("PUT") &&
      c.argv.some((x: string) => x.endsWith("/merge_requests/1")));
    expect(creates).toHaveLength(1);
    expect(edits.at(-1).input.title).toBe("train(sidebar): 2 fixes — T1, T2");
    expect(edits.at(-1).input.description).toContain("## T1 · First fix");
    expect(edits.at(-1).input.description).toContain("## T2 · Second fix");
  });

  test("V3 GitHub PR calls use the raw origin repo, never gh repo view's answer", () => {
    const w = forgeWorld("github", "wrong/repo"), o = owner(w, "first-fix", "T1", "one.txt");
    first(w, o, "T1");
    const shipped = finish(w, o, "T1");
    expect(shipped.code, shipped.err + shipped.out).toBe(0);
    const calls: string[][] = ghState(w).calls;
    expect(calls.some((a) => a[0] === "repo" && a[1] === "view")).toBe(false);
    for (const a of calls.filter((x) => x[0] === "pr"))
      expect(a.slice(a.indexOf("--repo"), a.indexOf("--repo") + 2)).toEqual(["--repo", "acme/chat"]);
  });

  test("V4 GitLab status maps conflicts, pipeline CI, refs, and unlanded labels", () => {
    const w = forgeWorld("gitlab");
    const state = glState(w);
    state.mrs = [
      { iid: 5, web_url: "https://gitlab.com/acme/chat/-/merge_requests/5", state: "opened",
        title: "open", description: "", source_branch: "train/sidebar", sha: "abc",
        created_at: "2026-09-14T22:48:00.000Z", has_conflicts: true,
        detailed_merge_status: "conflict", head_pipeline: { status: "failed" }, commits: ["T1 fix"] },
      { iid: 7, web_url: "https://gitlab.com/acme/chat/-/merge_requests/7", state: "merged",
        title: "merged", description: "", source_branch: "train/sidebar", sha: "def",
        created_at: "2026-09-14T20:00:00.000Z", has_conflicts: false,
        detailed_merge_status: "mergeable", head_pipeline: null, commits: ["T1 fix"] },
    ];
    writeFileSync(w.glabState, JSON.stringify(state, null, 1));
    const r = runTrain(w, ["status"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("sidebar  !5  3h 12m  CONFLICTING/conflict  CI 1✗  T1");
    expect(r.out).toContain("merged, not landed: sidebar !7");
  });

  test("V5 GitLab landed stores the MR URL and a legacy number does not suppress it", () => {
    const w = forgeWorld("gitlab"), state = glState(w);
    state.mrs = [{ iid: 7, web_url: "https://gitlab.com/acme/chat/-/merge_requests/7", state: "merged",
      title: "merged", description: "", source_branch: "train/sidebar", sha: "def",
      created_at: "2026-09-14T20:00:00.000Z", has_conflicts: false,
      detailed_merge_status: "mergeable", head_pipeline: null, commits: ["T1 fix"] }];
    writeFileSync(w.glabState, JSON.stringify(state, null, 1));
    mkdirSync(join(w.home, "trains/sidebar"), { recursive: true });
    writeFileSync(join(w.home, "trains/sidebar/landed.json"), "[7]\n");
    const firstRun = runTrain(w, ["landed"]);
    expect(firstRun.code, firstRun.err).toBe(0);
    expect(firstRun.out).toContain("T1 → Done");
    expect(JSON.parse(readFileSync(join(w.home, "trains/sidebar/landed.json"), "utf8")))
      .toEqual([7, "https://gitlab.com/acme/chat/-/merge_requests/7"]);
    expect(runTrain(w, ["landed"]).out).toBe("");
  });

  test("V6 GitLab drop edits a remaining train and closes an emptied train", () => {
    const w = forgeWorld("gitlab"), one = owner(w, "first-fix", "T1", "one.txt");
    first(w, one, "T1"); finish(w, one, "T1");
    const two = owner(w, "second-fix", "T2", "two.txt");
    first(w, two, "T2"); finish(w, two, "T2");
    expect(runTrain(w, ["drop", "T2", "--surface", "sidebar"]).code).toBe(0);
    let state = glState(w);
    const edit = writes(state).filter((c: any) => c.argv.includes("PUT") && c.input.description).at(-1);
    expect(edit.input.description).not.toContain("## T2");
    expect(runTrain(w, ["drop", "T1", "--surface", "sidebar"]).code).toBe(0);
    state = glState(w);
    expect(writes(state).some((c: any) => c.argv.some((x: string) => x.endsWith("/notes")) &&
      c.input.body === "Emptied by train.ts drop T1.")).toBe(true);
    expect(writes(state).some((c: any) => c.input.state_event === "close")).toBe(true);
  });

  test("V7 ship holds stop both ship calls and drop before locks, fetches, or writes", () => {
    const w = forgeWorld("gitlab"), o = owner(w, "first-fix", "T1", "one.txt");
    writeFileSync(join(w.home, "train-holds.json"), JSON.stringify({ "gitlab.com/acme/chat": "sync pending" }));
    mkdirSync(join(w.home, "trains/sidebar"), { recursive: true });
    writeFileSync(join(w.home, "trains/sidebar/train.json"), JSON.stringify({
      surface: "sidebar", repo: "acme/old-chat",
      pr: { number: 99, url: "https://github.com/acme/old-chat/pull/99" },
    }, null, 1));
    const surfacesBefore = readFileSync(w.surfaces);
    const firstCall = first(w, o, "T1");
    expect(firstCall.code).toBe(75);
    expect(firstCall.err).toContain("gitlab.com/acme/chat is on a ship hold: sync pending");
    expect(firstCall.err).not.toContain("pick a key for this repo");
    expect(existsSync(join(w.home, "trains/sidebar/T1.pending.json"))).toBe(false);
    expect(command(["git", "--git-dir", w.origin, "show-ref", "--verify", "--quiet",
      "refs/heads/train/sidebar"], w.root, commandEnv(gitEnv(w.root))).code).toBe(1);
    const dropped = runTrain(w, ["drop", "T1", "--surface", "sidebar"]);
    expect(dropped.code).toBe(75);
    expect(dropped.err).toContain("gitlab.com/acme/chat is on a ship hold: sync pending");
    expect(dropped.err).not.toContain("pick a key for this repo");
    expect(readFileSync(w.surfaces).equals(surfacesBefore)).toBe(true);
    expect(writes(glState(w))).toHaveLength(0);
    expect(runTrain(w, ["status"]).code).toBe(0);

    const second = forgeWorld("gitlab"), secondOwner = owner(second, "first-fix", "T1", "one.txt");
    expect(first(second, secondOwner, "T1").code).toBe(3);
    writeFileSync(join(second.home, "train-holds.json"),
      JSON.stringify({ "gitlab.com/acme/chat": "sync pending" }));
    const verified = finish(second, secondOwner, "T1");
    expect(verified.code).toBe(75);
    expect(command(["git", "--git-dir", second.origin, "show-ref", "--verify", "--quiet",
      "refs/heads/train/sidebar"], second.root, commandEnv(gitEnv(second.root))).code).toBe(1);
    expect(writes(glState(second))).toHaveLength(0);
  });

  test("V8 move dry-runs, rebuilds, adopts, rejects duplicate moves, and cleans conflicts", () => {
    const created = migrationWorld();
    const beforeTasks = readFileSync(created.w.tasks);
    const beforeRefs = git(created.w.root, "--git-dir", created.w.origin, "show-ref");
    const dry = runTrain(created.w, ["move", "sidebar", "--dry-run"]);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain("destination: create");
    expect(dry.out).toContain("history: rebuild");
    expect(readFileSync(created.w.tasks).equals(beforeTasks)).toBe(true);
    expect(git(created.w.root, "--git-dir", created.w.origin, "show-ref")).toBe(beforeRefs);
    expect(writes(glState(created.w))).toHaveLength(0);

    const moved = runTrain(created.w, ["move", "sidebar"], created.w.shared,
      commandEnv({ ...created.w.env, GH_STUB_TASKS: created.w.tasks }));
    expect(moved.code, moved.err + moved.out).toBe(0);
    expect(moved.out).toContain("moved #9 → !1");
    expect(git(created.w.root, "--git-dir", created.w.origin, "rev-parse",
      `refs/heads/train-stale/sidebar-${created.stale.slice(0, 8)}`)).toBe(created.stale);
    const log = git(created.w.root, "--git-dir", created.w.origin, "log", "--format=%s%n%b",
      "refs/heads/main..refs/heads/train/sidebar");
    expect(log).toContain("T1 first migration fix");
    expect(log).toContain("cherry picked from commit");
    const createdGl = glState(created.w);
    const create = writes(createdGl).find((c: any) => c.argv.includes("POST") &&
      c.argv.some((x: string) => x === "projects/acme%2Fchat/merge_requests"));
    expect(create.input.title).toBe("train(sidebar): 2 fixes — T1, T2");
    expect(create.input.description).toBe("Moved from GitHub: https://github.com/acme/chat/pull/9\n\nSource body byte-for-byte.\n");
    expect(ghState(created.w).prs[0].state).toBe("CLOSED");
    expect(ghState(created.w).calls).toContainEqual(["pr", "close", "9", "--repo", "acme/chat",
      "--comment", "Moved to GitLab: https://gitlab.com/acme/chat/-/merge_requests/1"]);
    const ledger = JSON.parse(readFileSync(join(created.w.home, "trains/sidebar/train.json"), "utf8"));
    expect(ledger).toMatchObject({ repo: "acme/chat", pr: { number: 1 },
      movedFrom: { repo: "acme/chat", number: 9 } });
    expect(JSON.parse(readFileSync(created.w.tasks, "utf8"))["first-fix"].mrUrl)
      .toBe("https://gitlab.com/acme/chat/-/merge_requests/1");
    expect(JSON.parse(readFileSync(created.w.tasks, "utf8"))["second-fix"].mrUrl)
      .toBe("https://gitlab.com/acme/chat/-/merge_requests/1");
    expect(JSON.parse(readFileSync(created.w.tasks, "utf8"))["second-fix"].otherOwnerWrite)
      .toBe("survives");

    const adopted = migrationWorld();
    const reorderedTip = pushDestinationTrain(adopted.w, ["T2", "T1"]);
    const adoptRefsBefore = git(adopted.w.root, "--git-dir", adopted.w.origin, "show-ref");
    const adoptState = glState(adopted.w);
    adoptState.mrs = [{ iid: 3, web_url: "https://gitlab.com/acme/chat/-/merge_requests/3", state: "opened",
      title: "adopt", description: "Moved from GitHub: https://github.com/acme/chat/pull/9",
      source_branch: "train/sidebar", sha: reorderedTip,
      created_at: "2026-09-15T01:00:00.000Z", has_conflicts: false,
      detailed_merge_status: "mergeable", head_pipeline: null,
      commits: ["T2 destination fix 0", "T1 destination fix 1"] }];
    writeFileSync(adopted.w.glabState, JSON.stringify(adoptState, null, 1));
    const adoptedRun = runTrain(adopted.w, ["move", "sidebar"]);
    expect(adoptedRun.code, adoptedRun.err + adoptedRun.out).toBe(0);
    expect(adoptedRun.out).toContain("→ !3");
    expect(git(adopted.w.root, "--git-dir", adopted.w.origin, "show-ref")).toBe(adoptRefsBefore);
    expect(writes(glState(adopted.w)).some((c: any) =>
      c.argv.some((x: string) => x === "projects/acme%2Fchat/merge_requests"))).toBe(false);
    expect(ghState(adopted.w).prs[0].state).toBe("CLOSED");

    const extra = migrationWorld();
    const extraTip = pushDestinationTrain(extra.w, ["T2", "T1", "T3"]);
    const extraState = glState(extra.w);
    extraState.mrs = [{ iid: 5, web_url: "https://gitlab.com/acme/chat/-/merge_requests/5", state: "opened",
      title: "extra", description: "Moved from GitHub: https://github.com/acme/chat/pull/9",
      source_branch: "train/sidebar", sha: extraTip,
      created_at: "2026-09-15T01:00:00.000Z", has_conflicts: false,
      detailed_merge_status: "mergeable", head_pipeline: null,
      commits: ["T2 destination fix 0", "T1 destination fix 1", "T3 destination fix 2"] }];
    writeFileSync(extra.w.glabState, JSON.stringify(extraState, null, 1));
    const extraTasks = readFileSync(extra.w.tasks);
    const extraRefs = git(extra.w.root, "--git-dir", extra.w.origin, "show-ref");
    const extraRun = runTrain(extra.w, ["move", "sidebar"]);
    expect(extraRun.code).toBe(1);
    expect(extraRun.err).toContain("refs T2, T1, T3 do not match GitHub refs T1, T2");
    expect(readFileSync(extra.w.tasks).equals(extraTasks)).toBe(true);
    expect(git(extra.w.root, "--git-dir", extra.w.origin, "show-ref")).toBe(extraRefs);
    expect(writes(glState(extra.w)).some((c: any) => c.argv.includes("-X"))).toBe(false);
    expect(ghState(extra.w).prs[0].state).toBe("OPEN");

    const duplicate = migrationWorld();
    const duplicateState = glState(duplicate.w);
    duplicateState.mrs = [{ iid: 4, web_url: "https://gitlab.com/acme/chat/-/merge_requests/4", state: "opened",
      title: "wrong branch", description: "https://github.com/acme/chat/pull/9",
      source_branch: "gl/train/sidebar", sha: "x", created_at: "2026-09-15T01:00:00.000Z",
      has_conflicts: false, detailed_merge_status: "mergeable", head_pipeline: null, commits: [] }];
    writeFileSync(duplicate.w.glabState, JSON.stringify(duplicateState, null, 1));
    const duplicateTasks = readFileSync(duplicate.w.tasks);
    const duplicateRefs = git(duplicate.w.root, "--git-dir", duplicate.w.origin, "show-ref");
    const refused = runTrain(duplicate.w, ["move", "sidebar"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("!4 (gl/train/sidebar)");
    expect(readFileSync(duplicate.w.tasks).equals(duplicateTasks)).toBe(true);
    expect(git(duplicate.w.root, "--git-dir", duplicate.w.origin, "show-ref")).toBe(duplicateRefs);
    expect(writes(glState(duplicate.w))).toHaveLength(0);
    expect(ghState(duplicate.w).prs[0].state).toBe("OPEN");

    const conflict = migrationWorld(true);
    const conflictRefs = git(conflict.w.root, "--git-dir", conflict.w.origin, "show-ref");
    const worktrees = git(conflict.w.shared, "worktree", "list", "--porcelain");
    const conflicted = runTrain(conflict.w, ["move", "sidebar"]);
    expect(conflicted.code).toBe(4);
    expect(conflicted.err).toContain("move conflict in: common.txt");
    expect(git(conflict.w.root, "--git-dir", conflict.w.origin, "show-ref")).toBe(conflictRefs);
    expect(git(conflict.w.shared, "worktree", "list", "--porcelain")).toBe(worktrees);
    expect(writes(glState(conflict.w))).toHaveLength(0);
  });

  test("V9 GitLab regeneration preserves a migration preamble verbatim", () => {
    const w = forgeWorld("gitlab"), one = owner(w, "first-fix", "T1", "one.txt");
    first(w, one, "T1"); finish(w, one, "T1");
    const state = glState(w);
    const preamble = "Ported from GitHub: X\n\nCommits replayed…\n\n---";
    state.mrs[0].description = `${preamble}\n\n${state.mrs[0].description}`;
    writeFileSync(w.glabState, JSON.stringify(state, null, 1));
    const two = owner(w, "second-fix", "T2", "two.txt");
    first(w, two, "T2"); finish(w, two, "T2");
    expect(glState(w).mrs[0].description.startsWith(`${preamble}\n\n**Merge `)).toBe(true);
  });

  test("V10 GitLab render line differs while the default stays the GitHub contract", () => {
    const row = [{ ref: "T1", title: "One", files: 1, added: 1, deleted: 0,
      verdict: "ok", try: "open", body: "proof" }];
    expect(renderBody(row, [], "", { forge: "gitlab" })).toStartWith("**Merge as a fast-forward");
    expect(renderBody(row, [])).toStartWith("**Merge with Rebase and merge.**");
    expect(parseBodyPreamble("Moved from GitHub: X\n\n**Merge now**")).toBe("Moved from GitHub: X");
  });

  test("V12 remote parsing and GitLab CI normalization cover every contract class", () => {
    expect(parseRemoteUrl("https://gitlab.com/g/n.git")).toEqual({ host: "gitlab.com", path: "g/n" });
    expect(parseRemoteUrl("https://gitlab.com/g/n")).toEqual({ host: "gitlab.com", path: "g/n" });
    expect(parseRemoteUrl("git@gitlab.com:g/sub/n.git")).toEqual({ host: "gitlab.com", path: "g/sub/n" });
    expect(parseRemoteUrl("ssh://git@gitlab.com/g/n.git")).toEqual({ host: "gitlab.com", path: "g/n" });
    expect(parseRemoteUrl("/tmp/repo.git")).toBeNull();
    expect([null, "success", "failed", "canceled", "skipped", "running"].map((status) =>
      gitlabCiSummary(status === null ? null : { status }))).toEqual(["none", "1✓", "1✗", "1✗", "1↷", "1…"]);
    const w = forgeWorld("gitlab");
    expect(resolveForge(w.shared)).toMatchObject({ kind: "gitlab", host: "gitlab.com", repo: "acme/chat" });
  });
});
