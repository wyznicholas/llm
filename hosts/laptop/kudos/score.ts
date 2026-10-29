// Who gets this run's kudos.
//
// The target is "doing lots of work and deserves a well done": high effort that
// has drawn little recognition. Each person is ranked against the team on both
// axes and the pick is the widest gap, so one huge number (a 300-MR fortnight)
// cannot drown out everything else, and someone already thanked publicly drops
// down the list on their own.

import type { KudosRecord, PersonStats } from "./types";

export const FREEZE_DAYS = 14;
const DAY_MS = 86_400_000;

/** How much work someone did over the window. Higher is more.
 *
 *  The signals chosen for it (2026-10-12): bugs closed / fixes shipped, active
 *  days + hard MRs, merged MR count, and night / weekend work. Reviews given
 *  and breadth (repos) are deliberately NOT counted.
 *
 *  Only the ORDER matters: pickRecipient turns this into a team percentile.
 *  Keep raw MR count damped (Math.log1p or a cap); every MR here is written
 *  with Opus/Fable, so MR count is closer to agent throughput than to human
 *  effort, while active days and hard MRs are harder to inflate. A hard MR is
 *  one with commits on >= 3 distinct days, so an MR merely left open for weeks
 *  scores nothing extra.
 */
export function effortScore(p: PersonStats): number {
  // Weights chosen by Nicholas, 2026-10-12:
  //  - a hard MR is worth no more than a quick fix, so both weigh 2;
  //  - MR count is damped on a log scale so volume can't decide the pick alone;
  //  - breadth (repos) is not counted;
  //  - night and weekend work counts, like an ordinary active day.
  return (
    2 * p.fixesShipped +
    3 * p.issuesClosed +
    1.5 * p.activeDays +
    2 * p.hardMrs +
    2 * Math.log1p(p.mergedCount) +
    1.5 * p.offHoursDays
  );
}

/** How much they have already been thanked. Higher is more. */
export function recognitionScore(p: PersonStats): number {
  // A PIC callout in #announcements is the loudest public credit this team
  // gives, so it outweighs a stray comment.
  return p.notesFromOthers + 2 * p.upvotes + p.chatMentions + 5 * p.picMentions;
}

/** Rank-based percentile in [0, 1]; ties share the lower rank. */
export function percentiles(values: number[]): number[] {
  if (values.length <= 1) return values.map(() => 0.5);
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((v) => sorted.indexOf(v) / (values.length - 1));
}

export interface Pick {
  person: PersonStats;
  effort: number;
  recognition: number;
  gap: number;
}

/** When each person was last thanked in a real post, by GitLab username.
 *
 *  Launch thank-yous count as well as weekly ones (2026-10-29): the weekly
 *  pick is for work nobody has noticed, and a public launch credit is being
 *  noticed. Counting weekly only, the 10-30 pick would have been Bryan, two
 *  days after the iOS launch post thanked him by name. */
export function lastKudosByPerson(kudos: KudosRecord[]): Map<string, string> {
  const last = new Map<string, string>();
  for (const k of kudos) {
    if (k.dryRun) continue;
    const prev = last.get(k.gitlab);
    if (!prev || Date.parse(k.at) > Date.parse(prev)) last.set(k.gitlab, k.at);
  }
  return last;
}

export function eligible(p: PersonStats, excluded: Set<string>, now: number): boolean {
  if (!p.handle || excluded.has(p.gitlab) || excluded.has(p.handle)) return false;
  if (p.lastKudosAt && now - Date.parse(p.lastKudosAt) < FREEZE_DAYS * DAY_MS) return false;
  return true;
}

/** Rank the whole team (so percentiles mean "against everyone"), then return
 *  eligible people by widest effort-over-recognition gap. */
export function rankRecipients(
  people: PersonStats[],
  excluded: Set<string>,
  now: number,
  score: (p: PersonStats) => number = effortScore,
): Pick[] {
  const effort = people.map(score);
  const recognition = people.map(recognitionScore);
  const ep = percentiles(effort);
  const rp = percentiles(recognition);
  return people
    .map((person, i) => ({
      person,
      effort: effort[i] ?? 0,
      recognition: recognition[i] ?? 0,
      gap: (ep[i] ?? 0) - (rp[i] ?? 0),
    }))
    .filter((x) => x.effort > 0 && eligible(x.person, excluded, now))
    .sort((a, b) => b.gap - a.gap || b.effort - a.effort);
}
