// Turn raw GitLab + OM Chat reads into one PersonStats per author.

import type { MergedMr, PersonStats } from "./types";

/** An MR open at least this long is worth checking for sustained work. */
export const HARD_MR_DAYS = 3;
/** ...and it counts as hard only if commits went in on this many distinct days.
 *  An MR left open and untouched for a month is not effort (2026-10-12). */
export const HARD_MR_COMMIT_DAYS = 3;
const DAY_MS = 86_400_000;
const LOCAL_OFFSET_MS = 8 * 3_600_000; // the team works in UTC+8

export function isBot(username: string, name = ""): boolean {
  return (
    /^project_\d+_bot|^service_account|bot$/i.test(username) ||
    /\bbot\b/i.test(name) ||
    username === "ghost1"
  );
}

/** A production cherry-pick repeats work already counted on main. kiyotaka-frontend
 *  ships every fix twice ("... (production)", prodpick/ branches); counting both
 *  would double anyone who follows that rule. */
export function isProductionPick(mr: MergedMr): boolean {
  return (
    mr.targetBranch === "production" &&
    (/^prodpick\//.test(mr.sourceBranch) ||
      /\(production\b/i.test(mr.title) ||
      /-production$/.test(mr.sourceBranch))
  );
}

export function isFix(mr: MergedMr): boolean {
  return /^fix(\(|!|:)/i.test(mr.title) || closedIssueRefs(mr) > 0;
}

export function closedIssueRefs(mr: MergedMr): number {
  return (mr.description.match(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d+/gi) ?? []).length;
}

export function daysOpen(mr: MergedMr): number {
  return (Date.parse(mr.mergedAt) - Date.parse(mr.createdAt)) / DAY_MS;
}

const localDay = (iso: string) =>
  new Date(Date.parse(iso) + LOCAL_OFFSET_MS).toISOString().slice(0, 10);

/** Night (22:00-07:00) or weekend, local time. Weekend and late work count as
 *  effort (2026-10-12). Caveat: routines that open or auto-merge MRs overnight
 *  under a person's account look like that person working late. */
export function isOffHours(iso: string): boolean {
  const local = new Date(Date.parse(iso) + LOCAL_OFFSET_MS);
  const hour = local.getUTCHours();
  const day = local.getUTCDay(); // 0 Sun ... 6 Sat
  return day === 0 || day === 6 || hour >= 22 || hour < 7;
}

export function buildStats(args: {
  mrs: MergedMr[];
  names: Map<string, string>;
  handles: Record<string, string>;
  notesFromOthers: Map<string, number>;
  commitDays: Map<string, number>; // "<projectId>!<iid>" -> distinct commit days
  chatMentions: Map<string, number>; // keyed by OM Chat handle
  picMentions: Map<string, number>; // keyed by OM Chat handle
  lastKudos: Map<string, string>; // keyed by GitLab username
}): PersonStats[] {
  const byAuthor = new Map<string, MergedMr[]>();
  for (const mr of args.mrs) {
    if (isBot(mr.author, args.names.get(mr.author)) || isProductionPick(mr)) continue;
    byAuthor.set(mr.author, [...(byAuthor.get(mr.author) ?? []), mr]);
  }
  return [...byAuthor.entries()].map(([gitlab, mrs]) => {
    const handle = args.handles[gitlab] ?? null;
    const worked = mrs.map((m) => args.commitDays.get(`${m.projectId}!${m.iid}`) ?? 1);
    return {
      gitlab,
      name: args.names.get(gitlab) ?? gitlab,
      handle,
      mrs,
      mergedCount: mrs.length,
      repos: new Set(mrs.map((m) => m.project)).size,
      activeDays: new Set(mrs.map((m) => localDay(m.mergedAt))).size,
      fixesShipped: mrs.filter(isFix).length,
      issuesClosed: mrs.reduce((n, m) => n + closedIssueRefs(m), 0),
      hardMrs: worked.filter((d) => d >= HARD_MR_COMMIT_DAYS).length,
      mostCommitDays: Math.max(0, ...worked),
      // Opening an MR is a deliberate act; a merge may be GitLab's auto-merge
      // landing whenever CI finishes. Both count, once per local day.
      offHoursDays: new Set(
        mrs
          .flatMap((m) => [m.createdAt, m.mergedAt])
          .filter(isOffHours)
          .map(localDay),
      ).size,
      notesFromOthers: args.notesFromOthers.get(gitlab) ?? 0,
      upvotes: mrs.reduce((n, m) => n + m.upvotes, 0),
      chatMentions: handle ? (args.chatMentions.get(handle) ?? 0) : 0,
      picMentions: handle ? (args.picMentions.get(handle) ?? 0) : 0,
      lastKudosAt: args.lastKudos.get(gitlab) ?? null,
    };
  });
}
