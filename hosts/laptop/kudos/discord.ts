// Public Discord launch posts, read from a channel the operator owns.
//
// The operator is not an admin on the public OpenMarket server, so no bot can
// be added there. Instead its announcement channel is Followed into a channel
// on the operator's own server (Discord copies each new post in through a
// webhook), and a bot on that server reads the copies, read-only. Reactions on
// the original are not copied, so they are not available here.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { withRetry } from "./retry";

const DISCORD_ENV = process.env.KUDOS_DISCORD_ENV ?? `${homedir()}/.config/kudos/discord.env`;
const API = "https://discord.com/api/v10";

export interface DiscordPost {
  id: string; // snowflake; ordered by time
  ts: string;
  author: string;
  text: string;
}

interface RawMessage {
  id: string;
  timestamp: string;
  webhook_id?: string;
  author?: { username?: string };
  content?: string;
  embeds?: Array<{ title?: string; description?: string }>;
}

function config(): { token: string; channel: string } | null {
  if (!existsSync(DISCORD_ENV)) return null;
  const env: Record<string, string> = {};
  for (const line of readFileSync(DISCORD_ENV, "utf8").split("\n")) {
    const m = line.match(/^\s*(DISCORD_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m?.[1] && m[2] !== undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!env.DISCORD_BOT_TOKEN || !/^\d+$/.test(env.DISCORD_CHANNEL_ID ?? "")) return null;
  return { token: env.DISCORD_BOT_TOKEN, channel: env.DISCORD_CHANNEL_ID as string };
}

export const discordConfigured = () => config() !== null;

/** Only the Followed copies count: they arrive through Discord's webhook. A
 *  human chatting in the operator's channel is not an announcement. */
export function followedPosts(raw: RawMessage[]): DiscordPost[] {
  return raw
    .filter((m) => m.webhook_id)
    .map((m) => ({
      id: m.id,
      ts: m.timestamp,
      author: m.author?.username ?? "",
      text: [
        m.content ?? "",
        ...(m.embeds ?? []).flatMap((e) => [e.title ?? "", e.description ?? ""]),
      ]
        .filter(Boolean)
        .join("\n"),
    }))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/** Followed posts newer than `afterId`, oldest first, plus the newest message
 *  id in the channel (so a first run can start watching from "now"). */
export async function discordPostsAfter(
  afterId: string,
): Promise<{ posts: DiscordPost[]; head: string } | null> {
  const cfg = config();
  if (!cfg) return null;
  const qs = afterId === "0" ? "limit=1" : `after=${afterId}&limit=50`;
  const raw = await withRetry("Discord channel read", async () => {
    const res = await fetch(`${API}/channels/${cfg.channel}/messages?${qs}`, {
      headers: { Authorization: `Bot ${cfg.token}`, "User-Agent": "kudos-reader (om-agent, 1.0)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as RawMessage[];
  });
  const head = raw.reduce((max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max), afterId);
  return { posts: afterId === "0" ? [] : followedPosts(raw), head };
}
