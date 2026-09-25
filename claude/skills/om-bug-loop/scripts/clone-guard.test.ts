import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCloneGuard } from "./clone-guard";

type Received = { headers: Record<string, string>; method: string; path: string };

const receivedHttp: Received[] = [];
const receivedWs: string[] = [];
let upstream: Bun.Server<{ marker: "upstream" }>;
let guard: Bun.Server<unknown>;
let allowWritesGuard: Bun.Server<unknown>;
let guardBase: string;
let guardWs: string;
const tempRootAlias = process.platform === "darwin" ? "/tmp" : tmpdir();
const guardHome = mkdtempSync(join(tempRootAlias, "clone-guard-home-a-"));
const allowWritesGuardHome = mkdtempSync(join(tempRootAlias, "clone-guard-home-b-"));

function randomPort(): number {
  return 20_000 + Math.floor(Math.random() * 30_000);
}

function startWithPortRetry<T>(start: (port: number) => Bun.Server<T>): Bun.Server<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return start(randomPort());
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function waitForMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for websocket message")), 1_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(String(event.data));
    }, { once: true });
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out opening websocket")), 1_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("websocket failed to open"));
    }, { once: true });
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await Bun.sleep(5);
  }
}

function rawRead(port: number, path: string, headers: string[], body = ""): Promise<void> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    socket.setTimeout(1_000);
    socket.on("connect", () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        ...headers,
        ...(body ? [] : ["Content-Length: 0"]),
        "",
        body,
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const responseHead = Buffer.concat(chunks).toString("latin1");
      const lineEnd = responseHead.indexOf("\r\n");
      if (lineEnd < 0) return;
      const statusLine = responseHead.slice(0, lineEnd);
      if (!statusLine.includes(" 207 ")) {
        finish(new Error(`raw guarded read failed for ${path}: ${statusLine}`));
        return;
      }
      finish();
    });
    socket.on("end", () => {
      if (settled) return;
      const statusLine = Buffer.concat(chunks).toString("latin1").split("\r\n", 1)[0];
      finish(new Error(`raw guarded read failed for ${path}: ${statusLine || "empty response"}`));
    });
    socket.on("timeout", () => finish(new Error(`raw guarded read timed out for ${path}`)));
    socket.on("error", (error) => finish(error));
  });
}

beforeAll(() => {
  upstream = startWithPortRetry((port) => Bun.serve<{ marker: "upstream" }>({
    hostname: "127.0.0.1",
    port,
    fetch(request, server) {
      const url = new URL(request.url);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const upgraded = server.upgrade(request, { data: { marker: "upstream" } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      }
      receivedHttp.push({
        headers: Object.fromEntries(request.headers),
        method: request.method,
        path: `${url.pathname}${url.search}`,
      });
      if (request.headers.get("host") !== new URL(upstream.url).host) {
        return new Response("wrong-vhost", { status: 421 });
      }
      if (url.pathname === "/chat/bytes") {
        return new Response(Uint8Array.from([0x00, 0xff, 0x54, 0x32, 0x34, 0x36, 0x0a]), { status: 207 });
      }
      return new Response(`upstream:${url.pathname}${url.search}`, { status: 207 });
    },
    websocket: {
      data: {} as { marker: "upstream" },
      message(socket, message) {
        const text = String(message);
        receivedWs.push(text);
        socket.send(text);
      },
    },
  }));

  guard = startWithPortRetry((port) => startCloneGuard({
    upstream: upstream.url.toString(),
    home: join(guardHome, "."),
    port,
  }));
  allowWritesGuard = startWithPortRetry((port) => startCloneGuard({
    upstream: upstream.url.toString(),
    home: allowWritesGuardHome,
    port,
    allowWrites: true,
  }));
  guardBase = guard.url.toString().replace(/\/$/, "");
  guardWs = guardBase.replace(/^http/, "ws");
});

afterAll(() => {
  guard?.stop(true);
  allowWritesGuard?.stop(true);
  upstream?.stop(true);
  rmSync(guardHome, { recursive: true, force: true });
  rmSync(allowWritesGuardHome, { recursive: true, force: true });
});

describe("clone guard HTTP safety", () => {
  test("GET /chat/docs is forwarded and returns the upstream response", async () => {
    const before = receivedHttp.length;
    const response = await fetch(`${guardBase}/chat/docs?folder=home`);

    expect(response.status).toBe(207);
    expect(await response.text()).toBe("upstream:/chat/docs?folder=home");
    expect(receivedHttp.slice(before).map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/chat/docs?folder=home" },
    ]);
  });

  for (const method of ["PATCH", "POST", "PUT", "DELETE"]) {
    test(`${method} is refused and never reaches the upstream`, async () => {
      const before = receivedHttp.length;
      const response = await fetch(`${guardBase}/chat/docs/x`, { method });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "clone-guard: write blocked",
        method,
        path: "/chat/docs/x",
      });
      // The safety property: a 403 is insufficient if the write was also leaked.
      expect(receivedHttp.length).toBe(before);
    });
  }

  test("health reports mode, resolved home, upstream, and decision counters", async () => {
    const response = await fetch(`${guardBase}/__guard/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: "read-only",
      home: realpathSync(guardHome),
      upstream: upstream.url.toString(),
      blocked: 4,
      allowed: 1,
    });
  });

  test("two guards with different homes and ports run simultaneously", async () => {
    expect(guard.port).not.toBe(allowWritesGuard.port);

    const [first, second] = await Promise.all([
      fetch(`${guardBase}/__guard/health`).then((response) => response.json()),
      fetch(`${allowWritesGuard.url.toString().replace(/\/$/, "")}/__guard/health`).then((response) => response.json()),
    ]);
    expect(first.home).toBe(realpathSync(guardHome));
    expect(second.home).toBe(realpathSync(allowWritesGuardHome));
  });

  test("guarded read is byte-identical to direct read and preserves Authorization", async () => {
    const path = "/chat/bytes?source=t246";
    const authorization = "Bearer t246-read-token";
    const direct = await fetch(new URL(path, upstream.url), {
      headers: { Authorization: authorization },
    });
    const throughGuard = await fetch(`${guardBase}${path}`, {
      headers: { Authorization: authorization },
    });

    expect(throughGuard.status).toBe(direct.status);
    expect(new Uint8Array(await throughGuard.arrayBuffer())).toEqual(
      new Uint8Array(await direct.arrayBuffer()),
    );

    const forwarded = receivedHttp.filter((request) => request.path === path);
    expect(forwarded).toHaveLength(2);
    for (const request of forwarded) {
      expect(request.headers.host).toBe(new URL(upstream.url).host);
      expect(request.headers.authorization).toBe(authorization);
    }
  });

  test("client hop-by-hop headers do not reach the upstream", async () => {
    const authorization = "Bearer t246-hop-header-token";
    const auth = `Authorization: ${authorization}`;
    const cases: Array<{ headers: string[]; body?: string }> = [
      { headers: [`Authorization: ${authorization}`, "Connection: x-t246-hop, close"] },
      { headers: [auth, "Connection: keep-alive", "Keep-Alive: timeout=246"] },
      {
        headers: [auth, "Connection: close", "Transfer-Encoding: chunked", "Trailer: X-T246-Trailer"],
        body: "0\r\nX-T246-Trailer: complete\r\n\r\n",
      },
      {
        headers: [
          auth,
          "Connection: Upgrade, HTTP2-Settings",
          "Upgrade: h2c",
          "HTTP2-Settings: AAMAAABkAAQAAP__",
        ],
      },
      { headers: [auth, "Connection: TE", "TE: trailers"] },
      { headers: [auth, "Connection: close", "Proxy-Authorization: Basic dDI0Ng==", "Proxy-T246: must-not-arrive"] },
    ];
    const casePaths = new Set(cases.map((_, index) => `/chat/headers?case=${index}`));

    for (const [index, item] of cases.entries()) {
      await rawRead(guard.port, `/chat/headers?case=${index}`, item.headers, item.body);
    }

    const forwarded = receivedHttp.filter((request) => casePaths.has(request.path));
    expect(forwarded).toHaveLength(cases.length);
    expect(new Set(forwarded.map((request) => request.path))).toEqual(casePaths);
    for (const request of forwarded) {
      expect(request.headers.host).toBe(new URL(upstream.url).host);
      expect(request.headers.authorization).toBe(authorization);
      expect(request.headers.connection ?? "").not.toContain("x-t246-hop");
      expect(request.headers["keep-alive"]).toBeUndefined();
      expect(request.headers["transfer-encoding"]).toBeUndefined();
      expect(request.headers.upgrade).toBeUndefined();
      expect(request.headers.te).toBeUndefined();
      expect(request.headers.trailer).toBeUndefined();
      expect(Object.keys(request.headers).filter((name) => name.startsWith("proxy-"))).toEqual([]);
    }
  });

  test("--allow-writes forwards PATCH as the negative control", async () => {
    const base = allowWritesGuard.url.toString().replace(/\/$/, "");
    const path = "/chat/allow-writes-negative-control";
    const response = await fetch(`${base}${path}`, { method: "PATCH" });

    expect(response.status).toBe(207);
    expect(
      receivedHttp.filter((request) => request.path === path).map(({ method, path }) => ({ method, path })),
    ).toEqual([{ method: "PATCH", path }]);
  });
});

describe("clone guard websocket safety", () => {
  test("HISTORY reaches upstream; POST is refused and does not", async () => {
    const socket = new WebSocket(`${guardWs}/ws/rooms?space=test`);
    await waitForOpen(socket);

    const before = receivedWs.length;
    const history = JSON.stringify({ type: "HISTORY", roomId: "room-1" });
    const historyReply = waitForMessage(socket);
    socket.send(history);
    expect(await historyReply).toBe(history);
    await eventually(() => receivedWs.length === before + 1);
    expect(receivedWs.at(-1)).toBe(history);

    const refusal = waitForMessage(socket);
    socket.send(JSON.stringify({ type: "POST", roomId: "room-1", text: "must not leak" }));
    expect(JSON.parse(await refusal)).toEqual({
      type: "ERROR",
      error: "clone-guard: ✋ BLOCKED ws POST",
    });
    await Bun.sleep(20);
    expect(receivedWs.length).toBe(before + 1);
    socket.close();
  });

  test("non-JSON and missing-type frames are both dropped", async () => {
    const socket = new WebSocket(`${guardWs}/ws/rooms`);
    await waitForOpen(socket);
    const before = receivedWs.length;

    let refusal = waitForMessage(socket);
    socket.send("not json");
    expect(JSON.parse(await refusal).error).toContain("clone-guard");

    refusal = waitForMessage(socket);
    socket.send(JSON.stringify({ requestId: "missing-type" }));
    expect(JSON.parse(await refusal).error).toContain("clone-guard");

    await Bun.sleep(20);
    expect(receivedWs.length).toBe(before);
    socket.close();
  });
});
