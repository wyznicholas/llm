// Shared shapes for the kudos routine. See tools/kudos/README.md for the why.

/** One merged MR, trimmed to what scoring and the post writer need. */
export interface MergedMr {
  project: string; // e.g. "frontend/kiyotaka-frontend-app"
  projectId: number;
  iid: number;
  title: string;
  url: string;
  author: string; // GitLab username
  createdAt: string; // ISO
  mergedAt: string; // ISO
  targetBranch: string;
  sourceBranch: string;
  userNotes: number; // GitLab's count, includes the author's own notes
  upvotes: number;
  description: string;
}

/** Everything known about one person over the window. Effort and recognition
 *  are kept apart so the scorer can weigh "did a lot" against "was thanked". */
export interface PersonStats {
  gitlab: string;
  name: string;
  handle: string | null; // OM Chat handle, null when people.json has no match

  // effort
  mrs: MergedMr[]; // deduped: production cherry-picks and bot MRs removed
  mergedCount: number;
  repos: number; // distinct projects merged into
  activeDays: number; // distinct local (UTC+8) days with a merge
  fixesShipped: number; // fix(...) MRs and MRs that close an issue
  issuesClosed: number; // "Closes #N" / "Fixes #N" references
  hardMrs: number; // MRs with commits pushed on >= HARD_MR_COMMIT_DAYS distinct days
  mostCommitDays: number; // the most distinct commit days on any one MR
  offHoursDays: number; // distinct days an MR was opened or merged at night or on a weekend

  // recognition
  notesFromOthers: number; // non-system notes on their MRs by someone else
  upvotes: number;
  chatMentions: number; // @handle by another human in the space's rooms
  picMentions: number; // named in an @openmarket post in #announcements
  lastKudosAt: string | null;
}

export interface KudosRecord {
  gitlab: string;
  handle: string;
  at: string; // ISO
  kind: "weekly" | "launch";
  seq?: number;
  dryRun?: boolean;
}

export interface KudosState {
  kudos: KudosRecord[];
  /** Newest message id already read in the operator's Followed Discord channel. */
  discordAfter?: string;
  /** Posts sent so far that carried the "built by" credit line. */
  builderCredits?: number;
  /** Local (UTC+8) date of the last run that finished; later slots that day skip. */
  lastSuccessDay?: string;
  /** Launches already thanked, so one announced in both OM Chat and Discord is
   *  thanked once. */
  launches?: Array<{ at: string; source: string; announcement: string }>;
}
