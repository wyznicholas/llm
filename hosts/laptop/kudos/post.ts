// Deliver a kudos post as @om-agent and keep the routine's small state file.
//
// Delivery runs tools/routine-say.ts on this Mac with om-agent's app key, which
// is why the post never carries the operator's name. It used to ssh into
// oms-mac-mini, where that key lived; on 2026-10-27 the mini was rebuilt as a
// CI runner, the ombot account and the key went with it, and the iOS launch
// post could not be delivered. The key now lives here, in KEY_FILE (minted with
// `om app rotate om-agent`), so posting no longer depends on another machine.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { KudosState } from "./types";

export const STATE_DIR = process.env.KUDOS_STATE_DIR ?? `${homedir()}/.local/state/kudos`;
const STATE_FILE = `${STATE_DIR}/state.json`;
const KEY_FILE = `${homedir()}/.config/kudos/om-agent.env`;
// install.sh bundles routine-say into say.js next to the installed routine, so
// the launchd job never reads the repo under ~/Documents (TCC); a run from the
// checkout uses the source directly.
const SAY = existsSync(`${import.meta.dir}/say.js`)
  ? `${import.meta.dir}/say.js`
  : `${import.meta.dir}/../routine-say.ts`;
// The relay splits at 2000 bytes and a split post loses its formatting, so an
// over-long post is refused instead of being sent in pieces.
export const MAX_POST_BYTES = 1900;

export function loadState(): KudosState {
  if (!existsSync(STATE_FILE)) return { kudos: [] };
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as KudosState;
}

export function saveState(state: KudosState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  // Write-then-rename so a crash mid-write cannot truncate the freeze history,
  // which is the only thing stopping the same person being picked twice.
  writeFileSync(`${STATE_FILE}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
}

/** Reasons a drafted post must not go out. Empty means it is safe to send. */
export function postProblems(text: string, mustTag: string[]): string[] {
  const problems: string[] = [];
  if (!text.trim()) problems.push("empty post");
  if (new TextEncoder().encode(text).length > MAX_POST_BYTES)
    problems.push(`longer than ${MAX_POST_BYTES} bytes`);
  // A kudos post pings the people it thanks, never the whole channel.
  if (/@(everyone|here|channel)\b/i.test(text)) problems.push("contains a mass mention");
  for (const h of mustTag) if (!text.includes(`@${h}`)) problems.push(`does not tag @${h}`);
  // The writer reads text anyone can put in an MR; a link it was talked into
  // adding would go out under @om-agent's name. Only our own hosts pass.
  for (const url of text.match(/https?:\/\/[^\s)>\]]+/gi) ?? []) {
    if (
      !/^https:\/\/(gitlab\.com\/openmarketxyz\/|([a-z0-9-]+\.)*openmarket\.xyz(\/|$))/i.test(url)
    )
      problems.push(`links outside our hosts: ${url}`);
  }
  // Last line of defence against the writer quoting a secret it read in a log
  // line or MR description: refuse anything token-shaped.
  if (SECRET_RE.test(text)) problems.push("contains something that looks like a secret");
  return problems;
}

const SECRET_RE = new RegExp(
  [
    // Distinctive prefixes match anywhere, even glued to a word.
    "(glpat-|gldt-|glsa_|sntry[us]_|phx_|phc_|xox[abp]-|ghp_|github_pat_|AKIA[0-9A-Z]{12})",
    // A short prefix only at a word start, or "task-…" would match.
    "(?<![A-Za-z0-9])sk-[A-Za-z0-9]",
    // JWTs, and Sentry DSNs (a key before @…sentry.io).
    "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.",
    "https?://[0-9a-f]{32}@[\\w.-]*sentry\\.io",
    // Anything long and token-like.
    "\\b[A-Za-z0-9_-]{40,}\\b",
  ].join("|"),
);

/** Bold every known @handle that runs straight into `.` or `-`.
 *
 *  OM Chat reads both characters as part of a handle (chat-ui Markdown.tsx
 *  mention tokenizer: `[a-z0-9_.-]`), so "built by @cj_tharamine." looks for a
 *  user called "cj_tharamine.", finds none, and renders plain text with no ping.
 *  That is how the 11-03 Rithmic post failed to tag CJ. Inside `**…**` the
 *  handle ends at the `*`. Longest handles go first so a handle that is a
 *  prefix of another is not wrapped inside it. */
export function sealMentions(text: string, handles: string[]): string {
  const reEscape = (h: string) => h.replace(/[.*+?^${}()|[\]-]/g, "\\$&");
  let out = text;
  for (const h of [...handles].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![a-z0-9_@*.-])@${reEscape(h)}(?=[.-])`, "gi"), `**@${h}**`);
  }
  return out;
}

export async function postAsAgent(
  room: string,
  text: string,
  topicId?: string,
): Promise<number | null> {
  if (!existsSync(KEY_FILE)) throw new Error(`om-agent key missing: ${KEY_FILE}`);
  const apiKey = readFileSync(KEY_FILE, "utf8").match(/^\s*OM_AGENT_API_KEY\s*=\s*(\S+)/m)?.[1];
  if (!apiKey) throw new Error(`no OM_AGENT_API_KEY in ${KEY_FILE}`);
  const proc = Bun.spawn([process.execPath, SAY, room, ...(topicId ? [topicId] : [])], {
    stdin: new TextEncoder().encode(text),
    stdout: "pipe",
    stderr: "pipe",
    // Only what routine-say needs; the key never goes on the command line.
    env: { PATH: process.env.PATH ?? "", HOME: homedir(), OM_AGENT_API_KEY: apiKey },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`routine-say exited ${code}: ${stderr.trim() || stdout.trim()}`);
  const seq = stdout.match(/seq=(\d+)/)?.[1];
  return seq ? Number(seq) : null;
}
