// GitLab reads for the kudos routine, through the `glab` CLI so the routine
// rides the operator's existing keyring login instead of holding a token.
//
// One group-wide MR listing covers all ~240 openmarketxyz projects in a single
// paginated call; per-MR note fetches are spent only where GitLab already says a
// note exists, which keeps a 14-day window to a few hundred requests.

import { withRetry } from "./retry";
import type { MergedMr } from "./types";

const GROUP = "openmarketxyz";
const NOTE_CONCURRENCY = 6;

/** `glab api --paginate` prints one JSON array per page, back to back. */
export function parseConcatenatedArrays<T>(raw: string): T[] {
  const out: T[] = [];
  let rest = raw.trim();
  while (rest.length > 0) {
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let i = 0; i < rest.length; i++) {
      const ch = rest[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) throw new Error("glab output ended mid-JSON");
    const chunk = JSON.parse(rest.slice(0, end + 1)) as T[] | T;
    if (Array.isArray(chunk)) out.push(...chunk);
    else out.push(chunk);
    rest = rest.slice(end + 1).trim();
  }
  return out;
}

/** One page of a GitLab GET, retried on its own. */
async function glabApi<T>(path: string): Promise<T[]> {
  return withRetry(`glab api ${path.split("?")[0]}`, async () => {
    const proc = Bun.spawn(["glab", "api", path], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`exit ${code}: ${stderr.trim().slice(0, 300)}`);
    return parseConcatenatedArrays<T>(stdout);
  });
}

/** Every page of a listing, fetched page by page. `glab api --paginate` retries
 *  nothing: one connection reset on page 21 of ~30 failed the whole listing
 *  three times over and cost the 2026-10-19 kudos. Here a bad page is retried
 *  alone. `path` must not carry its own page/per_page. */
async function glabAllPages<T>(path: string): Promise<T[]> {
  const perPage = 100;
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const rows = await glabApi<T>(`${path}${sep}per_page=${perPage}&page=${page}`);
    out.push(...rows);
    if (rows.length < perPage) return out;
  }
}

interface RawMr {
  project_id: number;
  iid: number;
  title: string;
  web_url: string;
  author: { username: string; name: string };
  created_at: string;
  merged_at: string | null;
  target_branch: string;
  source_branch: string;
  user_notes_count: number;
  upvotes: number;
  description: string | null;
  references: { full: string };
}

export async function listMergedMrs(
  sinceIso: string,
): Promise<{ mrs: MergedMr[]; authors: Map<string, string> }> {
  const raw = await glabAllPages<RawMr>(
    `groups/${GROUP}/merge_requests?state=merged&scope=all&updated_after=${sinceIso}`,
  );
  const authors = new Map<string, string>();
  const mrs: MergedMr[] = [];
  for (const m of raw) {
    // updated_after also returns MRs merged long ago and touched since.
    if (!m.merged_at || m.merged_at < sinceIso) continue;
    authors.set(m.author.username, m.author.name);
    mrs.push({
      project: m.references.full.replace(/^openmarketxyz\//, "").replace(/!\d+$/, ""),
      projectId: m.project_id,
      iid: m.iid,
      title: m.title,
      url: m.web_url,
      author: m.author.username,
      createdAt: m.created_at,
      mergedAt: m.merged_at,
      targetBranch: m.target_branch,
      sourceBranch: m.source_branch,
      userNotes: m.user_notes_count,
      upvotes: m.upvotes,
      description: m.description ?? "",
    });
  }
  return { mrs, authors };
}

interface RawCommit {
  authored_date: string;
}

/** Distinct local (UTC+8) days on which commits on each MR were authored, for the
 *  MRs passed in, keyed "<projectId>!<iid>". Authored dates, not committed:
 *  a rebase or force-push rewrites the committed date of every commit to the day
 *  of the rebase, which would make a one-day MR rebased weekly look long-running. */
export async function commitDays(mrs: MergedMr[]): Promise<Map<string, number>> {
  const days = new Map<string, number>();
  const queue = [...mrs];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const commits = await glabAllPages<RawCommit>(
        `projects/${m.projectId}/merge_requests/${m.iid}/commits`,
      ).catch(() => [] as RawCommit[]);
      const local = commits.map((c) =>
        new Date(Date.parse(c.authored_date) + 8 * 3_600_000).toISOString().slice(0, 10),
      );
      days.set(`${m.projectId}!${m.iid}`, new Set(local).size);
    }
  };
  await Promise.all(Array.from({ length: NOTE_CONCURRENCY }, worker));
  return days;
}

interface RawNote {
  system: boolean;
  author: { username: string };
}

/** Non-system notes on an MR written by someone other than its author. GitLab's
 *  user_notes_count cannot tell these apart: an author replying to themselves
 *  would otherwise read as recognition. */
export async function notesFromOthers(
  mrs: MergedMr[],
  isBot: (username: string) => boolean,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const queue = mrs.filter((m) => m.userNotes > 0);
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const notes = await glabApi<RawNote>(
        `projects/${m.projectId}/merge_requests/${m.iid}/notes?per_page=100`,
      ).catch(() => [] as RawNote[]);
      const n = notes.filter(
        (x) => !x.system && x.author.username !== m.author && !isBot(x.author.username),
      ).length;
      if (n > 0) counts.set(m.author, (counts.get(m.author) ?? 0) + n);
    }
  };
  await Promise.all(Array.from({ length: NOTE_CONCURRENCY }, worker));
  return counts;
}
