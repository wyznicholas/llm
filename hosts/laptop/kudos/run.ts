#!/usr/bin/env bun
// Kudos routine: thank teammates in #special-mentions for a body of work, and the
// team behind each launch announced on the public Discord. README.md has the
// design.
//
// Usage: bun tools/kudos/run.ts [--dry-run] [--weekly] [--no-launch] [--no-weekly] [--force]
//   --dry-run    draft everything, post nothing, record nothing
//   --weekly     run the weekly pick even on a day that is not a kudos day
//   --no-launch  skip the Discord launch check
//   --no-weekly  skip the weekly pick even on a kudos day
//   --force      run even if a run already succeeded today

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ChatEntry,
  countMentions,
  KUDOS_ROOM,
  qaHandles,
  roomHistory,
  spaceRooms,
} from "./chat";
import { discordConfigured, discordPostsAfter } from "./discord";
import { commitDays, listMergedMrs, notesFromOthers } from "./gitlab";
import { loadState, postAsAgent, postProblems, STATE_DIR, saveState, sealMentions } from "./post";
import { lastKudosByPerson, type Pick, rankRecipients } from "./score";
import { buildStats, daysOpen, HARD_MR_DAYS, isBot, isFix } from "./stats";
import type { KudosState, PersonStats } from "./types";
import { type Draft, writeDraft } from "./writer";

const WINDOW_DAYS = 14;
// Once a week, on Friday (Nicholas, 2026-10-23; Mon/Wed/Fri before that), so a
// kudos still means something when it lands. Launch posts are not limited:
// they follow the public Discord announcements, any day.
const KUDOS_WEEKDAYS = new Set([5]); // Friday, local time
// Launches come only from the public Discord (2026-10-12); OM Chat's
// #announcements is not watched for them. A PIC callout by these accounts in
// OM Chat still counts as recognition in the weekly pick: it is public credit.
const ANNOUNCERS = new Set(["openmarket", "justintg"]);
const DAY_MS = 86_400_000;

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const people = JSON.parse(readFileSync(join(dirname(import.meta.path), "people.json"), "utf8")) as {
  handles: Record<string, string>;
  names: Record<string, string>;
  exclude: string[];
};
const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
const draftsDir = join(STATE_DIR, "drafts");
const workDir = join(STATE_DIR, "work", today);

function log(msg: string) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

/** Problems with the writer's tags beyond the text checks in postProblems. */
function tagProblems(draft: Draft, excluded: Set<string>): string[] {
  const known = new Set(Object.values(people.handles));
  return draft.tags.flatMap((t) => [
    ...(known.has(t) ? [] : [`tags unknown handle @${t}`]),
    ...(excluded.has(t) ? [`tags excluded @${t}`] : []),
  ]);
}

// Nicholas built this and asked (2026-10-12) to be credited on the first
// couple of posts. Added here, after the writer, so the model can neither drop
// nor reword it; the post checks run on the final text.
const BUILDER_HANDLE = "nicholas_trontal";
const BUILDER_CREDIT_POSTS = 2;

export function withBuilderCredit(post: string, creditsGiven: number): string {
  if (creditsGiven >= BUILDER_CREDIT_POSTS) return post;
  return `${post}\n\n_Kudos bot built by @${BUILDER_HANDLE}_`;
}

/** Draft, and give a draft with no numbers one more, pointed attempt.
 *  Statistics are what make a kudos land (Nicholas, 2026-10-21), but the
 *  writer must never invent one, so the second attempt is told what it tried
 *  and where else to look, and a post without numbers can still go out. */
async function draftWithStats(mode: "weekly" | "launch", evidence: unknown): Promise<Draft> {
  const first = await writeDraft(mode, evidence, workDir);
  if (first.skip || first.facts.length > 0) return first;
  log(
    `${mode}: first draft has no statistics (${first.noStatsReason ?? "no reason given"}); retrying`,
  );
  const second = await writeDraft(mode, evidence, workDir, first.noStatsReason ?? "");
  if (second.skip || second.facts.length > 0) return second;
  log(`${mode}: still no statistics after a second attempt; posting without them`);
  return second.post ? second : first;
}

async function deliver(
  state: KudosState,
  kind: "weekly" | "launch",
  draft: Draft,
  mustTag: string[],
  excluded: Set<string>,
  label: string,
): Promise<number | null> {
  mkdirSync(draftsDir, { recursive: true });
  const credits = state.builderCredits ?? 0;
  const sealed = sealMentions(draft.post, Object.values(people.handles));
  const post = withBuilderCredit(sealed, credits);
  const problems = [...postProblems(post, mustTag), ...tagProblems(draft, excluded)];
  const file = join(draftsDir, `${today}-${kind}-${label}${DRY ? ".dry" : ""}.md`);
  const facts = draft.facts.map((f) => `- ${f.claim}\n  source: ${f.source}`).join("\n");
  const noStats =
    draft.facts.length === 0
      ? `no statistics: ${draft.noStatsReason ?? "(no reason given)"}\n`
      : "";
  writeFileSync(
    file,
    `${post}\n\n---\nfacts:\n${facts || "(none)"}\n${noStats}problems: ${problems.join("; ") || "none"}\n`,
  );
  if (problems.length)
    throw new Error(`refusing to post ${kind} kudos: ${problems.join("; ")} (draft: ${file})`);
  if (DRY) {
    log(`dry run: ${kind} draft written to ${file}`);
    return null;
  }
  const seq = await postAsAgent(KUDOS_ROOM, post);
  if (post !== sealed) state.builderCredits = credits + 1;
  log(`posted ${kind} kudos for ${label} seq=${seq ?? "?"}`);
  return seq;
}

interface LaunchAnnouncement {
  source: "public Discord";
  id: string;
  ts: string;
  author: string;
  text: string;
}

const LAUNCH_MEMORY_DAYS = 14;

/** Draft and send one launch kudos. The writer sees what was thanked recently
 *  and skips a repeat (an announcement edited and re-posted, say). */
async function thankLaunch(
  state: KudosState,
  excluded: Set<string>,
  announcement: LaunchAnnouncement,
  label: string,
): Promise<void> {
  log(`launch check: candidate ${announcement.source} ${announcement.id}`);
  const cutoff = Date.now() - LAUNCH_MEMORY_DAYS * DAY_MS;
  const alreadyThanked = (state.launches ?? []).filter((l) => Date.parse(l.at) >= cutoff);
  const draft = await draftWithStats("launch", {
    announcement,
    alreadyThanked,
    handles: people.handles,
    names: people.names,
    excluded: [...excluded],
  });
  if (draft.skip) {
    log(`launch check: writer skipped ${announcement.id}: ${draft.skip}`);
    return;
  }
  const seq = await deliver(state, "launch", draft, [], excluded, label);
  if (DRY) return;
  const at = new Date().toISOString();
  state.launches = [
    ...(state.launches ?? []),
    { at, source: announcement.source, announcement: announcement.text.slice(0, 300) },
  ];
  // Launch kudos are recorded but never start anyone's 14-day freeze: being on
  // a launch team is different praise from the weekly pick.
  for (const handle of draft.tags) {
    const gitlab = Object.entries(people.handles).find(([, h]) => h === handle)?.[0] ?? handle;
    state.kudos.push({ gitlab, handle, at, kind: "launch", ...(seq ? { seq } : {}) });
  }
}

async function discordLaunchCheck(state: KudosState, excluded: Set<string>): Promise<void> {
  if (!discordConfigured()) {
    log("discord: not configured, skipping");
    return;
  }
  // Replays from a given message id, for checking it in a dry run.
  const after = process.env.KUDOS_DISCORD_FROM ?? state.discordAfter ?? "0";
  const read = await discordPostsAfter(after);
  if (!read) return;
  if (after === "0") {
    if (!DRY) state.discordAfter = read.head;
    log(`discord: first run, watching from message ${read.head}`);
    return;
  }
  // Every Followed announcement goes to the writer, which skips anything that
  // is not a shipped release. A keyword filter used to decide first, and
  // silently dropped the desktop-app launch ("our desktop apps are here!",
  // 2026-10-21) because none of its words were on the list.
  for (const post of read.posts) {
    await thankLaunch(state, excluded, { source: "public Discord", ...post }, `discord${post.id}`);
    if (!DRY) {
      state.discordAfter = post.id;
      saveState(state);
    }
  }
  if (!DRY) state.discordAfter = read.head;
}

function rankingTable(picks: Pick[]): string {
  const rows = picks
    .slice(0, 12)
    .map(
      (p) =>
        `| ${p.person.handle} | ${p.person.mergedCount} | ${p.person.fixesShipped} | ${p.person.activeDays} | ${p.person.hardMrs} | ${p.person.offHoursDays} | ${p.effort.toFixed(1)} | ${p.recognition} | ${p.gap.toFixed(2)} |`,
    );
  return [
    "| handle | MRs | fixes | days | hard | off-hours days | effort | recog | gap |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

const localDayOf = (iso: string) =>
  new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 10);

async function weekly(state: KudosState, excluded: Set<string>): Promise<void> {
  if (state.kudos.some((k) => k.kind === "weekly" && !k.dryRun && localDayOf(k.at) === today)) {
    log("weekly: already posted today");
    return;
  }
  const now = Date.now();
  const sinceMs = now - WINDOW_DAYS * DAY_MS;
  const since = new Date(sinceMs).toISOString();
  log(`weekly: reading MRs merged since ${since}`);
  const { mrs, authors } = await listMergedMrs(since);
  // Notes cost one request each: only fetch them for people who could be picked.
  const candidates = mrs.filter(
    (m) =>
      !isBot(m.author, authors.get(m.author)) &&
      !excluded.has(m.author) &&
      people.handles[m.author],
  );
  const notes = await notesFromOthers(candidates, (u) => isBot(u));
  // Commit history is only fetched where it can matter: MRs open long enough to be hard.
  const worked = await commitDays(candidates.filter((m) => daysOpen(m) >= HARD_MR_DAYS));
  log(`weekly: ${mrs.length} MRs, ${candidates.length} from pickable people`);

  const chat: ChatEntry[] = [];
  for (const room of await spaceRooms()) {
    chat.push(...(await roomHistory(room, sinceMs).catch(() => [])));
    await Bun.sleep(1000); // reads spend the operator's own rate budget
  }
  const handles = Object.values(people.handles);
  const announcements = chat.filter((e) => ANNOUNCERS.has(e.handle));
  const lastKudos = lastKudosByPerson(state.kudos);
  const stats = buildStats({
    mrs,
    names: authors,
    handles: people.handles,
    notesFromOthers: notes,
    commitDays: worked,
    chatMentions: countMentions(chat, handles),
    picMentions: countMentions(announcements, handles),
    lastKudos,
  });

  const picks = rankRecipients(stats, excluded, now);
  mkdirSync(draftsDir, { recursive: true });
  writeFileSync(join(draftsDir, `${today}-ranking.md`), `${rankingTable(picks)}\n`);
  const pick = picks[0];
  if (!pick) {
    log("weekly: nobody eligible this run");
    return;
  }
  const person: PersonStats = pick.person;
  // Lead the writer with the work most worth naming: fixes and long-haul MRs.
  const mrsForWriter = [...person.mrs]
    .sort(
      (a, b) =>
        Number(isFix(b)) - Number(isFix(a)) ||
        (worked.get(`${b.projectId}!${b.iid}`) ?? 1) - (worked.get(`${a.projectId}!${a.iid}`) ?? 1),
    )
    .slice(0, 25)
    .map((m) => ({
      ...m,
      daysOpen: Math.round(daysOpen(m) * 10) / 10,
      description: m.description.slice(0, 600),
    }));
  log(`weekly: picked @${person.handle} (gap ${pick.gap.toFixed(2)})`);
  const draft = await draftWithStats("weekly", {
    // The GitLab profile name stays out: it is how the 11-03 post came to
    // call CJ "Ji". The writer gets the name people use, or none.
    person: { ...person, name: people.names[person.gitlab] ?? null, mrs: mrsForWriter },
    windowDays: WINDOW_DAYS,
    handles: people.handles,
    names: people.names,
    excluded: [...excluded],
  });
  if (draft.skip) {
    log(`weekly: writer skipped: ${draft.skip}`);
    return;
  }
  const handle = person.handle as string;
  const seq = await deliver(state, "weekly", draft, [handle], excluded, handle);
  if (!DRY) {
    state.kudos.push({
      gitlab: person.gitlab,
      handle,
      at: new Date().toISOString(),
      kind: "weekly",
      ...(seq ? { seq } : {}),
    });
    // Saved at once: if a later step fails, the retry run must see this post.
    saveState(state);
  }
}

async function main(): Promise<void> {
  const state = loadState();
  // launchd fires at 10:15 and again at 12:15, 15:15 and 18:15 as fallbacks
  // for a morning run lost to sleep or a network failure. Once a run has
  // succeeded, the later ones do nothing.
  if (!DRY && !args.has("--force") && state.lastSuccessDay === today) {
    log(`already ran successfully today (${today})`);
    return;
  }
  // Fails closed: without the live @QA role the run cannot keep QAs out.
  const qa = await qaHandles();
  const excluded = new Set([...people.exclude, ...qa]);
  // A GitLab username whose handle is a QA is excluded too.
  for (const [gitlab, handle] of Object.entries(people.handles))
    if (qa.has(handle)) excluded.add(gitlab);
  log(`excluded: ${[...excluded].join(", ")}`);

  if (!args.has("--no-launch")) await discordLaunchCheck(state, excluded);
  const weekday = new Date(Date.now() + 8 * 3_600_000).getUTCDay();
  if (args.has("--no-weekly")) log("weekly: skipped (--no-weekly)");
  else if (args.has("--weekly") || KUDOS_WEEKDAYS.has(weekday)) await weekly(state, excluded);
  else log("weekly: not a kudos day");
  if (!DRY) {
    state.lastSuccessDay = today;
    saveState(state);
  }
}

// Guarded so tests can import withBuilderCredit without starting a run.
if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    // One readable line in the log; the next scheduled slot today retries.
    log(`run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
