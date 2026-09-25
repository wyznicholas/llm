// daemon-api.ts — shared client for the local OM Chat daemon's rooms proxy.
//
// Two facts drive everything here (see ../references/api.md):
//  1. Auth is the operator cookie minted by any GET of /rooms; a 401
//     `badge_token_required` means re-mint once and replay.
//  2. History reads are rate-limited server-side under the `readHistory`
//     scope: 10 requests per ~1s window, answered with 429 + Retry-After.
//     Backfill paging WILL trip this, so every read honors Retry-After and
//     callers pace themselves between pages.
export const ROOM = "b4472fc1fbd3";
export const TOPIC = "7f30222f";
export const DEFAULT_DAEMON = "http://localhost:31417";
export const PAGE_LIMIT = 200;
export const PAGE_PAUSE_MS = 150; // stay under the 10/s readHistory budget

const RATE_LIMIT_MAX_RETRIES = 8;

export interface LedgerEntryRaw {
  seq: number; ts: number; type: string; text?: string; handle: string;
  userId?: string; topicId?: string; inReplyTo?: number;
  attachments?: unknown[]; todoCurrent?: { title?: string; description?: string };
  [k: string]: unknown;
}

export interface EventsPage {
  success?: boolean;
  entries: LedgerEntryRaw[];
  upToSeq?: number;
  hasMore?: boolean;
}

export class DaemonClient {
  readonly origin: string;
  private cookie = "";
  private minting: Promise<void> | null = null;

  constructor(origin: string = DEFAULT_DAEMON) {
    this.origin = origin.replace(/\/+$/, "");
  }

  /** Any GET of the /rooms document mints om_operator_<port> as a Set-Cookie. */
  async mint(): Promise<void> {
    if (this.minting) return this.minting; // single-flight, like the GUI's re-mint
    this.minting = (async () => {
      const res = await fetch(`${this.origin}/rooms`, { redirect: "manual" });
      const headers = res.headers as unknown as { getSetCookie?: () => string[] };
      const lines = typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : [res.headers.get("set-cookie") ?? ""];
      for (const line of lines) {
        const m = /(om_operator[^=]*)=([^;]+)/.exec(line ?? "");
        if (m) { this.cookie = `${m[1]}=${m[2]}`; return; }
      }
      throw new Error(`no om_operator cookie in GET /rooms (status ${res.status})`);
    })();
    try { await this.minting; } finally { this.minting = null; }
  }

  /** Raw GET with cookie, 401 re-mint and 429 Retry-After handling. */
  async fetchRaw(path: string): Promise<Response> {
    if (!this.cookie) await this.mint();
    let reminted = false;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.origin}${path}`, { headers: { cookie: this.cookie } });
      if (res.status === 401) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === "badge_token_required" && !reminted) {
          reminted = true;
          this.cookie = "";
          await this.mint();
          continue;
        }
        throw new Error(`401 from ${path}: ${body.error ?? "unknown"}`);
      }
      if (res.status === 429) {
        if (attempt >= RATE_LIMIT_MAX_RETRIES) throw new Error(`429 (rate limited) from ${path}`);
        const headerWait = Number(res.headers.get("retry-after") ?? "0");
        const wait = (Number.isFinite(headerWait) && headerWait > 0 ? headerWait : 1) * 1000 + 250;
        await res.body?.cancel().catch(() => {});
        await Bun.sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} from ${path}`);
      return res;
    }
  }

  async getJson<T>(path: string): Promise<T> {
    return (await this.fetchRaw(path)).json() as Promise<T>;
  }

  eventsPath(params: Record<string, string | number>): string {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return `/api/rooms/rooms/${ROOM}/events?${qs.toString()}`;
  }

  async events(params: Record<string, string | number>): Promise<EventsPage> {
    return this.getJson<EventsPage>(this.eventsPath({ limit: PAGE_LIMIT, ...params }));
  }

  /** Resolve an attachment key to a signed URL. */
  async attachmentUrl(key: string): Promise<string | null> {
    const path = `/api/rooms/rooms/${ROOM}/attachment-url?key=${encodeURIComponent(key)}`;
    const body = await this.getJson<{ url?: string; signedUrl?: string; success?: boolean }>(path);
    return body.url ?? body.signedUrl ?? null;
  }
}
