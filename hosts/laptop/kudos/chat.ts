// OM Chat reads for the kudos routine. Everything here is read-only and runs as
// the operator through the `om` CLI's stored device credential; the only write
// (the post itself) goes out as @om-agent through post.ts, so no kudos post
// carries the operator's name.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { withRetry } from "./retry";

export const SPACE = "openmarket";
/** Where kudos are posted: #special-mentions (moved from #dev-forums 2026-10-21). */
export const KUDOS_ROOM = "316c2aa8c358";
const SOCIAL_API = process.env.OM_ROOMS_API_URL ?? "https://chat.openmarket.xyz/chat";
const HISTORY_LIMIT = 300;

export interface ChatEntry {
  seq: number;
  ts: number;
  handle: string;
  isAgent: boolean;
  type: string;
  text: string;
}

async function om(args: string[]): Promise<string> {
  return withRetry(`om ${args.slice(0, 2).join(" ")}`, () => omOnce(args), 3);
}

async function omOnce(args: string[]): Promise<string> {
  const proc = Bun.spawn(["om", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`om ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  return stdout;
}

export async function roomHistory(room: string, sinceMs: number): Promise<ChatEntry[]> {
  const out = JSON.parse(
    await om(["room", "history", room, "--limit", String(HISTORY_LIMIT), "--format", "json"]),
  ) as { entries: ChatEntry[] };
  return out.entries.filter((e) => e.ts >= sinceMs && e.type === "post");
}

export async function spaceRooms(): Promise<string[]> {
  const rooms = JSON.parse(
    await om(["room", "ls", "--space", SPACE, "--format", "json"]),
  ) as Array<{ name: string; spaceId: string | null }>;
  return rooms.filter((r) => r.spaceId === SPACE).map((r) => r.name);
}

function operatorApiKey(): string {
  const creds = JSON.parse(readFileSync(`${homedir()}/.openmarket/credentials.json`, "utf8")) as {
    active: string;
    keys: Array<{ keyId: string; apiKey: string }>;
  };
  const key = creds.keys.find((k) => k.keyId === creds.active)?.apiKey;
  if (!key) throw new Error("no active om credential in ~/.openmarket/credentials.json");
  return key;
}

async function social<T>(path: string): Promise<T> {
  return withRetry(`GET ${path}`, () => socialOnce<T>(path));
}

async function socialOnce<T>(path: string): Promise<T> {
  const res = await fetch(`${SOCIAL_API}${path}`, {
    headers: { Authorization: `Bearer ${operatorApiKey()}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Handles holding the space's @QA role, read live so a newly tagged QA is
 *  excluded on the next run without anyone editing people.json. Fails closed:
 *  if the role cannot be read the run aborts rather than risk thanking a QA. */
export async function qaHandles(): Promise<Set<string>> {
  const { roles } = await social<{ roles: Array<{ roleId: string; name: string }> }>(
    `/spaces/${SPACE}/roles`,
  );
  const qa = roles.filter((r) => r.name.trim().toLowerCase() === "qa").map((r) => r.roleId);
  if (qa.length === 0) throw new Error("the openmarket space has no QA role; refusing to guess");
  const { members } = await social<{
    members: Array<{ handle?: string; roleIds?: string[] }>;
  }>(`/spaces/${SPACE}/members`);
  return new Set(
    members
      .filter((m) => m.handle && (m.roleIds ?? []).some((id) => qa.includes(id)))
      .map((m) => m.handle as string),
  );
}

/** How often each handle was @mentioned by another human in these entries. */
export function countMentions(
  entries: ChatEntry[],
  handles: Iterable<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const h of handles) {
    const re = new RegExp(`@${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    let n = 0;
    for (const e of entries) if (!e.isAgent && e.handle !== h && re.test(e.text)) n++;
    if (n > 0) counts.set(h, n);
  }
  return counts;
}
