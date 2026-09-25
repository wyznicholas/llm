import { appendFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const READ_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Literal protocol values from rooms-protocol.ts. Keep this list intentionally
// narrow: a new protocol verb is a write until someone proves that it is a read.
const READ_WS_TYPES = new Set([
  "AUTHENTICATE",
  "PING",
  "SEARCH",
  "SEARCH_ENTRIES",
  "SEARCH_GLOBAL",
  "DM_SEARCH",
  "HISTORY",
  "PEEK",
  "PINS",
  "DM_PINS",
  "REACTORS",
  "AUDIT_LOG",
  "SPACES",
  "WHO",
  "FRIENDS",
  "DM_HISTORY",
  "DM_MESSAGE_GET",
  "TOPIC_LIST",
  "TOPIC_SEARCH",
  "TODOS_SNAPSHOT",
]);

const WRITE_WARNING = "\u001b[31mCLONE-GUARD ALLOW-WRITES: SAFETY DISABLED\u001b[0m";

export type CloneGuardOptions = {
  upstream: string;
  home: string;
  port?: number;
  hostname?: string;
  allowWrites?: boolean;
  logFile?: string;
};

type GuardCounters = {
  blocked: number;
  allowed: number;
};

type GuardSocketData = {
  upstream: WebSocket | null;
  upstreamUrl: string;
  protocols: string[];
  queued: Array<string | Uint8Array>;
};

type SelfTestObservation = {
  authorization: string | null;
  host: string | null;
  leakedHeaders: string[];
};

function timestamp(): string {
  return new Date().toISOString();
}

function normalizeUpstream(raw: string): URL {
  let upstream: URL;
  try {
    upstream = new URL(raw);
  } catch {
    throw new Error(`clone-guard: invalid --upstream URL: ${raw}`);
  }

  if (!["http:", "https:", "ws:", "wss:"].includes(upstream.protocol)) {
    throw new Error(`clone-guard: unsupported --upstream protocol: ${upstream.protocol}`);
  }
  return upstream;
}

function targetUrl(upstream: URL, incoming: URL, websocket: boolean): URL {
  const target = new URL(upstream.origin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  if (websocket) {
    target.protocol = upstream.protocol === "https:" || upstream.protocol === "wss:" ? "wss:" : "ws:";
  } else {
    target.protocol = upstream.protocol === "wss:" ? "https:" : upstream.protocol === "ws:" ? "http:" : upstream.protocol;
  }
  return target;
}

function messageBytes(message: string | Buffer): string | Uint8Array {
  return typeof message === "string" ? message : new Uint8Array(message);
}

function upstreamHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of incoming) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName) || lowerName.startsWith("proxy-")) continue;
    headers.append(name, value);
  }
  return headers;
}

function startSelfTestServer<T>(start: (port: number) => Bun.Server<T>): Bun.Server<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 30_000);
    try {
      return start(port);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function runSelfTest(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "clone-guard-selftest-"));
  const sentHopByHopHeaders = new Map([
    ["connection", "close"],
    ["proxy-t246-selftest", "must-not-arrive"],
  ]);
  const authorization = "Bearer clone-guard-selftest";
  let observation: SelfTestObservation | undefined;
  let origin: Bun.Server<unknown> | undefined;
  let guard: Bun.Server<GuardSocketData> | undefined;

  try {
    origin = startSelfTestServer((port) => Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(request) {
        const leakedHeaders: string[] = [];
        for (const [name, sentValue] of sentHopByHopHeaders) {
          if (request.headers.get(name) === sentValue) leakedHeaders.push(name);
        }
        observation = {
          authorization: request.headers.get("authorization"),
          host: request.headers.get("host"),
          leakedHeaders,
        };
        return new Response("clone-guard-selftest-response");
      },
    }));
    guard = startSelfTestServer((port) => startCloneGuard({
      upstream: origin!.url.toString(),
      home,
      port,
    }));

    const response = await fetch(new URL("/__clone_guard_selftest", guard.url), {
      headers: {
        Authorization: authorization,
        Connection: sentHopByHopHeaders.get("connection")!,
        "Proxy-T246-Selftest": sentHopByHopHeaders.get("proxy-t246-selftest")!,
      },
      redirect: "manual",
    });
    const body = await response.text();
    if (response.status !== 200 || body !== "clone-guard-selftest-response") {
      throw new Error(`forwarded read returned ${response.status} with an unexpected body`);
    }
    if (!observation) throw new Error("internal origin did not receive the forwarded read");

    const expectedHost = new URL(origin.url).host;
    if (observation.host !== expectedHost) {
      throw new Error(`internal origin received Host ${observation.host ?? "<missing>"}; expected ${expectedHost}`);
    }
    if (observation.leakedHeaders.length > 0) {
      throw new Error(`internal origin received client hop-by-hop header(s): ${observation.leakedHeaders.join(", ")}`);
    }
    if (observation.authorization !== authorization) {
      throw new Error("internal origin did not receive Authorization unchanged");
    }
  } finally {
    guard?.stop(true);
    origin?.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}

export function startCloneGuard(options: CloneGuardOptions): Bun.Server<GuardSocketData> {
  const upstream = normalizeUpstream(options.upstream);
  const home = realpathSync(options.home);
  const allowWrites = options.allowWrites === true;
  const counters: GuardCounters = { blocked: 0, allowed: 0 };

  const log = (decision: string): void => {
    const line = `${timestamp()} ${decision}`;
    console.log(line);
    if (options.logFile) appendFileSync(options.logFile, `${line}\n`, "utf8");
  };

  const warnForwardedWrite = (description: string): void => {
    log(`${WRITE_WARNING} FORWARDED ${description}`);
  };

  if (allowWrites) log(WRITE_WARNING);

  const server = Bun.serve<GuardSocketData>({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request, bunServer) {
      const incoming = new URL(request.url);

      if (incoming.pathname === "/__guard/health" && request.method === "GET") {
        return Response.json({
          mode: allowWrites ? "allow-writes" : "read-only",
          home,
          upstream: upstream.toString(),
          blocked: counters.blocked,
          allowed: counters.allowed,
        });
      }

      const isUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (incoming.pathname === "/ws/rooms" && isUpgrade) {
        const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        const upgraded = bunServer.upgrade(request, {
          data: {
            upstream: null,
            upstreamUrl: targetUrl(upstream, incoming, true).toString(),
            protocols,
            queued: [],
          },
          headers: protocols.length > 0 ? { "Sec-WebSocket-Protocol": protocols[0] } : undefined,
        });
        return upgraded
          ? undefined
          : Response.json({ error: "clone-guard: websocket upgrade failed" }, { status: 400 });
      }

      if (isUpgrade) {
        counters.blocked += 1;
        log(`✋ BLOCKED websocket ${incoming.pathname}`);
        return Response.json(
          { error: "clone-guard: websocket path blocked", path: incoming.pathname },
          { status: 403 },
        );
      }

      const isRead = READ_HTTP_METHODS.has(request.method);
      if (!isRead && !allowWrites) {
        counters.blocked += 1;
        log(`✋ BLOCKED ${request.method} ${incoming.pathname}`);
        return Response.json(
          {
            error: "clone-guard: write blocked",
            method: request.method,
            path: incoming.pathname,
          },
          { status: 403 },
        );
      }

      if (!isRead) warnForwardedWrite(`${request.method} ${incoming.pathname}`);

      const target = targetUrl(upstream, incoming, false);
      try {
        const response = await fetch(target, {
          method: request.method,
          headers: upstreamHeaders(request.headers),
          body: isRead ? undefined : request.body,
          redirect: "manual",
        });
        counters.allowed += 1;
        log(`ALLOWED ${request.method} ${incoming.pathname}`);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log(`ERROR ${request.method} ${incoming.pathname}: ${detail}`);
        return Response.json(
          { error: "clone-guard: upstream request failed", detail },
          { status: 502 },
        );
      }
    },
    websocket: {
      data: {} as GuardSocketData,
      open(client) {
        const upstreamSocket = client.data.protocols.length > 0
          ? new WebSocket(client.data.upstreamUrl, client.data.protocols[0])
          : new WebSocket(client.data.upstreamUrl);
        client.data.upstream = upstreamSocket;

        upstreamSocket.addEventListener("open", () => {
          for (const message of client.data.queued) upstreamSocket.send(message);
          client.data.queued.length = 0;
        });
        upstreamSocket.addEventListener("message", (event) => {
          if (client.readyState !== WebSocket.OPEN) return;
          if (typeof event.data === "string") client.send(event.data);
          else if (event.data instanceof ArrayBuffer) client.send(event.data);
          else if (ArrayBuffer.isView(event.data)) client.send(event.data);
          else if (event.data instanceof Blob) {
            void event.data.arrayBuffer().then((data) => {
              if (client.readyState === WebSocket.OPEN) client.send(data);
            });
          }
        });
        upstreamSocket.addEventListener("close", (event) => {
          if (client.readyState === WebSocket.OPEN) {
            const usableCode = event.code >= 1000 && event.code <= 4999 && ![1005, 1006, 1015].includes(event.code)
              ? event.code
              : 1011;
            client.close(usableCode, event.reason || "clone-guard: upstream websocket closed");
          }
        });
        upstreamSocket.addEventListener("error", () => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "ERROR", error: "clone-guard: upstream websocket failed" }));
            client.close(1011, "clone-guard: upstream websocket failed");
          }
        });
      },
      message(client, rawMessage) {
        const message = messageBytes(rawMessage);
        let frameType: string | null = null;

        try {
          const text = typeof message === "string" ? message : new TextDecoder().decode(message);
          const parsed = JSON.parse(text) as unknown;
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "type" in parsed &&
            typeof (parsed as { type?: unknown }).type === "string" &&
            (parsed as { type: string }).type.length > 0
          ) {
            frameType = (parsed as { type: string }).type;
          }
        } catch {
          // Default deny below. Parsing failures must never reach the upstream.
        }

        const isRead = frameType !== null && READ_WS_TYPES.has(frameType);
        const isClassifiedWrite = frameType !== null && !isRead;
        const mayForward = isRead || (allowWrites && isClassifiedWrite);

        if (!mayForward) {
          counters.blocked += 1;
          const label = frameType ?? "UNPARSEABLE";
          const blockedText = `✋ BLOCKED ws ${label}`;
          const refusal = `clone-guard: ${blockedText}`;
          log(blockedText);
          client.send(JSON.stringify({ type: "ERROR", error: refusal }));
          return;
        }

        if (isClassifiedWrite) warnForwardedWrite(`ws ${frameType}`);

        const upstreamSocket = client.data.upstream;
        if (upstreamSocket?.readyState === WebSocket.OPEN) {
          upstreamSocket.send(message);
        } else {
          client.data.queued.push(message);
        }
        counters.allowed += 1;
        log(`ALLOWED ws ${frameType}`);
      },
      close(client, code, reason) {
        const upstreamSocket = client.data.upstream;
        if (upstreamSocket && upstreamSocket.readyState < WebSocket.CLOSING) {
          upstreamSocket.close(code, reason);
        }
      },
    },
  });

  log(`clone-guard: listening on ${server.url} upstream=${upstream} mode=${allowWrites ? "allow-writes" : "read-only"}`);
  return server;
}

type CliOptions = Required<Pick<CloneGuardOptions, "upstream" | "home" | "port">> &
  Pick<CloneGuardOptions, "allowWrites" | "logFile">;

function parseArgs(args: string[]): CliOptions {
  let upstream: string | undefined;
  let home: string | undefined;
  let port: number | undefined;
  let logFile: string | undefined;
  let allowWrites = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--allow-writes") {
      allowWrites = true;
    } else if (arg === "--upstream") {
      upstream = args[++index];
    } else if (arg === "--home") {
      home = args[++index];
    } else if (arg === "--port") {
      const rawPort = args[++index];
      port = Number(rawPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`clone-guard: invalid --port: ${rawPort ?? "missing"}`);
      }
    } else if (arg === "--log") {
      logFile = args[++index];
    } else {
      throw new Error(`clone-guard: unknown argument: ${arg}`);
    }
  }

  if (!upstream) throw new Error("clone-guard: --upstream is required");
  if (port === undefined) throw new Error("clone-guard: --port is required");
  if (!home) throw new Error("clone-guard: --home is required");
  if (logFile === undefined && args.includes("--log")) throw new Error("clone-guard: --log needs a file");
  return { upstream, home, port, logFile, allowWrites };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length === 1 && args[0] === "--selftest") {
    try {
      await runSelfTest();
      console.log("clone-guard: selftest PASS (forwarding confirmed)");
    } catch (error) {
      console.error(`clone-guard: selftest FAIL: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else {
    try {
      startCloneGuard(parseArgs(args));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    }
  }
}
