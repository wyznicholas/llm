// watch-todos.test.ts — cursor / pending logic against an in-process fake daemon.
//
// The fake serves the two endpoints watch-todos depends on, with the exact
// semantics documented in references/api.md:
//   GET /rooms                        → Set-Cookie: om_operator_31417=<tok>
//   GET /api/rooms/rooms/:room/events → {success, room, entries, upToSeq, hasMore, readOnly}
//     · no/!valid cookie → 401 {ok:false, error:"badge_token_required"}
//     · sinceSeq=N  → entries after N, oldest→newest, page-limited
//     · beforeSeq=N → entries before N, page-limited, oldest→newest in the page
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TODO_EPOCH_MS, type LedgerEntry } from "./todo-fold";

const TOPIC = "7f30222f";
const ROOM = "b4472fc1fbd3";
const SCRIPT = join(import.meta.dir, "watch-todos.ts");
const T0 = TODO_EPOCH_MS + 86_400_000;

const post = (seq: number, text: string, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
  seq, ts: T0 + seq * 1000, type: "post", text, handle: "reagan", topicId: TOPIC, ...extra,
});

let ledger: LedgerEntry[] = [];
let rejectNextAuth = false;
let cookie = "";
let server: ReturnType<typeof Bun.serve>;
let origin = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/rooms") {
        cookie = `tok-${Math.random().toString(36).slice(2)}`;
        return new Response("<html></html>", {
          headers: { "Set-Cookie": `om_operator_31417=${cookie}; Path=/; HttpOnly` },
        });
      }
      if (url.pathname === `/api/rooms/rooms/${ROOM}/events`) {
        const sent = req.headers.get("cookie") ?? "";
        const authed = cookie !== "" && sent.includes(`om_operator_31417=${cookie}`);
        if (!authed || rejectNextAuth) {
          rejectNextAuth = false;
          return Response.json(
            { ok: false, error: "badge_token_required", message: "operator proof required" },
            { status: 401 },
          );
        }
        const limit = Number(url.searchParams.get("limit") ?? "200");
        const sinceSeq = url.searchParams.get("sinceSeq");
        const beforeSeq = url.searchParams.get("beforeSeq");
        const sorted = [...ledger].sort((a, b) => a.seq - b.seq);
        let page: LedgerEntry[];
        let hasMore: boolean;
        if (beforeSeq !== null) {
          const older = sorted.filter(e => e.seq < Number(beforeSeq));
          page = older.slice(Math.max(0, older.length - limit));
          hasMore = older.length > page.length;
        } else {
          const after = sorted.filter(e => e.seq > Number(sinceSeq ?? "0"));
          page = after.slice(0, limit);
          hasMore = after.length > page.length;
        }
        const tip = sorted.length ? sorted[sorted.length - 1]!.seq : 0;
        return Response.json({
          success: true, room: ROOM, entries: page,
          upToSeq: page.length ? page[page.length - 1]!.seq : tip,
          hasMore, readOnly: false,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  origin = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "om-bug-loop-test-"));
  dirs.push(d);
  return d;
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// NOTE: must be async — Bun.spawnSync would block this process's event loop,
// and the fake daemon the child talks to is served from this very process.
async function runOnce(stateDir: string) {
  const proc = Bun.spawn({
    cmd: ["bun", SCRIPT, "--once", "--state", stateDir, "--daemon", origin],
    cwd: import.meta.dir,
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return {
    exitCode: proc.exitCode,
    stdout,
    stderr,
    json: stdout.trim() ? JSON.parse(stdout.trim().split("\n").pop()!) : null,
    pending: (() => {
      try { return readdirSync(join(stateDir, "pending")).sort(); } catch { return []; }
    })(),
    state: (() => {
      try { return JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")); } catch { return null; }
    })(),
  };
}

beforeEach(() => { rejectNextAuth = false; });

test("(a) first run backfills to epoch and writes one pending file per eligible todo", async () => {
  ledger = [
    post(100, "just chatting"),
    post(101, "!todo Emoji burst lags"),
    post(102, "!todo Search returns nothing after filter clear"),
    post(103, "!todo Off-topic one", { topicId: "other-topic" }),
    post(104, "some reply"),
  ];
  const dir = freshDir();
  const r = await runOnce(dir);
  expect(r.exitCode).toBe(0);
  expect(r.json.new.map((t: any) => t.seq).sort()).toEqual([101, 102]);
  expect(r.json.eligibleNow).toBe(2);
  expect(r.pending).toEqual(["101.json", "102.json"]);
  const p = JSON.parse(readFileSync(join(dir, "pending", "101.json"), "utf8"));
  expect(p).toMatchObject({ seq: 101, title: "Emoji burst lags", room: ROOM, topicId: TOPIC });
  expect(typeof p.detectedAt).toBe("string");
  expect(r.state.cursor).toBe(104); // room tip, not just topic
  expect(r.state.markers.map((m: any) => m.seq).sort()).toEqual([101, 102]);
  expect(r.state.dispatched).toEqual([]);
});

test("(b) a seq already in dispatched is never written as pending again", async () => {
  ledger = [post(200, "!todo Already handled")];
  const dir = freshDir();
  expect((await runOnce(dir)).pending).toEqual(["200.json"]);
  rmSync(join(dir, "pending", "200.json"));
  // coordinator marks it dispatched
  const statePath = join(dir, "state.json");
  const st = JSON.parse(readFileSync(statePath, "utf8"));
  st.dispatched = [200];
  Bun.write(statePath, JSON.stringify(st));
  const r = await runOnce(dir);
  expect(r.exitCode).toBe(0);
  expect(r.json.new).toEqual([]);
  expect(r.pending).toEqual([]);
  expect(r.state.dispatched).toEqual([200]); // watcher preserved it, never wrote it
});

test("(c) incremental sinceSeq poll picks up a !claim and drops the todo from new", async () => {
  ledger = [post(300, "!todo Blocked messages on slow connections")];
  const dir = freshDir();
  const first = await runOnce(dir);
  expect(first.pending).toEqual(["300.json"]);
  rmSync(join(dir, "pending", "300.json"));
  const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  st.dispatched = [300];
  Bun.write(join(dir, "state.json"), JSON.stringify(st));
  // someone claims it, and a brand-new todo arrives after the cursor
  ledger.push(post(301, "!claim", { handle: "nicholas", inReplyTo: 300 }));
  ledger.push(post(302, "!todo Upload reset button greyed out"));
  const r = await runOnce(dir);
  expect(r.exitCode).toBe(0);
  expect(r.json.new.map((t: any) => t.seq)).toEqual([302]);
  expect(r.json.eligibleNow).toBe(1); // 300 is held now
  expect(r.pending).toEqual(["302.json"]);
  expect(r.state.cursor).toBe(302);
  expect(r.state.markers.map((m: any) => m.seq).sort()).toEqual([300, 301, 302]);
});

test("(d) a 401 badge_token_required is survived by re-minting the cookie once", async () => {
  ledger = [post(400, "!todo Cookie expired mid-poll")];
  const dir = freshDir();
  rejectNextAuth = true;
  const r = await runOnce(dir);
  expect(r.exitCode).toBe(0);
  expect(r.json.new.map((t: any) => t.seq)).toEqual([400]);
  expect(r.pending).toEqual(["400.json"]);
});
