// Deliver a kudos post as @om-agent and keep the routine's small state file.
//
// The badge key lives only on oms-mac-mini, so delivery is the same path every
// other routine uses: pipe the body over ssh into tools/routine-say.ts there.
// That script posts with om-agent's key, which is why the post never carries
// the operator's name.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { KudosState } from "./types";

export const STATE_DIR = process.env.KUDOS_STATE_DIR ?? `${homedir()}/.local/state/kudos`;
const STATE_FILE = `${STATE_DIR}/state.json`;
const MINI = "oms-mac-mini";
const REMOTE_SAY = "~/.local/share/om-routines/routine-say.ts";
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

const SECRET_RE =
  /\b(glpat-|gldt-|phx_|phc_|sk-[A-Za-z0-9]|xox[abp]-|ghp_|AKIA[0-9A-Z]{12})|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|\b[A-Za-z0-9_-]{40,}\b/;

export async function postAsAgent(
  room: string,
  text: string,
  topicId?: string,
): Promise<number | null> {
  const proc = Bun.spawn(
    [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      MINI,
      `bun ${REMOTE_SAY} ${room}${topicId ? ` ${topicId}` : ""}`,
    ],
    { stdin: new TextEncoder().encode(text), stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`routine-say exited ${code}: ${stderr.trim() || stdout.trim()}`);
  const seq = stdout.match(/seq=(\d+)/)?.[1];
  return seq ? Number(seq) : null;
}
