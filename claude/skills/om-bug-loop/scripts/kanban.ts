#!/usr/bin/env bun
// kanban.ts — the Obsidian Kanban mirror of the om-bug-loop pipeline.
//
// The board is a file a human also edits (dragging cards in Obsidian), so this
// is a surgical line editor, never a renderer: it owns the column skeleton and
// its own cards, and every other line — hand-written cards, the plugin's
// `%% kanban:settings %%` trailer — survives byte-for-byte.
//
// Only the coordinator runs this. Agents report; the coordinator moves cards.
//
// `<task>` below is a ref (`T5`) or a slug — Nicholas types refs, agents type
// slugs, and both resolve through the same door.
//
// Usage:
//   bun kanban.ts init [--board <path>]
//   bun kanban.ts upsert <task> --column <col> [--title <text>] [--no-stamp] [--board <path>]
//   bun kanban.ts note <task> --file <md> [--board <path>]
//   bun kanban.ts stamp <task> [--tasks <path>] [--now <iso>]
//   bun kanban.ts stage <task> <stage> [--tasks <path>] [--now <iso>]
//   bun kanban.ts check <task> --item "<text>" [--done|--undone]
//   bun kanban.ts feature <task> (--file <md> ... | --none "<why>")
// `review-skip` was retired on 2026-09-17; category grouping replaced it.
//   bun kanban.ts traincard <train-key> [--column <col>]
//   bun kanban.ts list [--board <path>] [--tasks <path>]
//   bun kanban.ts next-ref [--tasks <path>]
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isTier, tier as decideTier, tierRank, TIERS } from "./routing";

export const COLUMNS = [
  // `backlog` is the one column the pipeline never advances a card INTO or OUT
  // of on its own: it is a holding pen Nicholas and the coordinator both write
  // to freely, and a card leaves it only by being promoted to `todo` with a ref
  // issued by `next-ref`. It therefore has no COLUMN_STAGE entry and requires
  // no card note — a backlog line is a sentence, not an investigation.
  "backlog",
  "todo", "in progress", "Need Attention", "Review", "Done", "Withdrawn",
] as const;
export type Column = (typeof COLUMNS)[number];

export const DEFAULT_BOARD =
  "/Users/nicholas/Documents/Obisidian/kanban/Kanban.md";

/** The Obsidian Kanban plugin's own file shape, settings trailer included: the
 *  plugin writes that block itself, and a board missing it is a board whose
 *  format we are guessing at. */
export const SETTINGS_TRAILER =
  ["%% kanban:settings", "```", '{"kanban-plugin":"board"}', "```", "%%", ""].join("\n");
export const SKELETON =
  ["---", "", "kanban-plugin: board", "", "---", "",
    ...COLUMNS.flatMap(c => [`## ${c}`, "", ""]), SETTINGS_TRAILER].join("\n");

/**
 * The wikilink target for a card's note.
 *
 * Obsidian resolves `[[…]]` from the VAULT ROOT, not from the folder the board
 * sits in, so a bare `cards/<slug>` names a note at `<vault>/cards/<slug>` —
 * which does not exist, renders as a dead link, and on click creates the note
 * OUTSIDE the kanban folder. Emit the vault-relative path instead, falling back
 * to the bare form when the board is not inside a vault (tests, temp boards).
 */
export function cardTarget(board: string, slug: string): string {
  const dir = dirname(board);
  let root = dir;
  while (root !== dirname(root) && !existsSync(join(root, ".obsidian"))) root = dirname(root);
  return existsSync(join(root, ".obsidian"))
    ? relative(root, join(dir, "cards", slug))
    : `cards/${slug}`;
}

/** Every task is `low` unless someone says otherwise (Nicholas, 2026-09-07:
 *  "any task coming from me is low, unless specified"). Escalation is explicit;
 *  nothing is silently important. */
export const DEFAULT_PRIORITY = "low";

export const CARD_CATEGORIES = [
  { n: 1, key: "keyboard-focus", label: "Keyboard & focus", grouped: true },
  { n: 2, key: "screen-reader", label: "Screen-reader semantics", grouped: true },
  { n: 3, key: "layout-width", label: "Layout at a width", grouped: true },
  { n: 4, key: "raw-data", label: "Raw data leaking into UI", grouped: false },
  { n: 5, key: "stale-state", label: "Stale or wrong state", grouped: true },
  { n: 6, key: "write-safety", label: "Write safety", grouped: false },
  { n: 7, key: "routing-history", label: "Routing & history", grouped: true },
  { n: 8, key: "dead-ends", label: "Dead ends & hidden features", grouped: false },
  { n: 9, key: "visual-copy", label: "Visual consistency & copy", grouped: true },
  { n: 10, key: "product-decision", label: "Product decisions disguised as bugs", grouped: false },
  { n: 11, key: "not-real", label: "Findings that weren't real", grouped: true },
  { n: 12, key: "pipeline-infra", label: "Pipeline & test infrastructure", grouped: false },
] as const;
export type CardCategory = (typeof CARD_CATEGORIES)[number];
export type CardCategoryKey = CardCategory["key"];
export const GROUP_LANES = ["todo", "Review"] as const;
export type GroupLane = (typeof GROUP_LANES)[number];
export const CATEGORIES_DOC = join(import.meta.dir, "../references/card-categories.md");

export interface CardSummary {
  problem: string;
  solution: string;
  repro: string[];
}

/** Why a compact group summary is unsafe to render, or null when it is valid. */
export function summaryProblem(summary: unknown): string | null {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return "summary must be an object with problem, solution and repro";
  }
  const value = summary as Record<string, unknown>;
  const image = (text: string) => text.includes("![[") || text.includes("![");
  for (const key of ["problem", "solution"] as const) {
    const text = value[key];
    if (typeof text !== "string" || text.trim() === "") {
      return `summary.${key} must be a non-empty string`;
    }
    if (text.trim().length > 400) return `summary.${key} is over 400 characters`;
    if (image(text)) return `summary.${key} must not contain an image embed`;
  }
  if (!Array.isArray(value.repro) || value.repro.length < 1 || value.repro.length > 8) {
    return "summary.repro must contain 1 to 8 steps";
  }
  for (const [i, step] of value.repro.entries()) {
    if (typeof step !== "string" || step.trim() === "") {
      return `summary.repro[${i}] must be a non-empty string`;
    }
    if (step.trim().length > 240) return `summary.repro[${i}] is over 240 characters`;
    if (image(step)) return `summary.repro[${i}] must not contain an image embed`;
  }
  return null;
}

const categoryFor = (key: unknown): CardCategory | undefined =>
  CARD_CATEGORIES.find(category => category.key === key);

export function groupId(lane: string, category: string): string {
  const laneKey = lane === "Review" ? "review" : lane;
  return `group-${laneKey}-${category}`;
}

export function parseGroupId(id: string): { lane: GroupLane; category: CardCategoryKey } | null {
  const hit = /^group-(todo|review)-(.+)$/.exec(id);
  if (!hit || !categoryFor(hit[2])) return null;
  return {
    lane: hit[1] === "review" ? "Review" : "todo",
    category: hit[2] as CardCategoryKey,
  };
}

export function groupLine(
  board: string, lane: GroupLane, category: CardCategoryKey, count: number,
): string {
  const found = categoryFor(category)!;
  return `- [ ] **${lane} · ${found.label} (${count})** ` +
    `[[${cardTarget(board, groupId(lane, category))}|details]] #openmarket #group`;
}

export function groupTarget(entry: TaskLike, column: string | undefined): string | null {
  if (!(GROUP_LANES as readonly string[]).includes(column ?? "")) return null;
  // A train member is indexed by its train card. Grouping it too put one MR on
  // a train card AND on every category card its fixes fell into (!101 sat on
  // three cards plus 20 loose lines, 2026-09-28).
  if (trainFoldTarget(entry, "Review")) return null;
  if (typeof entry.ref !== "string" || !/^[TF]\d+$/i.test(entry.ref)) return null;
  const category = categoryFor(entry.category);
  if (!category?.grouped) return null;
  if (summaryProblem(entry.summary) !== null) return null;
  if (typeof entry.groupExempt === "string" && entry.groupExempt.trim()) return null;
  return groupId(column!, category.key);
}

/**
 * The train card a shipped member folds into while it sits in Review.
 *
 * One card per MR (Nicholas, 2026-09-18; restated 2026-09-28): a card may list
 * several MRs, but an MR is on exactly one card. `train.ts ship` still moves the
 * member through `upsert --column Review` so the Review gate runs, and that used
 * to leave the member's own line in Review beside its train card — 26 trains
 * showed up on more than one card. Done folds too, or `train.ts landed` would
 * rebuild every duplicate there. Other lanes keep the member's own line: a
 * dropped fix in Need Attention is its own question, not the MR's.
 */
export function trainFoldTarget(entry: TaskLike, column: string | undefined): string | null {
  if (column !== "Review" && column !== "Done") return null;
  if (typeof entry.train !== "string" || !entry.train.trim()) return null;
  if (typeof entry.mrUrl !== "string" || !entry.mrUrl.trim()) return null;
  return `train-${entry.train}`;
}

export const PLAY_AROUND_ORIGIN = "om-play-around";
export const SOURCE_MARKER = "<!-- om-bug-loop:source om-play-around -->";
const CATEGORY_MARKER = /^\s*<!-- om-bug-loop:category (\S+) -->\s*$/m;
const SUMMARY_MARKER = /^\s*<!-- om-bug-loop:summary (.+) -->\s*$/m;

export function readCategoryMarker(note: string): string | null {
  return CATEGORY_MARKER.exec(note)?.[1] ?? null;
}

export function readSummaryMarker(note: string): CardSummary | null {
  const encoded = SUMMARY_MARKER.exec(note)?.[1];
  if (!encoded) return null;
  try { return JSON.parse(encoded) as CardSummary; } catch { return null; }
}

const categoryMarkerLine = (category: string) =>
  `<!-- om-bug-loop:category ${category} -->`;
const summaryMarkerLine = (summary: CardSummary) =>
  `<!-- om-bug-loop:summary ${JSON.stringify(summary).replaceAll("--", "\\u002d\\u002d")} -->`;

/** Whether a note carries the exact, machine-owned play-around source line. */
export function hasPlayAroundMarker(note: string): boolean {
  return note.split(/\r?\n/).some(line => line.trim() === SOURCE_MARKER);
}

/** A feature is identified only by its routing ref or explicit routing tag. */
export function isFeatureCard(ref: string | null | undefined, tags: string[]): boolean {
  return (typeof ref === "string" && /^f/i.test(ref)) ||
    tags.some(tag => tag.toLowerCase() === "#feature");
}

/**
 * Nicholas's 2026-09-17 rule is: "for the bugs/tickets it creates from play
 * around, it can never reach #high, only #feature can" — non-feature findings
 * from play-around cap at medium. Six play-around bugs filed #high on
 * 2026-09-16 and jumped the dispatch queue. Origin is therefore a marker
 * written by `file-finding`, carried into tasks.json as `origin` by `consume`,
 * and never inferred from title text, tags, or evidence names.
 */
export function playAroundCap(
  priority: string, origin: unknown, feature: boolean, tags: readonly string[] = [],
): string {
  // mobile-charts is exempt: Nicholas ruled every mobile-charts card #high
  // (2026-10-02), and web-port-scout files ported fixes as #bug through
  // file-finding, which writes the play-around marker. Same exemption as
  // file-finding's own cap.
  const mobileCharts = tags.some(tag => tag.toLowerCase() === "#mobile-charts");
  return priority.toLowerCase() === "high" && origin === PLAY_AROUND_ORIGIN && !feature && !mobileCharts
    ? "medium"
    : priority;
}

/** Kept only so old board lines can be parsed and cleaned during re-render. */
export const LEGACY_TICK = "✓";

/**
 * Remove one or more legacy review-skip ticks immediately after a card ref.
 * Everything outside the bold card title is preserved byte-for-byte.
 */
export function stripReviewSkipMark(line: string): string {
  return line.replace(
    /^(\s*-\s*\[.\]\s*\*\*[TRFC]\d+\s*·\s*)(?:✓\s*)+(.*?\*\*.*)$/i,
    "$1$2",
  );
}

/** The `#om-bug-loop` tag was dropped at his request the same day. Nothing
 *  parsed it — `BOARD_CARD` keys on the `cards/<slug>` link — so the card's
 *  one tag is now its priority, which is the thing worth filtering a board by. */
/** The project tag. The board moved to the vault root because EVERY repo uses
 *  it, not just the OM Chat work — so a card has to say which project it
 *  belongs to, or the board stops being filterable the moment a second project
 *  files a task. (Nicholas, 2026-09-07.) Distinct from the retired
 *  `#om-bug-loop`, which named the pipeline rather than the project. */
export const PROJECT_TAGS: Record<string, string> = {
  chat: "openmarket",
  chart: "charts",
  /** OpenFloor, the mobile app (`openmarket-chat-app`). Added 2026-09-18 for the
   *  web-parity intake. It is a TAG, not a board column: mobile cards ride the
   *  same lanes as everything else and are found with `#mobile`. */
  mobile: "mobile",
  /** The OpenMarket mobile charts app (`kiyotaka-frontend-app`, Expo,
   *  `com.kiyotaka.frontendapp`). Added 2026-10-02 for the ⌗ mobile topic's
   *  to-dos (room 7950af2f4f4a, topic 86675ae4). Distinct from `mobile`,
   *  which is OpenFloor (`openmarket-chat-app`). */
  "mobile-charts": "mobile-charts",
};
export const DEFAULT_PRODUCT = "chat";
/** The board is ONE surface shared by several products, so the project tag has
 *  to say which — a chart card wearing the chat project's tag is invisible to
 *  the filter that would find it. (Nicholas, 2026-09-09.) An ABSENT product
 *  renders `#openmarket` on purpose: every task predating the product field is
 *  chat, which is the same rule tasks.json already documents. */
export const projectTag = (product?: string | null) =>
  PROJECT_TAGS[product ?? DEFAULT_PRODUCT] ?? PROJECT_TAGS[DEFAULT_PRODUCT]!;

/**
 * The longest title the board will render on a card line.
 *
 * Nicholas monitors this pipeline FROM THE BOARD, and an Obsidian Kanban lane
 * draws each card as a single bold line. A title carrying the whole finding —
 * the surface, the observed behaviour, the evidence paths, the reference, the
 * fix and its `alt:` — turns the lane into a wall of prose that cannot be
 * skimmed, and it does that while the `|details` note, which exists precisely
 * to hold that brief, sits empty. (Nicholas, 2026-09-14.)
 *
 * A title is a HANDLE, not the brief: <surface> + <symptom>, enough to pick
 * this card out of forty. Everything else belongs in `cards/<slug>.md`.
 *
 * 60 is one comfortable line in the Kanban lane at the widths Nicholas uses.
 * It is the single knob — raising it here raises it for every producer.
 */
export const TITLE_MAX = 60;

/** Why this title is unfit for a card line, or `null`. The callers that gate on
 *  it (`consume`, `file-finding`) refuse rather than truncating: a machine cut
 *  at 60 characters lands mid-word and loses the half that said what broke,
 *  whereas refusing hands the cut back to the LLM that is already holding the
 *  finding and can name it in four words. */
export function titleProblem(title: string): string | null {
  const n = title.trim().length;
  if (n <= TITLE_MAX) return null;
  return `title is ${n} characters, over the ${TITLE_MAX}-character cap:\n` +
    `  ${title.trim()}\n` +
    "A card title is a handle — <surface> + <symptom> — not the brief. Pass a" +
    " short one and put the rest in the card note (`cards/<slug>.md`), which is" +
    " what the `|details` link already points at.";
}

export const cardLine = (
  slug: string, title: string, board: string = DEFAULT_BOARD,
  priority: string = DEFAULT_PRIORITY, product?: string | null,
) => `- [ ] **${title}** [[${cardTarget(board, slug)}|details]] ` +
  `#${projectTag(product)} #${priority}`;

const PRIORITY_TAGS = new Set(["#low", "#medium", "#high"]);
const TAG_RE = /#[A-Za-z0-9_-]+/g;
const LINK_RE = /!?\[\[[^\]]+\]\]/g;

/** The first priority Nicholas put on a line, normalized for tasks.json. */
export function linePriority(line: string): string | null {
  const tag = (line.match(TAG_RE) ?? [])
    .find(candidate => PRIORITY_TAGS.has(candidate.toLowerCase()));
  return tag ? tag.slice(1).toLowerCase() : null;
}

/**
 * Re-render an EXISTING card line under a new title and priority, keeping
 * everything else on it.
 *
 * `cardLine` builds a line from nothing, so it can only emit the project and
 * priority tags. Using it to re-render a card that already exists therefore
 * DELETES whatever else was on that line — routing tags, and image embeds that
 * are often a bug's only evidence. Hit live on 2026-09-11: a `priority` change
 * wiped `#pa`, `#pa`, `#bug` and `![[Pasted image 20260907171814.png]]` off
 * four cards, and the vault is not a git repo, so there was no undo.
 *
 * `consume` has always preserved these; this is the same rule for every other
 * path that rewrites a live line.
 */
export function rerenderLine(
  existing: string, slug: string, title: string,
  board: string = DEFAULT_BOARD, priority: string = DEFAULT_PRIORITY,
  product?: string | null,
): string {
  const m = /^(\s*-\s*\[.\]\s*)(.*)$/.exec(existing);
  if (!m) return cardLine(slug, title, board, priority, product);
  const body = m[2]!;

  // The old priority tag is replaced, not kept; every other tag is the user's.
  const tags = (body.match(TAG_RE) ?? [])
    .filter(t => !PRIORITY_TAGS.has(t.toLowerCase()));
  // The `|details` link is regenerated from the slug. Everything else — image
  // embeds above all — belongs to whoever wrote the card.
  const links = (body.match(LINK_RE) ?? [])
    .filter(l => !(l.includes("cards/") && l.endsWith("|details]]")));

  const lower = tags.map(t => t.toLowerCase());
  const project = `#${projectTag(product)}`;
  const rendered = [...tags];
  if (!lower.includes(project.toLowerCase())) rendered.unshift(project);
  rendered.push(`#${priority}`);

  return `${m[1]}**${title}** [[${cardTarget(board, slug)}|details]] ` +
    [...rendered, ...links].join(" ");
}

/**
 * The title a board line carries, with tags, embeds, bold markers and any
 * pipeline ref prefix stripped.
 *
 * Shared by `consumeLine` and the `consume` CLI so that the text the CLI banks
 * into the card note is EXACTLY the text the card line would otherwise have
 * rendered. Two copies of this extraction would drift, and the drift would only
 * show up as a card note missing the half of the finding nobody noticed.
 *
 * `fromLinkIndex` is the index into the line's links of the one whose display
 * text became the title (a card that is nothing but a wikilink), or -1.
 */
export function readTitle(body: string): { title: string; fromLinkIndex: number } {
  const tags = body.match(TAG_RE) ?? [];
  const links = body.match(LINK_RE) ?? [];

  let title = body;
  for (const piece of [...tags, ...links]) title = title.replace(piece, " ");
  title = title.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  // `C` is another pipeline's namespace: not one we issue, but one that can
  // appear on a line handed to us, so it strips here too. Old lines may carry
  // one or more instances of the legacy review-skip tick after the ref.
  title = title.replace(/^[TRCF]\d+\s*·\s*(?:✓\s*)*/i, "");
  if (title) return { title, fromLinkIndex: -1 };

  const i = links.findIndex(l => !l.startsWith("!"));
  if (i < 0) return { title: "", fromLinkIndex: -1 };
  return {
    title: links[i]!.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|").pop()!.trim(),
    fromLinkIndex: i,
  };
}

/**
 * Rewrite ONE hand-written `todo` line into a pipeline card, in place.
 *
 * Everything Nicholas put on the line that is not the title survives: tags
 * (routing tags included — `#pa` on a consumed card records why it was taken),
 * image embeds and wikilinks. A pasted screenshot is evidence; dropping one is
 * a data loss, not a formatting nit.
 */
export function consumeLine(
  line: string, ref: string, slug: string,
  board: string = DEFAULT_BOARD, product?: string | null,
  titleOverride?: string,
  priority?: string,
): string {
  const m = /^(\s*-\s*\[.\]\s*)(.*)$/.exec(line);
  if (!m) throw new Error(`not a card line: ${JSON.stringify(line)}`);
  const body = m[2]!;

  const tags = body.match(TAG_RE) ?? [];
  const links = body.match(LINK_RE) ?? [];
  const existingPriority = linePriority(line);

  const read = readTitle(body);
  let title = read.title;

  const keptLinks = [...links];
  if (read.fromLinkIndex >= 0) {
    // The whole card was a wikilink. Its display text became the title, so drop
    // the link from the trailers rather than rendering it twice.
    keptLinks.splice(read.fromLinkIndex, 1);
  }
  if (!title) throw new Error(`card line has no readable title: ${JSON.stringify(line)}`);

  // An explicit short title REPLACES what the line said; the long original is
  // not discarded, it is the caller's job to have put it in the card note.
  if (titleOverride !== undefined && titleOverride.trim()) title = titleOverride.trim();

  const lower = tags.map(t => t.toLowerCase());
  const project = `#${projectTag(product)}`;
  const rendered = priority === undefined
    ? [...tags]
    : tags.filter(tag => !PRIORITY_TAGS.has(tag.toLowerCase()));
  if (!lower.includes(project.toLowerCase())) rendered.unshift(project);
  if (priority !== undefined) rendered.push(`#${priority}`);
  else if (existingPriority === null) rendered.push(`#${DEFAULT_PRIORITY}`);

  return `${m[1]}**${ref} · ${title}** [[${cardTarget(board, slug)}|details]] ` +
    [...rendered, ...keptLinks].join(" ");
}

/** Columns whose whole purpose is "Nicholas reads this and decides" — a card
 *  landing here without a readable note is a broken promise, not a formatting
 *  nit, so the tool refuses rather than trusting the playbook to be followed.
 *
 *  `in progress` inherited this gate from `todo review` when the approval stop
 *  was removed (2026-09-11). The card now enters `in progress` at the moment
 *  the digest is posted — so it is still the first column Nicholas reads a plan
 *  from, and it is still the only chance to catch a plan before code exists.
 *  Losing the gate with the lane would have re-opened the empty-card bug that
 *  has already shipped twice. */
export const NOTE_REQUIRED_COLUMNS = new Set(["in progress", "Review"]);

/** The body under one H2, including H3s, until the next H2 or EOF. */
export function noteSection(body: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingLine = new RegExp(`^##\\s+${escaped}\\s*$`, "i");
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(line => headingLine.test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/** Template prompts are instructions to the author, not reproducible steps. */
function hasNumberedStep(body: string): boolean {
  return body.split(/\r?\n/).some(line => {
    const text = /^\s*\d+[.)]\s+(\S.*)$/.exec(line)?.[1]?.trim();
    return !!text && !text.startsWith("<") && !/^(?:…|\.{3})+$/.test(text);
  });
}

/** Obsidian CREATES an empty note when someone clicks a link to a missing one,
 *  so "the file exists" proves nothing — it must have content. */
export function noteProblem(
  board: string, slug: string, column: string, ref?: string | null,
): string | null {
  if (!NOTE_REQUIRED_COLUMNS.has(column)) return null;
  const note = join(dirname(board), "cards", `${slug}.md`);
  if (!existsSync(note)) return `no card note at ${note}`;
  const body = readFileSync(note, "utf8");
  if (body.trim().length < 80) {
    return `card note is empty or a stub: ${note}` +
      " (Obsidian writes a 0-byte note when a dead link is clicked)";
  }
  // No image gate on the card note (Nicholas, 2026-09-22: "drop it in the card
  // notes, pictures should still exist in the MRs"). The before/after pictures
  // belong in the MR description, which is where the merge decision is made; a
  // card is an index. The 2026-09-02 rule that put them here is retired.

  // A fix cannot be independently judged when its card omits the route back to
  // the bug, or a built feature omits the route forward to its new surface.
  const lane = /^([a-z])\d+$/i.exec(ref?.trim() ?? "")?.[1]?.toUpperCase();
  if (lane === "T") {
    const section = noteSection(body, "Reproduction steps");
    if (section === null) {
      return `no "## Reproduction steps" section in ${note} — a bug card (T) must carry its repro:` +
        " numbered steps from a cold app (URL, viewport, starting state), ending with an" +
        " **Expected:** line and an **Actual:** line. Nobody can verify a fix for a bug" +
        " they cannot make happen.";
    }
    if (column === "Review" && !hasNumberedStep(section)) {
      return `"## Reproduction steps" in ${note} has no numbered steps — write them as` +
        ' "1. …", from a cold app, so someone who has not read the code can make the bug' +
        ' happen. Template placeholders ("<…>") do not count.';
    }
    if (column === "Review" && !section.includes("**Expected:**")) {
      return `"## Reproduction steps" in ${note} has no **Expected:** line — end the steps` +
        " with **Expected:** (what should happen) and **Actual:** (what happens instead).";
    }
  }
  if (lane === "F" && column === "Review") {
    const section = noteSection(body, "How to try it");
    if (section === null) {
      return `no "## How to try it" section in ${note} — a feature card (F) must say how to` +
        " play it: numbered steps from a cold app to the new surface, ending with a" +
        " **You should see:** line describing what proves it works. Write it from what you" +
        " actually drove, not from the plan.";
    }
    if (!hasNumberedStep(section)) {
      return `"## How to try it" in ${note} has no numbered steps — write them as "1. …",` +
        " from a cold app, so Nicholas can reach the feature without asking. Template" +
        ' placeholders ("<…>") do not count.';
    }
    if (!section.includes("**You should see:**")) {
      return `"## How to try it" in ${note} has no **You should see:** line — end the steps` +
        " with **You should see:** and what on screen proves the feature works.";
    }
  }
  return null;
}


// ------------------------------------------------------ the Feature Map
//
// §7 has always required a Feature Map entry at the review gate, and nothing
// enforced it: twelve shipped tasks produced one entry. Every other step of
// that gate leaves an artifact the tool can see, so this one gets the same
// treatment as the card note — refuse the move, name the fix.
//
// The path is the SYMLINK, never the vault directory behind it. The map has
// already moved twice in one day; resolving the link at use time means the
// board tooling does not have to be edited when it moves again.

export const FEATURE_MAP_DIRS: Record<string, string> = {
  chat: "/Users/nicholas/.claude/skills/om-bug-loop/references/features",
  chart: "/Users/nicholas/.claude/skills/om-bug-loop/references/features-charts",
  /** The mobile map is its own 128-entry tree, written 2026-09-18 — a mobile
   *  card judged against the chat map would be graded on a surface it does not
   *  have. Symlink, like `features`, so the vault stays the one home. */
  mobile: "/Users/nicholas/.claude/skills/om-bug-loop/references/features-mobile",
  /** kiyotaka-frontend-app's map, started 2026-10-02 (vault
   *  `openmarket-mobile-charts/Feature Map/`, symlinked like the others). */
  "mobile-charts": "/Users/nicholas/.claude/skills/om-bug-loop/references/features-mobile-charts",
};

/** The chat map, and the fallback. Retained under its old name because it is
 *  the default for every task that has no product — which is every task
 *  written before the lane existed. */
export const FEATURE_MAP_DIR = FEATURE_MAP_DIRS.chat!;

/** An unknown lane resolves to chat rather than throwing: a typo in a hand-
 *  edited `tasks.json` must fail the gate loudly against a REAL map, not
 *  crash the board tooling. */
export const featureMapDir = (product?: string | null): string => {
  const key = product ?? "chat";
  return Object.hasOwn(FEATURE_MAP_DIRS, key) ? FEATURE_MAP_DIRS[key]! : FEATURE_MAP_DIR;
};

/** The lane name when it is not one we know, else null. Render paths keep the
 *  soft fallback above — `list` and `stamp` run over every task and must never
 *  throw — but the GATE must name a bad lane instead of quietly judging a chart
 *  entry against the chat map. A silent fallback turns a typo into a wrong-map
 *  PASS: the agent is told its entry is not in the Feature Map, is shown the
 *  chat path, moves the entry there, and succeeds. */
export const unknownProduct = (product?: string | null): string | null => {
  const key = product ?? "chat";
  return Object.hasOwn(FEATURE_MAP_DIRS, key) ? null : key;
};

/** The escape hatch, mirroring "No UI surface": a fix that touches no
 *  user-reachable surface teaches the map nothing, and must SAY so. Unlike the
 *  image declaration this one lives in `tasks.json`, not in the note — the gate
 *  reads the task, and a bypass Nicholas cannot see in `list` is not a
 *  declaration, it is a habit. Written by `feature --none`, never inferred. */
export const NO_FEATURE_SURFACE = /^\s*No feature surface\b/i;

const expandHome = (p: string) =>
  p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;

/** realpath, or null when the path does not resolve — the map is reached
 *  through a symlink, so every comparison happens on resolved paths or it
 *  compares two spellings of the same directory and calls them different. */
function realOrNull(p: string): string | null {
  try { return realpathSync(resolve(expandHome(p))); } catch { return null; }
}

/** Recorded entries, tolerating both shapes: `feature` writes an array, and a
 *  hand-written single string must not silently read as nothing. */
export function featureMapEntries(task: TaskLike): string[] {
  const v = task.featureMap;
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v])
    .filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

/** The declaration, if one was made — rendered verbatim wherever the entry is
 *  shown, so the reason travels with the bypass. */
export const featureMapDeclaration = (task: TaskLike): string | undefined =>
  featureMapEntries(task).find(e => NO_FEATURE_SURFACE.test(e));

/**
 * Why one entry does not count, or null when it does.
 *
 * `sinceMs` NaN skips the staleness check — `feature` validates a path at
 * RECORDING time, when "was it touched for this task" is not yet answerable.
 */
function entryProblem(
  entry: string, root: { real: string | null; label: string },
  sinceMs: number, sinceLabel: string,
): string | null {
  const real = realOrNull(entry);
  if (!real) return "does not exist";
  // Both sides are realpath'd: the map is reached through a symlink, and an
  // entry named through the link must match the entry named through the vault.
  if (root.real && real !== root.real && !real.startsWith(root.real + sep)) {
    return `is not in the Feature Map (${root.label})`;
  }
  const stat = statSync(real);
  if (!stat.isFile()) return "is a directory, not an entry";
  if (readFileSync(real, "utf8").trim().length < 80) {
    return "is empty or a stub — an entry needs the four H2 sections";
  }
  // The failure this gate exists to catch: a real, good entry that some EARLIER
  // task wrote, named by a task that never touched it. An entry written for
  // this task cannot predate the work.
  if (Number.isFinite(sinceMs) && stat.mtimeMs < sinceMs) {
    return `was last modified ${localStamp(new Date(stat.mtimeMs).toISOString())}, ` +
      `before this task reached ${sinceLabel} (${localStamp(new Date(sinceMs).toISOString())})` +
      " — inherited from an earlier task, not written for this one";
  }
  return null;
}

/**
 * Whether the task may enter `Review`, Feature-Map-wise.
 *
 * One good entry is enough (a fix can touch two surfaces and only teach the map
 * about one), but the entries that failed are all reported: a reviewer that
 * recorded the wrong path needs to see which one and why.
 *
 * A task with no `implementing` stamp falls back to the earliest stamp it has.
 * That is weaker, but it still catches the real failure — an entry written
 * before this task existed at all.
 */
export function featureMapProblem(
  task: TaskLike, featuresRoot: string = featureMapDir(task.product),
): string | null {
  const badLane = unknownProduct(task.product);
  if (badLane) {
    return `this task's product is \`${badLane}\`, which is not a known lane` +
      ` (${Object.keys(FEATURE_MAP_DIRS).join(" | ")}). Fix \`product\` in` +
      " tasks.json before recording a Feature Map entry — otherwise the entry" +
      " is judged against the wrong product's map.";
  }
  const how =
    `record it with: kanban.ts feature ${task.ref ?? task.slug} --file <path>` +
    ` (an entry under ${featuresRoot}, with its four H2 sections).\n` +
    "If the fix genuinely touches no user-reachable surface, declare that" +
    ` instead: kanban.ts feature ${task.ref ?? task.slug} --none "<why>".`;

  const entries = featureMapEntries(task);
  if (entries.length === 0) {
    return "no Feature Map entry recorded — every shipped task teaches the map" +
      ` something about the surface it touched.\n${how}`;
  }
  if (featureMapDeclaration(task)) return null;

  const stages = task.stages ?? {};
  const [sinceLabel, since] =
    (["implementing", "investigating", "detected"] as const)
      .map(s => [s, stages[s]] as const).find(([, v]) => v) ??
    ["detection", task.seenAt ?? undefined] as const;
  const sinceMs = since ? new Date(since).getTime() : NaN;

  const root = { real: realOrNull(featuresRoot), label: featuresRoot };
  const why: string[] = [];
  for (const entry of entries) {
    const problem = entryProblem(entry, root, sinceMs, sinceLabel);
    if (!problem) return null;
    why.push(`  ${entry} — ${problem}`);
  }
  return `the recorded Feature Map entry does not hold up:\n${why.join("\n")}\n${how}`;
}

/** A card owned by this pipeline, matched by its wikilink — never by title.
 *  Tolerates any leading folder path so a board written before the
 *  vault-relative fix still matches its own cards. */
const cardMatcher = (slug: string) =>
  new RegExp(String.raw`^- \[.\] .*\[\[(?:[^\]|]*/)?cards/${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\|`);

/** Tags on the card's current board line, or none when it is not on the board. */
function boardCardTags(board: string, slug: string): string[] {
  if (!existsSync(board)) return [];
  const matcher = cardMatcher(slug);
  const line = readFileSync(board, "utf8").split("\n").find(candidate => matcher.test(candidate));
  return line?.match(TAG_RE) ?? [];
}

/**
 * Pure transform: move (or create) `slug`'s card into `column`.
 * Unrelated lines are preserved exactly. Idempotent.
 */
export function moveCard(
  markdown: string, slug: string, column: string, title?: string,
  board: string = DEFAULT_BOARD, priority: string = DEFAULT_PRIORITY,
  product?: string | null,
): string {
  const lines = markdown.split("\n");
  const matcher = cardMatcher(slug);

  // Lift the existing card out, remembering its text (a move keeps it).
  let existing: string | undefined;
  const kept: string[] = [];
  for (const line of lines) {
    if (existing === undefined && matcher.test(line)) { existing = line; continue; }
    kept.push(line);
  }

  // A retitle of a card that already exists must preserve that card's own tags
  // and embeds; only a card being created from nothing goes through cardLine.
  const text = title !== undefined
    ? (existing !== undefined
      ? rerenderLine(existing, slug, title, board, priority, product)
      : cardLine(slug, title, board, priority, product))
    : existing ?? cardLine(slug, slug, board, priority, product);

  return insertIntoColumn(kept, column, stripReviewSkipMark(text)).join("\n");
}

/**
 * The card note a finding is filed WITH, so that the brief exists before the
 * card does.
 *
 * A raw `todo` line used to be the entire brief, which is why titles grew into
 * paragraphs: there was nowhere else for the finding to go until the owner
 * wrote a note hours later. This is that other place. `## Problem` is the same
 * heading `templates/card-note-template.md` uses, so the owner ADDS to this
 * note (Solution direction, Work items) instead of replacing it — and nothing
 * the reporter observed is lost on the way.
 *
 * Prose goes out ONE PARAGRAPH PER LINE: Obsidian renders a single newline as a
 * real line break, so a hard-wrapped paragraph shows up chopped.
 */
/**
 * Every `##` heading `templates/card-note-template.md` defines.
 *
 * A filed finding must use only these. `note` REFUSES a replacement that drops
 * a section the card already has — the guard that saved T29 — so a heading a
 * reporter invents becomes a wall the owner hits hours later, with the finding
 * stranded on the wrong side of it. Refusing at filing time costs the reporter
 * one rename; refusing at hand-off time costs an owner's whole run.
 */
export const CARD_NOTE_SECTIONS = [
  "Problem", "Evidence", "Reproduction steps", "How to try it", "Solution direction",
  "Work items", "Findings", "Open questions",
];

/** Which of `body`'s `##` headings the card note template does not have. */
export function strayHeadings(body: string): string[] {
  const known = new Set(CARD_NOTE_SECTIONS.map(h => h.toLowerCase()));
  return (body.match(/^##\s+(.+?)\s*$/gm) ?? [])
    .map(h => h.replace(/^##\s+/, "").trim())
    .filter(h => !known.has(h.toLowerCase()));
}

export function filedFindingNote(title: string, body: string): string {
  const t = body.trim();
  // `# ` with the space, not any `#`: a body that opens on `## Problem` — which
  // is exactly the shape a reporter is told to write — carries no title of its
  // own, and a bare `#` test silently left those notes headless.
  if (/^#\s/.test(t)) return `${t}\n`;
  const head = `# ${title.trim()}\n\n`;
  // A body that already has its own `##` sections gets the title in front of
  // them; only a bare paragraph needs `## Problem` put around it.
  return /^##\s/m.test(t) ? `${head}${t}\n` : `${head}## Problem\n\n${t}\n`;
}

/**
 * Splice `text` in as the last card of `column`, before the blank lines that
 * separate columns. Pure; `lines` is not mutated.
 *
 * Shared by `moveCard` (which writes a pipeline card) and `file-finding` (which
 * writes a RAW, unclaimed one). They must land in the same place for the same
 * reason — ordering on the board is how Nicholas reads arrival order.
 */
export function insertIntoColumn(lines: string[], column: string, text: string): string[] {
  const kept = [...lines];
  const headingIdx = kept.findIndex(l => l.trim() === `## ${column}`);
  if (headingIdx < 0) throw new Error(`column not found in board: ${column}`);
  let end = kept.length;
  for (let i = headingIdx + 1; i < kept.length; i++) {
    if (/^## /.test(kept[i]!) || /^%% kanban:settings/.test(kept[i]!)) { end = i; break; }
  }
  let insertAt = headingIdx + 1;
  for (let i = headingIdx + 1; i < end; i++) if (kept[i]!.trim() !== "") insertAt = i + 1;
  kept.splice(insertAt, 0, text);
  return kept;
}

/** Slug for a backlog title: the same shape §3 gives a to-do, so a promoted
 *  backlog card keeps the name it was captured under and its note, evidence
 *  and card line all stay addressed by one string. */
export function slugify(title: string, words = 5): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    .split(/\s+/).slice(0, words).join("-") || "untitled";
}

/** The body of a backlog card note.
 *
 *  A backlog item is a CARD, not a line: it carries a ref, a `tasks.json`
 *  entry and a note with real content, because a bare title is unreadable six
 *  weeks later and the whole point of a backlog is that it outlives the
 *  conversation that produced it.
 *
 *  The ref matters more than it looks. `nextRef` derives the next number from
 *  `tasks.json` alone, so a ref written onto the board WITHOUT an entry would
 *  be handed out again to a real task later and two cards would silently share
 *  it. Capture therefore writes the entry, or it writes no ref at all.
 */
export function backlogNote(title: string, body?: string): string {
  if (body && body.trim()) {
    const t = body.trim();
    return t.startsWith("#") ? `${t}\n` : `# ${title}\n\n${t}\n`;
  }
  return [
    `# ${title}`, "",
    "## What this is", "",
    "<!-- the problem or the opportunity, in plain words — a sentence someone",
    "     could act on six weeks from now without this conversation. -->", "",
    "## Why it matters", "",
    "<!-- what goes wrong if nobody does this. If the honest answer is \"not",
    "     much\", say so: that may mean deleting the card. -->", "",
    "## Where to look", "",
    "<!-- files, symbols, repos, a to-do seq, a PR — whatever saves the next",
    "     reader the rediscovery. Vault-relative full paths for any [[link]]. -->", "",
    "## What \"done\" looks like", "",
    "<!-- the observable end state, so whoever picks this up knows to stop. -->", "",
    "## Notes", "", "-", "",
  ].join("\n");
}

// ------------------------------------------------- the live card note
//
// A note written once is a note that lies. Nicholas monitors a task from the
// board, so "when did this start / how long has it taken / what is left" has to
// be true whenever he looks — which means it is MACHINE-owned end to end:
// `tasks.json` records the stage stamps, `stamp` re-renders them into the note,
// and `upsert` does both on every transition so no agent can forget to.
//
// The note is co-owned: everything between the markers belongs to this tool and
// is regenerated wholesale; everything outside belongs to the agents and must
// survive byte-for-byte.

export const MARK_START = "<!-- om-bug-loop:status -->";
export const MARK_END = "<!-- /om-bug-loop:status -->";

/** Pipeline order. The checklist renders in exactly this order, and a stage's
 *  end is the next RECORDED stage's start — so the order is load-bearing. */
export const STAGES = [
  "detected", "investigating", "planned", "implementing", "reviewing", "shipped",
] as const;
export type Stage = (typeof STAGES)[number];

/** Stage and status names that existed before the plan-approval stop was
 *  removed (2026-09-11). 68 live tasks in `tasks.json` carry stamps and a
 *  status under the old name, and a stamp is the ONLY record of when that task
 *  reached the plan — append-only means we may rename the vocabulary but may
 *  never drop the history. Reads normalize; the next write migrates the entry.
 *  Delete this map only once no task in `tasks.json` still uses the old key. */
export const STAGE_ALIASES: Record<string, Stage> = { "awaiting-approval": "planned" };

/**
 * Statuses that mean the task is OVER, for tasks whose ending is not a stage.
 *
 * `STAGES` describes one shape of work: it ends at `shipped`, because a diff
 * landed. Two lanes never reach that stage and are finished anyway — research
 * files a doc, and a play-around sweep files cards — so their terminal status
 * has no stage to stamp, and `stage` (which takes a Stage) cannot set it. The
 * result until 2026-09-11 was that both had to be written into `tasks.json` by
 * hand, and until someone did, `task-watch` kept reporting finished work as
 * live with a false "no-artifacts-yet" warning.
 *
 * `swept` is deliberately distinct from `shipped` rather than folded into it:
 * `shipped` has to keep meaning "a diff landed", or every count of what the
 * pipeline actually delivered quietly inflates.
 */
export const TERMINAL_STATUSES = [
  "shipped", "researched", "swept", "withdrawn", "skipped", "failed",
] as const;

/** Apply {@link STAGE_ALIASES} to one task's stamps and status. A real stamp
 *  under the current name always wins over an aliased one, so re-running this
 *  is safe and can never move a recorded time. */
export function normalizeTask<T extends TaskLike>(task: T): T {
  const stages = task.stages;
  const status = task.status;
  const aliased = stages && Object.keys(stages).some(k => k in STAGE_ALIASES);
  if (!aliased && !(status && status in STAGE_ALIASES)) return task;

  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(stages ?? {})) {
    const name = STAGE_ALIASES[k] ?? k;
    if (!next[name]) next[name] = v;
  }
  return {
    ...task,
    ...(aliased ? { stages: next } : {}),
    ...(status && status in STAGE_ALIASES ? { status: STAGE_ALIASES[status] } : {}),
  };
}

/** Past tense for a finished stage; the bare stage name reads better while it
 *  is still running ("- [ ] implementing — started 14:47"). */
const DONE_LABEL: Record<Stage, string> = {
  detected: "detected", investigating: "investigated", planned: "planned",
  implementing: "implemented", reviewing: "reviewed", shipped: "shipped",
};

/** `status` in tasks.json calls the first stage `new`; everything else matches
 *  the stage name, which is what keeps status and timeline from drifting. */
const STATUS_OF = Object.fromEntries(
  STAGES.map(s => [s, s === "detected" ? "new" : s]),
) as Record<Stage, string>;

/** Which stage a board column proves has been reached. `Need Attention` and
 *  `Done` prove nothing about pipeline progress, so they record nothing. */
export const COLUMN_STAGE: Record<string, Stage> = {
  "todo": "detected",
  "in progress": "planned",
  "Review": "shipped",
};

export interface TaskLike {
  id?: number | null;
  slug: string;
  /** `T1`, `T2`, … — the handle Nicholas actually types. Optional: entries
   *  created before refs existed have none, and must still render. */
  ref?: string | null;
  status?: string | null;
  /** `low` | `medium` | `high`. Absent means `low` — see DEFAULT_PRIORITY. */
  priority?: string | null;
  /** Explicit filing source, copied from a machine-owned card-note marker. */
  origin?: string | null;
  /** Nicholas's review-budget category and compact grouped-card summary. */
  category?: CardCategoryKey | string | null;
  summary?: CardSummary | unknown;
  /** Explicit reason this otherwise-groupable card needs individual attention. */
  groupExempt?: string | null;
  /** Group membership plus the exact board line parked while grouped. */
  groupedIn?: string | null;
  groupedLine?: string | null;
  /** Train surface key, written by `train.ts ship` beside `mrUrl`. */
  train?: string | null;
  /** The exact board line parked while the member is folded into its train
   *  card; `upsert` puts it back before moving the member anywhere else. */
  trainLine?: string | null;
  /** Board title retained while the member has no individual board line. */
  title?: string | null;
  /** `chat` | `chart` — which product lane this task runs in, and therefore
   *  which repos, which environment reference and which Feature Map apply.
   *  Absent means `chat`: every entry predating multi-product is an OM Chat
   *  task, and the header omits the field rather than asserting a lane. */
  product?: string | null;
  repo?: string | null;
  branch?: string | null;
  mrUrl?: string | null;
  seenAt?: string | null;
  stages?: Record<string, string>;
  /** Feature Map file(s) this task created or updated — the artifact the §7
   *  review gate checks. Either paths, or the single `No feature surface — …`
   *  declaration that stands in for them. */
  featureMap?: string | string[] | null;
  /** How much pipeline the task buys — `trivial` | `normal` | `hard`, decided
   *  by `tier()` in routing.ts at consume. Absent means `normal`: every entry
   *  predating tiers (2026-09-24) was dispatched before the distinction existed. */
  tier?: string | null;
  tierSource?: "tag" | "judged" | "default" | null;
  /** Append-only record of every up-move, so the coordinator's first guesses
   *  can be graded against what the owners found. */
  tierEscalations?: { from: string; to: string; at: string; why: string }[];
  [k: string]: unknown;
}

export const cardNotePath = (board: string, slug: string) =>
  join(dirname(board), "cards", `${slug}.md`);

const p2 = (n: number) => String(n).padStart(2, "0");

/** `1h 04m` / `16m` / `45s` — readable at a glance, and never negative: a clock
 *  that went backwards is a bug in the clock, not something to render. */
export function humanDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${p2(min % 60)}m`;
  return `${Math.floor(hr / 24)}d ${p2(hr % 24)}h`;
}

const localDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
const localHM = (iso: string) => {
  const d = new Date(iso);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
const localStamp = (iso: string) => `${localDate(iso)} ${localHM(iso)}`;
/** Timeline entries are bare `HH:MM` — but a task that ran past midnight would
 *  read as time travel, so those carry the date too. */
const stageTime = (iso: string, base: string | undefined) =>
  base && localDate(iso) !== localDate(base)
    ? `${localDate(iso).slice(5)} ${localHM(iso)}`
    : localHM(iso);

const ms = (iso: string) => new Date(iso).getTime();

/** `**Feature Map** foo.md, bar.md` — basenames, because the directory is the
 *  same for every entry and the header is already long. A declaration renders
 *  verbatim, reason and all. */
function featureMapLabel(task: TaskLike): string | null {
  const declared = featureMapDeclaration(task);
  if (declared) return `**Feature Map** ${declared.trim()}`;
  const entries = featureMapEntries(task);
  return entries.length
    ? `**Feature Map** ${entries.map(e => basename(e)).join(", ")}`
    : null;
}

/**
 * Render the machine-owned block, markers included.
 *
 * `now` is a parameter, never `Date.now()`, so the renderer is a pure function
 * of (task, clock) — testable, and reproducible when a stamp is replayed.
 */
export function statusBlock(task: TaskLike, now: string): string {
  const stages = task.stages ?? {};
  const detected = stages.detected ?? task.seenAt ?? undefined;
  const shipped = stages.shipped;

  // A backlog card has not started, so the pipeline checklist and the elapsed
  // clock would both LIE about it: six unchecked stages read as "in flight at
  // stage zero", and an elapsed that grows for six weeks reads as an overrun
  // rather than as a thing nobody has picked up. It gets a captured date and
  // nothing else. This is the same rule as the rest of the block — the region
  // is machine-owned precisely so it is never wrong.
  if (task.status === "backlog") {
    const head = [
      task.ref ? `**${task.ref}**` : null,
      "**Status** backlog",
      `**Priority** ${task.priority ?? DEFAULT_PRIORITY}`,
      task.product ? `**Product** ${task.product}` : null,
      task.repo ? `**Repo** ${task.repo}` : null,
    ].filter(Boolean).join(" · ");
    const when = detected ? `\n\n**Captured** ${localStamp(detected)}` : "";
    return `${MARK_START}\n${head}${when}\n${MARK_END}`;
  }

  const head = [
    // The ref leads: it is the handle Nicholas answers with ("ok T5"), so it
    // must be the first thing read, not hunted for after the status.
    task.ref ? `**${task.ref}**` : null,
    task.status ? `**Status** ${task.status}` : null,
    `**Priority** ${task.priority ?? DEFAULT_PRIORITY}`,
    task.id != null ? `**To-do** ${task.id}` : null,
    task.product ? `**Product** ${task.product}` : null,
    task.repo ? `**Repo** ${task.repo}` : null,
    task.branch ? `**Branch** ${task.branch}` : null,
    task.mrUrl ? `**MR** ${task.mrUrl}` : null,
    // The board is the only place Nicholas looks, so the Feature Map entry —
    // and especially the declaration that stands in for one — is rendered here
    // rather than living only in tasks.json where a waiver becomes a habit.
    featureMapLabel(task),
  ].filter(Boolean).join(" · ");

  // Elapsed runs to the terminal stamp once the task is over, so a finished
  // card stops growing a bigger number every time anything re-stamps it. A
  // withdrawn or failed task is just as over as a shipped one — it stops at
  // the last stage it actually reached, not at "now, forever".
  const TERMINAL = new Set<string>(TERMINAL_STATUSES);
  const lastStamp = STAGES.map(s => stages[s]).filter(Boolean).pop();
  const end = shipped ?? (task.status && TERMINAL.has(task.status) ? (lastStamp ?? now) : now);
  const timing = [
    detected ? `**Detected** ${localStamp(detected)}` : null,
    stages.investigating ? `**Started** ${localStamp(stages.investigating)}` : null,
    detected ? `**Elapsed** ${humanDuration(ms(end) - ms(detected))}` : null,
  ].filter(Boolean).join(" · ");

  const recorded = STAGES.filter(s => stages[s]);
  const lines = STAGES.map(stage => {
    const at = stages[stage];
    if (!at) return `- [ ] ${stage}`;
    const next = recorded.find(s => STAGES.indexOf(s) > STAGES.indexOf(stage));
    if (next) {
      const to = stages[next]!;
      return `- [x] ${DONE_LABEL[stage]} — ${stageTime(at, detected)} → ` +
        `${stageTime(to, detected)} (${humanDuration(ms(to) - ms(at))})`;
    }
    // The last recorded stage: a terminal one is done, anything else is running.
    return stage === "shipped"
      ? `- [x] ${DONE_LABEL[stage]} — ${stageTime(at, detected)}`
      : `- [ ] ${stage} — started ${stageTime(at, detected)} (in progress)`;
  });

  return [MARK_START, head, "", timing, "", ...lines, "", MARK_END]
    .filter(l => l !== null).join("\n");
}

/**
 * Splice the block into a note, replacing only what lies between the markers.
 *
 * The H1 stays first: the title is what Obsidian shows in the card hover and
 * the graph, and a note whose first line is an HTML comment reads as broken.
 */
export function stampNote(note: string, block: string): string {
  const i = note.indexOf(MARK_START);
  const j = note.indexOf(MARK_END);
  if (i >= 0 && j > i) {
    return note.slice(0, i) + block + note.slice(j + MARK_END.length);
  }
  const lines = note.split("\n");
  const h1 = lines.findIndex(l => /^#\s/.test(l));
  if (h1 < 0) return `${block}\n\n${note}`;
  const insert = lines[h1 + 1] === "" ? ["", block] : ["", block, ""];
  lines.splice(h1 + 1, 0, ...insert);
  return lines.join("\n");
}

/**
 * Tick (or untick) one box in the agent-owned `## Work items` section.
 *
 * Matched by substring rather than index, because the task owner is reading the
 * approved plan, not counting lines — and a wrong guess must FAIL loudly rather
 * than tick a neighbouring item, which would silently misreport progress.
 */
export function checkItem(note: string, needle: string, done: boolean): string {
  const lines = note.split("\n");
  const start = lines.findIndex(l => /^##\s+Work items\s*$/.test(l));
  if (start < 0) throw new Error('this note has no "## Work items" section to tick');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) { end = i; break; }
  }

  const box = /^\s*- \[[ xX]\]\s+(.*)$/;
  const items: Array<{ i: number; text: string }> = [];
  for (let i = start + 1; i < end; i++) {
    const m = box.exec(lines[i]!);
    if (m) items.push({ i, text: m[1]! });
  }
  const list = (xs: typeof items) => xs.map(x => `  - ${x.text}`).join("\n");

  const hit = items.filter(x => x.text.toLowerCase().includes(needle.toLowerCase()));
  if (hit.length === 0) {
    throw new Error(`no work item matches ${JSON.stringify(needle)}. Work items:\n${list(items)}`);
  }
  if (hit.length > 1) {
    throw new Error(
      `ambiguous: ${JSON.stringify(needle)} matches ${hit.length} work items:\n${list(hit)}`);
  }
  const idx = hit[0]!.i;
  // Rewrite ONLY the checkbox character, so spacing and text survive exactly.
  lines[idx] = lines[idx]!.replace(/^(\s*- \[)[ xX](\])/, `$1${done ? "x" : " "}$2`);
  return lines.join("\n");
}

/**
 * Append-only stage recording.
 *
 * A re-run must never rewrite when work actually began — that is the whole
 * point of keeping timing in a file instead of in an agent's head. Status moves
 * FORWARD only, so replaying an earlier column cannot regress a live task.
 * An unknown slug is left alone: the coordinator creates task entries, this
 * never invents one.
 */
export function recordStage<T extends Record<string, TaskLike>>(
  tasks: T, slug: string, stage: Stage, now: string,
): T {
  const cur = tasks[slug];
  if (!cur) return tasks;
  const stages = { ...(cur.stages ?? {}) };
  if (!stages[stage]) stages[stage] = now;

  const curIdx = STAGES.findIndex(s => STATUS_OF[s] === cur.status);
  const status = curIdx >= 0 && STAGES.indexOf(stage) > curIdx
    ? STATUS_OF[stage] : cur.status;
  return { ...tasks, [slug]: { ...cur, status, stages } };
}

// ------------------------------------------------------------------- CLI

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Which ref namespace this invocation is issuing into. A boolean flag rather
 *  than `--prefix R` on purpose: the caller is choosing a KIND of work, not a
 *  letter, and "research" is the word the coordinator already routes on. */
function refPrefixFlag(): RefPrefix {
  if (process.argv.includes("--research")) return "R";
  if (process.argv.includes("--feature")) return "F";
  return "T";
}

/** Every occurrence, for a flag that legitimately repeats: one fix can teach
 *  the map about two surfaces. */
function argValues(flag: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === flag && process.argv[i + 1] !== undefined) out.push(process.argv[i + 1]!);
  });
  return out;
}

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

export const DEFAULT_TASKS = "/Users/nicholas/.claude/om-bug-loop/tasks.json";

const readTasks = (path: string): Record<string, TaskLike> => {
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, TaskLike>;
  // Normalize HERE, at the single load boundary, rather than at each of the
  // dozen call sites — a missed site would silently stop advancing status for
  // every pre-rename task, because STATUS_OF would not recognize its status.
  return Object.fromEntries(
    Object.entries(raw).map(([slug, task]) => [slug, normalizeTask(task)]),
  );
};

// ------------------------------------------------------------ short refs
//
// Nicholas approves by saying "ok T5", never by typing a slug. A ref is a
// permanent handle assigned in detection order and NEVER reused — a recycled
// number would silently re-point an approval he already gave to a different
// task — so every ref-aware helper here reasons about the maximum ever issued,
// never about how many tasks currently exist.

// One counter per lane, not one counter. `T5` is a defect, `R5` a research
// question, `F5` a feature — answered by different agents, proved differently,
// and ending in different places: a bug and a feature both reach a merged MR
// but only one of them has a root cause, and research ends in a filed doc and
// a decision Nicholas makes. Sharing one counter would make the number stop
// meaning anything: "T31" would tell you when the card was captured and
// nothing about what it is. Per-prefix counters keep the letter load-bearing,
// and cost only that every helper below reasons about (prefix, number) rather
// than number alone.
export const REF_PREFIXES = ["T", "R", "F"] as const;
export type RefPrefix = (typeof REF_PREFIXES)[number];
export const REF_PATTERN = /^([trf])(\d+)$/i;

/** The namespace a ref belongs to, normalized to upper case, or null when the
 *  input is not ref-shaped at all. */
const refPrefix = (ref: string): RefPrefix | null => {
  const hit = REF_PATTERN.exec(ref)?.[1];
  return hit ? (hit.toUpperCase() as RefPrefix) : null;
};
const refNum = (ref: string) => Number(REF_PATTERN.exec(ref)?.[2] ?? NaN);

/** Sort key for a mixed board: namespace first, then number. `T10` still sorts
 *  after `T9`, and the R block stays contiguous instead of interleaving with
 *  the T block — the board is read a namespace at a time, never as one run. */
export const refSortKey = (ref: string): number => {
  const prefix = refPrefix(ref);
  if (!prefix) return Number.POSITIVE_INFINITY;
  return REF_PREFIXES.indexOf(prefix) * 1e9 + refNum(ref);
};

export interface RefEntry { ref: string; slug: string; title: string }

/** A card as the BOARD sees it — the board is the authority on which column a
 *  task is in and on its display title (`T<n> · <title>`). */
export interface BoardCard { slug: string; column: string; title: string }

const BOARD_CARD =
  /^- \[.\] \*\*(.+?)\*\* \[\[(?:[^\]|]*\/)?cards\/([^\]|]+)\|/;

/** The ref rendered on this slug's board line when no ledger entry exists. */
export function boardCardRef(board: string, slug: string): string | null {
  if (!existsSync(board)) return null;
  for (const line of readFileSync(board, "utf8").split("\n")) {
    const card = BOARD_CARD.exec(line);
    if (card?.[2] !== slug) continue;
    const hit = /^([a-z]\d+)\s*·/i.exec(card[1]!);
    return hit ? `${hit[1]![0]!.toUpperCase()}${hit[1]!.slice(1)}` : null;
  }
  return null;
}
/** Card titles carry their ref, but the ref is rendered as its own field
 *  everywhere else, so strip it rather than printing it twice. Also strips
 *  any legacy review-skip tick left immediately after that ref. */
/** Every prefix `nextRef` can issue has to appear here, or that namespace's
 *  ref stays welded into its own title: `list` prints it twice, and any
 *  re-render writes `F1 · F1 · …` back to the board. A T-only pattern did this
 *  to `R` cards; adding `F` (2026-09-11) caught it a second time. */
const stripRefPrefix = (title: string) =>
  title.replace(new RegExp(
    `^[${REF_PREFIXES.join("")}]\\d+\\s*·\\s*(?:${LEGACY_TICK}\\s*)*`, "i"), "");

export function readBoardCards(board: string): Map<string, BoardCard> {
  const out = new Map<string, BoardCard>();
  if (!existsSync(board)) return out;
  let column = "";
  for (const line of readFileSync(board, "utf8").split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) { column = heading[1]!; continue; }
    const card = BOARD_CARD.exec(line);
    if (card) {
      out.set(card[2]!, { slug: card[2]!, column, title: stripRefPrefix(card[1]!) });
    }
  }
  return out;
}

export function groupNote(
  lane: GroupLane, category: CardCategoryKey, members: TaskLike[], board: string,
): string {
  const found = categoryFor(category)!;
  const id = groupId(lane, category);
  const sorted = [...members].sort((a, b) =>
    refSortKey(String(a.ref ?? "")) - refSortKey(String(b.ref ?? "")) ||
    String(a.slug).localeCompare(String(b.slug)));
  const lines = [
    `# ${lane} · ${found.label} (${sorted.length})`, "",
    `<!-- om-bug-loop:group ${id} — written by kanban.ts from tasks.json; edit a member with \`kanban.ts categorize\`, never this file -->`,
    "",
    `Grouped: category ${found.n}, **${found.label}** — low-risk in Nicholas's review budget. ` +
      "Each member keeps its own full note (linked). Why grouped, and the exceptions: " +
      "[[kanban/references/card-categories|card categories]].",
  ];
  if (sorted.length === 0) return [...lines, "", "This group is empty.", ""].join("\n");

  for (const member of sorted) {
    const ref = String(member.ref ?? "-");
    const title = String(member.title ?? member.slug).replace(/^(?:✓\s*)+/, "");
    const summary = member.summary as CardSummary;
    const suffix = lane === "Review" && typeof member.mrUrl === "string" && member.mrUrl.trim()
      ? `${member.mrUrl.includes("/-/merge_requests/") ? "MR" : "PR"} ${member.mrUrl.trim()}` : "";
    lines.push(
      "", `## ${ref} · ${title}`, "",
      `[[${cardTarget(board, member.slug)}|full note]]${suffix ? ` · ${suffix}` : ""}`,
      "", `**Problem.** ${summary.problem.trim()}`, "",
      `${lane === "todo" ? "**Solution direction.**" : "**Solution.**"} ${summary.solution.trim()}`,
      "", "**Repro.**",
      ...summary.repro.map((step, i) => `${i + 1}. ${step.trim()}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Pure board/group-note rendering from the membership recorded in tasks.json. */
export function renderGroups(
  markdown: string, tasks: Record<string, TaskLike>, board: string,
): { markdown: string; notes: Record<string, string> } {
  const members = new Map<string, TaskLike[]>();
  for (const [slug, entry] of Object.entries(tasks)) {
    const parsed = typeof entry.groupedIn === "string" ? parseGroupId(entry.groupedIn) : null;
    if (!parsed) continue;
    const id = groupId(parsed.lane, parsed.category);
    const list = members.get(id) ?? [];
    list.push({ ...entry, slug: entry.slug ?? slug });
    members.set(id, list);
  }

  const found = new Set<string>();
  const kept = new Set<string>();
  let column = "";
  const lines: string[] = [];
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) column = heading[1]!;
    const card = BOARD_CARD.exec(line);
    const parsed = card ? parseGroupId(card[2]!) : null;
    if (!parsed) { lines.push(line); continue; }

    const id = card![2]!;
    found.add(id);
    const groupMembers = members.get(id) ?? [];
    if (groupMembers.length && column === parsed.lane && !kept.has(id)) {
      lines.push(groupLine(board, parsed.lane, parsed.category, groupMembers.length));
      kept.add(id);
    }
    // Empty, duplicate, or misplaced group line: omit it. Non-group lines are
    // never handled by this branch and therefore survive byte-for-byte.
  }

  let rendered = lines;
  for (const [id, groupMembers] of [...members.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (kept.has(id)) continue;
    const parsed = parseGroupId(id)!;
    rendered = insertIntoColumn(
      rendered, parsed.lane, groupLine(board, parsed.lane, parsed.category, groupMembers.length));
  }

  const notes: Record<string, string> = {};
  for (const id of new Set([...found, ...members.keys()])) {
    const parsed = parseGroupId(id)!;
    notes[cardNotePath(board, id)] = groupNote(
      parsed.lane, parsed.category, members.get(id) ?? [], board);
  }
  return { markdown: rendered.join("\n"), notes };
}

export function syncGroups(board: string, tasksPath: string): void {
  if (!existsSync(board)) return;
  const tasks = existsSync(tasksPath)
    ? JSON.parse(readFileSync(tasksPath, "utf8")) as Record<string, TaskLike>
    : {};
  const before = readFileSync(board, "utf8");
  const rendered = renderGroups(before, tasks, board);
  if (rendered.markdown !== before) atomicWrite(board, rendered.markdown);
  for (const [path, body] of Object.entries(rendered.notes)) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== body) atomicWrite(path, body);
  }
}

/** Restore a grouped member's parked line and clear only grouping-owned keys. */
function ungroupMember(board: string, tasksPath: string, slug: string): boolean {
  if (!existsSync(tasksPath)) return false;
  const raw = JSON.parse(readFileSync(tasksPath, "utf8")) as Record<string, TaskLike>;
  const entry = raw[slug];
  const parsed = entry?.groupedIn ? parseGroupId(entry.groupedIn) : null;
  if (!entry || !parsed) return false;
  if (typeof entry.groupedLine === "string" && existsSync(board)) {
    const restored = stripReviewSkipMark(entry.groupedLine);
    const before = readFileSync(board, "utf8");
    if (!readBoardCards(board).has(slug)) {
      atomicWrite(board, insertIntoColumn(before.split("\n"), parsed.lane, restored).join("\n"));
    }
  }
  delete entry.groupedIn;
  delete entry.groupedLine;
  atomicWrite(tasksPath, `${JSON.stringify(raw, null, 1)}\n`);
  return true;
}

/** Reconcile one member against its category, summary, exemption and board lane. */
export function reconcileMembership(board: string, tasksPath: string, slug: string): void {
  if (!existsSync(tasksPath) || !existsSync(board)) { syncGroups(board, tasksPath); return; }
  let raw = JSON.parse(readFileSync(tasksPath, "utf8")) as Record<string, TaskLike>;
  let entry = raw[slug];
  if (!entry) { syncGroups(board, tasksPath); return; }

  const oldGroup = typeof entry.groupedIn === "string" ? parseGroupId(entry.groupedIn) : null;
  const card = readBoardCards(board).get(slug);
  const currentLane = oldGroup?.lane ?? card?.column;
  const target = groupTarget(entry, currentLane);
  if (target !== entry.groupedIn && oldGroup) {
    ungroupMember(board, tasksPath, slug);
    raw = JSON.parse(readFileSync(tasksPath, "utf8")) as Record<string, TaskLike>;
    entry = raw[slug]!;
  }

  if (target) {
    const current = readBoardCards(board).get(slug);
    if (current) {
      const before = readFileSync(board, "utf8");
      const matcher = cardMatcher(slug);
      const memberLine = before.split("\n").find(line => matcher.test(line));
      if (memberLine) {
        if (target !== entry.groupedIn) {
          entry.groupedLine = stripReviewSkipMark(memberLine);
          entry.title = current.title;
          entry.groupedIn = target;
          // Persist the recovery copy and membership before removing the board
          // line. If the process dies after this write, the next reconciliation
          // sees the still-present member and completes the removal.
          atomicWrite(tasksPath, `${JSON.stringify(raw, null, 1)}\n`);
        }
        const lines = before.split("\n");
        const index = lines.findIndex(line => matcher.test(line));
        lines.splice(index, 1);
        atomicWrite(board, lines.join("\n"));
      }
    }
  }

  // Same park-then-remove order as grouping, for the train card.
  const lane = readBoardCards(board).get(slug)?.column;
  if (trainFoldTarget(entry, lane)) foldIntoTrain(board, tasksPath, slug);
  syncGroups(board, tasksPath);
}

/** Park a member's board line in `trainLine` and take it off the board. */
function foldIntoTrain(board: string, tasksPath: string, slug: string): void {
  const raw = JSON.parse(readFileSync(tasksPath, "utf8")) as Record<string, TaskLike>;
  const entry = raw[slug];
  const before = readFileSync(board, "utf8");
  const matcher = cardMatcher(slug);
  const lines = before.split("\n");
  const index = lines.findIndex(line => matcher.test(line));
  if (!entry || index < 0) return;
  entry.trainLine = stripReviewSkipMark(lines[index]!);
  atomicWrite(tasksPath, `${JSON.stringify(raw, null, 1)}\n`);
  lines.splice(index, 1);
  atomicWrite(board, lines.join("\n"));
}

/** Put a folded member's parked line back so a move keeps its tags and embeds. */
function unfoldFromTrain(board: string, tasksPath: string, slug: string): void {
  if (!existsSync(tasksPath)) return;
  const raw = JSON.parse(readFileSync(tasksPath, "utf8")) as Record<string, TaskLike>;
  const entry = raw[slug];
  if (!entry || typeof entry.trainLine !== "string") return;
  if (!readBoardCards(board).has(slug)) {
    const before = readFileSync(board, "utf8").split("\n");
    atomicWrite(board, insertIntoColumn(before, "Review", entry.trainLine).join("\n"));
  }
  delete entry.trainLine;
  atomicWrite(tasksPath, `${JSON.stringify(raw, null, 1)}\n`);
}

/**
 * Every ref rendered on the BOARD, whoever wrote it.
 *
 * `tasks.json` is THIS pipeline's ledger, but the board is a shared surface:
 * other pipelines file cards carrying `T<n>` refs this ledger has never seen.
 * Issuing a number from the ledger alone therefore hands out a ref that is
 * already live, and since refs are how Nicholas steers ("skip T71"), the
 * duplicate silently re-points a decision he already made. Hit live on
 * 2026-09-11: the board held T69–T90, `tasks.json` stopped at T68, and five
 * new cards were issued T69–T73 on top of existing ones.
 *
 * `C<n>` is another pipeline's namespace outright — we never issue it, so it
 * is deliberately not read here.
 */
export function boardRefs(board: string): string[] {
  if (!existsSync(board)) return [];
  const pattern = new RegExp(
    `^\\s*-\\s*\\[.\\]\\s*\\*\\*([${REF_PREFIXES.join("")}]\\d+)\\s*·\\s*`, "i");
  const out: string[] = [];
  for (const line of readFileSync(board, "utf8").split("\n")) {
    const hit = pattern.exec(line);
    if (hit) out.push(hit[1]!.toUpperCase());
  }
  return out;
}

/** Every issued ref, in numeric order — so `T10` sorts after `T9`, which a
 *  lexical sort gets wrong exactly once the pipeline gets interesting. */
export function knownRefs(tasksPath: string, board?: string): RefEntry[] {
  const titles = board ? readBoardCards(board) : undefined;
  return Object.values(readTasks(tasksPath))
    .filter(t => typeof t.ref === "string" && REF_PATTERN.test(t.ref))
    .map(t => ({
      ref: t.ref as string,
      slug: t.slug,
      title: titles?.get(t.slug)?.title ?? (t.title as string | undefined) ?? t.slug,
    }))
    .sort((a, b) => refSortKey(a.ref) - refSortKey(b.ref));
}

/**
 * Turn whatever Nicholas (or an agent) typed into a slug.
 *
 * Only REF-SHAPED input is looked up. An unknown slug passes through untouched
 * on purpose: `upsert` legitimately runs before the `tasks.json` entry exists,
 * and every command already reports an unknown slug in the terms that fit it.
 * A ref-shaped value, though, is a claim about a specific decision — so an
 * unknown one FAILS, listing what does exist, rather than resolving to
 * something near it.
 */
export function resolveRef(input: string, tasksPath: string, board?: string): string {
  // An exact slug wins the tie: a task whose slug happened to look like a ref
  // must still be addressable by its own name.
  if (readTasks(tasksPath)[input]) return input;
  if (!REF_PATTERN.test(input)) return input;

  const known = knownRefs(tasksPath, board);
  const hit = known.find(r => r.ref.toUpperCase() === input.toUpperCase());
  if (hit) return hit.slug;
  throw new Error(
    `unknown task ref ${JSON.stringify(input)}. Known refs:\n` +
    (known.length
      ? known.map(r => `  ${r.ref}  ${r.slug}  ${r.title}`).join("\n")
      : "  (none yet)"));
}

/** The next ref to issue in one namespace: `max(issued) + 1`, never
 *  `count + 1`. Deleting or skipping a task leaves its number burned, which is
 *  the point. The two namespaces never see each other, so capturing a research
 *  item can never consume a task number (or vice versa). */
export function nextRef(
  tasksPath: string, prefix: RefPrefix = "T", board?: string,
): string {
  const nums = [...knownRefs(tasksPath).map(r => r.ref), ...(board ? boardRefs(board) : [])]
    .filter(r => refPrefix(r) === prefix)
    .map(refNum)
    .filter(Number.isFinite);
  return `${prefix}${(nums.length ? Math.max(...nums) : 0) + 1}`;
}

export interface ListRow {
  ref: string; slug: string; status: string; column: string; title: string;
  group?: string;
  /** Why the board and `tasks.json` disagree, or null when they agree. */
  drift: string | null;
}

/**
 * Why only a BEHIND status counts as drift:
 *
 * a column records the stage it proves, and status moves forward only, so a
 * status AHEAD of its column is ordinary in-flight work (the investigator
 * records `investigating` while the card is still in `todo`). A status BEHIND
 * its column is the dangerous case: the board promises progress `tasks.json`
 * has never recorded, and Nicholas reads the board.
 */
function driftReason(task: TaskLike, card: BoardCard | undefined): string | null {
  if (!card) return "not on the board";
  const stage = COLUMN_STAGE[card.column];
  if (!stage) return null; // Need Attention / Done prove nothing about progress
  const have = STAGES.findIndex(s => STATUS_OF[s] === task.status);
  if (have >= STAGES.indexOf(stage)) return null;
  return `column "${card.column}" implies ${STATUS_OF[stage]}, ` +
    `tasks.json says ${task.status ?? "(none)"}`;
}

/** One row per task, ordered by ref. The column comes from the BOARD — reading
 *  it back from `tasks.json` would only ever confirm what `tasks.json` already
 *  said, and could never catch a hand-dragged card. */
export function listRows(tasksPath: string, board: string): ListRow[] {
  const cards = readBoardCards(board);
  const rows = Object.values(readTasks(tasksPath)).map(task => {
    const parsed = typeof task.groupedIn === "string" ? parseGroupId(task.groupedIn) : null;
    const groupCard = parsed ? cards.get(task.groupedIn as string) : undefined;
    if (parsed) {
      return {
        ref: typeof task.ref === "string" ? task.ref : "-",
        slug: task.slug,
        status: task.status ?? "-",
        column: groupCard?.column ?? "-",
        title: (task.title as string | undefined) ?? task.slug,
        group: task.groupedIn as string,
        drift: !groupCard
          ? `group card ${task.groupedIn} missing from the board`
          : groupCard.column !== parsed.lane
            ? `group card ${task.groupedIn} is in "${groupCard.column}", expected "${parsed.lane}"`
            : null,
      };
    }
    const card = cards.get(task.slug);
    // A folded train member lives on its train card, which carries the lane.
    if (!card && typeof task.trainLine === "string" && task.train) {
      const trainCard = cards.get(`train-${task.train}`);
      return {
        ref: typeof task.ref === "string" ? task.ref : "-",
        slug: task.slug,
        status: task.status ?? "-",
        column: trainCard?.column ?? "-",
        title: (task.title as string | undefined) ?? task.slug,
        group: `train-${task.train}`,
        drift: trainCard ? null : `train card train-${task.train} missing from the board`,
      };
    }
    return {
      ref: typeof task.ref === "string" ? task.ref : "-",
      slug: task.slug,
      status: task.status ?? "-",
      column: card?.column ?? "-",
      title: card?.title ?? (task.title as string | undefined) ?? task.slug,
      drift: driftReason(task, card),
    };
  });
  // Refless entries (predating refs) sort last rather than crashing the sort.
  const key = (r: ListRow) => refSortKey(r.ref);
  return rows.sort((a, b) => key(a) - key(b) || a.slug.localeCompare(b.slug));
}

/**
 * Re-render a card note's status block from tasks.json.
 *
 * Returns why it did nothing, so the CALLER decides whether that is fine: an
 * explicit `stamp` treats a missing note as an error, while a `todo` transition
 * legitimately happens before any note exists.
 */
function stampCard(
  board: string, tasksPath: string, slug: string, now: string,
): { ok: boolean; reason?: string } {
  const task = readTasks(tasksPath)[slug];
  if (!task) return { ok: false, reason: `no entry for "${slug}" in ${tasksPath}` };
  const note = cardNotePath(board, slug);
  if (!existsSync(note)) return { ok: false, reason: `no card note at ${note}` };
  const before = readFileSync(note, "utf8");
  const after = stampNote(before, statusBlock({ ...task, slug }, now));
  if (after !== before) atomicWrite(note, after);
  return { ok: true };
}

/** Record the stage a column proves, then re-stamp. Both are no-ops when the
 *  coordinator has not created the task entry yet. */
function advance(
  board: string, tasksPath: string, slug: string, stage: Stage | undefined,
  now: string, stamp: boolean,
): void {
  if (stage && existsSync(tasksPath)) {
    const raw = JSON.parse(readFileSync(tasksPath, "utf8")) as Record<string, TaskLike>;
    const current = raw[slug];
    if (current) {
      const normalized = normalizeTask(current);
      const updated = recordStage({ [slug]: normalized }, slug, stage, now)[slug]!;
      if (JSON.stringify(updated) !== JSON.stringify(current)) {
        raw[slug] = updated;
        atomicWrite(tasksPath, `${JSON.stringify(raw, null, 1)}\n`);
      }
    }
  }
  if (stamp) stampCard(board, tasksPath, slug, now);
}

/** Commands whose first positional names a task, and therefore takes a ref
 *  (`T5`) just as happily as a slug. */
const REF_COMMANDS = new Set([
  "upsert", "note", "stamp", "stage", "check", "feature", "priority",
  "categorize", "status", "tier",
]);

/** One rendered line per task, shared by `traincard` and `lanecard`.
 *  `- T175 · <one plain sentence> · details plan review !important` */
export function summaryLines(
  members: TaskLike[], board: string, showPriority = false,
): string[] {
  const cards = readBoardCards(board);
  const vault = "/Users/nicholas/Documents/Obisidian/";
  const field = <T,>(task: TaskLike, name: string): T | undefined =>
    (task as unknown as Record<string, T>)[name];
  const oneLine = (task: TaskLike): string => {
    const written = field<{ problem?: string }>(task, "summary")?.problem;
    const text = (written ?? field<string>(task, "title")
      ?? cards.get(String(task.slug))?.title
      ?? String(task.slug).replace(/-/g, " ")).trim();
    const first = /^(.{40,}?[.!?])(?:\s|$)/.exec(text)?.[1];
    const sentence = first && !/[.!?]{2}$/.test(first) ? first : text;
    return sentence.length > 110
      ? `${sentence.slice(0, 107).trimEnd()}…`
      : sentence.replace(/\.$/, "");
  };
  return members.map(task => {
    const ref = String(task.ref ?? task.slug);
    const dir = `openmarket/plans/om-bug-loop/${ref}`;
    // Only link a file that EXISTS. An Obsidian link to a missing note does not
    // error: it renders live and creates a stray note when clicked.
    const docs = ["details", "plan", "review"]
      .filter(name => existsSync(join(vault, dir, `${name}.md`)))
      .map(name => `[${name}](${dir}/${name}.md)`)
      .join(" ");
    const category = categoryFor(field<string>(task, "category"));
    const mark = category && !category.grouped ? " !important" : "";
    // Priority earns its space only where it changes what happens next: the
    // dispatch queue. On a train card every line is already shipped, so it
    // would be a column of identical noise.
    const priority = String(field<string>(task, "priority") ?? "low");
    const loud = showPriority && priority !== "low" ? ` #${priority}` : "";
    return `- ${ref} · ${oneLine(task)}${loud}${docs ? ` · ${docs}` : ""}${mark}`;
  });
}

function main(): number {
  const command = process.argv[2];
  if (command === "review-skip") {
    process.stderr.write(
      "review-skip was retired on 2026-09-17 (Nicholas): cards are grouped by category instead. See references/card-categories.md.\n",
    );
    return 1;
  }
  const board = argValue("--board") ?? DEFAULT_BOARD;
  const tasksPath = argValue("--tasks") ?? DEFAULT_TASKS;
  // Not defaulted here: the default is the TASK's lane, resolved at each call
  // site. Defaulting to chat here would silently judge a chart entry against
  // the chat map — the exact failure this lane exists to prevent.
  const featuresOverride = argValue("--features");
  const now = argValue("--now") ?? new Date().toISOString();

  // Resolved ONCE, before any command logic, so a ref works identically
  // everywhere and no command can forget to accept one.
  let positional = process.argv[3];
  if (command === "categorize" && positional && /^C\d+$/i.test(positional)) {
    process.stderr.write(
      "C cards belong to another pipeline and are never touched by om-bug-loop\n");
    return 1;
  }
  if (positional && REF_COMMANDS.has(command ?? "")) {
    try {
      positional = resolveRef(positional, tasksPath, board);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 1;
    }
  }

  if (command === "categorize") {
    const slug = positional;
    const categoryKey = process.argv[4];
    const individual = argValue("--individual");
    const forceGrouped = process.argv.includes("--grouped");
    if (!slug || !categoryKey || categoryKey.startsWith("--")) {
      process.stderr.write(
        "usage: kanban.ts categorize <task> <category-key> [--summary <json-file>] " +
        '[--individual "<why>"] [--grouped]\n');
      return 64;
    }
    const category = categoryFor(categoryKey);
    if (!category) {
      process.stderr.write(
        `unknown category ${JSON.stringify(categoryKey)}; choose: ` +
        `${CARD_CATEGORIES.map(value => value.key).join(", ")}\n`);
      return 64;
    }
    if (individual !== undefined && forceGrouped) {
      process.stderr.write("--individual and --grouped cannot be used together\n");
      return 64;
    }
    if (individual !== undefined &&
        (individual.trim() === "" || individual.trim().startsWith("--"))) {
      process.stderr.write('--individual needs a reason, for example --individual "open question"\n');
      return 64;
    }
    const raw = existsSync(tasksPath)
      ? JSON.parse(readFileSync(tasksPath, "utf8")) as Record<string, TaskLike>
      : {};
    const entry = raw[slug];
    if (!entry) { process.stderr.write(`no entry for "${slug}" in ${tasksPath}\n`); return 1; }
    const ref = typeof entry.ref === "string" ? entry.ref : null;
    if (!ref) {
      process.stderr.write(`categorize requires a T or F ref; "${slug}" has no ref\n`);
      return 1;
    }
    if (/^R\d+$/i.test(ref)) {
      process.stderr.write(`categorize does not apply to research cards; ${ref} is a research card\n`);
      return 1;
    }
    if (!/^[TF]\d+$/i.test(ref)) {
      process.stderr.write(`categorize is for T or F cards only; got ${ref}\n`);
      return 1;
    }
    const beforeEntry = JSON.stringify(entry);

    let summary: CardSummary | undefined;
    const summaryFile = argValue("--summary");
    if (summaryFile) {
      try { summary = JSON.parse(readFileSync(summaryFile, "utf8")) as CardSummary; }
      catch (e) { process.stderr.write(`invalid summary JSON: ${(e as Error).message}\n`); return 1; }
      const problem = summaryProblem(summary);
      if (problem) { process.stderr.write(`${problem}\n`); return 1; }
    }
    entry.category = category.key;
    if (summary) entry.summary = summary;
    if (individual !== undefined) entry.groupExempt = individual.trim();
    if (forceGrouped) delete entry.groupExempt;
    if (JSON.stringify(entry) !== beforeEntry) {
      atomicWrite(tasksPath, `${JSON.stringify(raw, null, 1)}\n`);
    }
    reconcileMembership(board, tasksPath, slug);

    const after = JSON.parse(readFileSync(tasksPath, "utf8")) as Record<string, TaskLike>;
    const current = after[slug]!;
    if (current.groupedIn) {
      process.stdout.write(`${ref} category ${category.key} — grouped in ${current.groupedIn}\n`);
      return 0;
    }
    const card = readBoardCards(board).get(slug);
    const reason = !category.grouped ? "not a grouped category"
      : individual !== undefined || (typeof current.groupExempt === "string" && current.groupExempt.trim())
        ? `exempt: ${current.groupExempt}`
        : summaryProblem(current.summary) !== null ? "no summary"
          : !card ? "not on the board"
            : !(GROUP_LANES as readonly string[]).includes(card.column)
              ? `lane ${card.column} is not grouped`
              : "not on the board";
    process.stdout.write(`${ref} category ${category.key} — individual (${reason})\n`);
    return 0;
  }

  if (command === "consume") {
    const lineNo = Number(process.argv[3]);
    const ref = argValue("--ref");
    const slug = argValue("--slug");
    if (!Number.isInteger(lineNo) || !ref || !slug) {
      process.stderr.write(
        "usage: kanban.ts consume <lineNo> --ref <T7|R3> --slug <slug> [--product chat|chart]\n");
      return 64;
    }
    const product = argValue("--product") ?? DEFAULT_PRODUCT;
    const judgedTier = argValue("--tier");
    if (judgedTier !== undefined && !isTier(judgedTier)) {
      process.stderr.write(`unknown tier ${JSON.stringify(judgedTier)}; choose: ${TIERS.join(", ")}\n`);
      return 64;
    }
    const text = readFileSync(board, "utf8");
    const lines = text.split("\n");
    const line = lines[lineNo];
    if (line === undefined) {
      process.stderr.write(`no line ${lineNo} in ${board}\n`);
      return 1;
    }

    // Source is read from the note BEFORE any write. A hand-written line with
    // no note, or an unmarked note, deliberately carries no origin key.
    const notePath = cardNotePath(board, slug);
    const noteBody = existsSync(notePath) ? readFileSync(notePath, "utf8") : "";
    const origin = noteBody && hasPlayAroundMarker(noteBody)
      ? PLAY_AROUND_ORIGIN
      : undefined;
    const lineTags = line.match(TAG_RE) ?? [];

    const categoryFlag = argValue("--category");
    const markedCategory = categoryFlag === undefined ? readCategoryMarker(noteBody) : null;
    const categoryKey = categoryFlag ?? markedCategory ?? undefined;
    const category = categoryKey ? categoryFor(categoryKey) : undefined;
    if (categoryFlag && !category) {
      process.stderr.write(
        `unknown category ${JSON.stringify(categoryFlag)}; choose: ` +
        `${CARD_CATEGORIES.map(value => value.key).join(", ")}\n`);
      return 64;
    }
    if (markedCategory && !category) {
      process.stderr.write(`invalid category marker: ${markedCategory}\n`);
      return 1;
    }
    let summary: CardSummary | undefined;
    const summaryFile = argValue("--summary");
    if (summaryFile) {
      try { summary = JSON.parse(readFileSync(summaryFile, "utf8")) as CardSummary; }
      catch (e) { process.stderr.write(`invalid summary JSON: ${(e as Error).message}\n`); return 1; }
    } else if (SUMMARY_MARKER.test(noteBody)) {
      summary = readSummaryMarker(noteBody) ?? undefined;
      if (!summary) { process.stderr.write("invalid summary marker\n"); return 1; }
    }
    if (summary) {
      const summaryError = summaryProblem(summary);
      if (summaryError) { process.stderr.write(`${summaryError}\n`); return 1; }
    }

    // The ledger must agree with Nicholas's tag because the coordinator
    // dispatches by the ledger; hit live 2026-09-15 on F64/F66/T186/T189.
    const requestedPriority = argValue("--priority") ?? linePriority(line) ?? DEFAULT_PRIORITY;
    const priority = playAroundCap(requestedPriority, origin, isFeatureCard(ref, lineTags), lineTags);
    if (priority !== requestedPriority) {
      process.stderr.write(
        `capped #high → #medium for ${ref}: play-around cards that are not features max out at medium (Nicholas, 2026-09-17)\n`);
    }

    // The tier is decided here, not by the dispatcher, so the rule lives in one
    // tested function and the ledger records what was dispatched by.
    const tierDecision = decideTier({
      tags: lineTags,
      importantCategory: category ? !category.grouped : false,
      priority,
      feature: isFeatureCard(ref, lineTags),
      judged: judgedTier as Parameters<typeof decideTier>[0]["judged"],
    });
    if (tierDecision.floored) {
      process.stderr.write(
        `floored ${judgedTier} → ${tierDecision.tier} for ${ref}: ${category && !category.grouped ? `category ${category.key} is one Nicholas reads himself` : "a #high feature"} (Nicholas, 2026-09-24)\n`);
    }

    // The title the line ALREADY carries — what would be rendered with no
    // `--title`. A long one is not an error in the reporter; it is a brief that
    // landed in the wrong field, so it is banked in the note and cut here.
    const asFiled = readTitle(/^\s*-\s*\[.\]\s*(.*)$/.exec(line)?.[1] ?? "").title;
    const short = argValue("--title");
    const problem = titleProblem(short ?? asFiled);
    if (problem) {
      process.stderr.write(`${problem}\n\nRe-run with --title "<short handle>".\n`);
      return 1;
    }

    // Banked BEFORE the line is rewritten: once the board line carries the
    // short title, the long text exists nowhere else. Never overwrites a note
    // that already exists — `file-finding` and the owners write real ones, and
    // this fallback must not clobber them.
    if (short && short.trim() !== asFiled && !existsSync(notePath)) {
      atomicWrite(notePath, filedFindingNote(short, asFiled));
    }

    let rewritten: string;
    try {
      rewritten = consumeLine(line, ref, slug, board, product, short ?? undefined, priority);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 1;
    }

    // Entry FIRST, so the ref is reserved before the board renders it. A crash
    // after this leaves a tracked task with no card, which `list` reports as
    // drift — recoverable. The reverse leaves a card whose ref gets reissued.
    const tasks = existsSync(tasksPath)
      ? JSON.parse(readFileSync(tasksPath, "utf8")) as Record<string, TaskLike>
      : {};
    const next = { ...tasks, [slug]: {
      id: null, slug, ref, status: "new", repo: null, product,
      priority,
      tier: tierDecision.tier, tierSource: tierDecision.source,
      ...(origin ? { origin } : {}),
      ...(category ? { category: category.key } : {}),
      ...(summary ? { summary } : {}),
      source: "board todo lane", stages: {}, seenAt: now,
    } };
    atomicWrite(tasksPath, `${JSON.stringify(next, null, 1)}\n`);

    lines[lineNo] = rewritten;
    atomicWrite(board, lines.join("\n"));
    stampCard(board, tasksPath, slug, now);
    reconcileMembership(board, tasksPath, slug);
    process.stdout.write(`${ref} · ${slug}\n${rewritten}\n`);
    return 0;
  }

  if (command === "file-finding") {
    // A REPORTER's command: it files a finding without claiming it. The board
    // line stays raw — no ref, no bold, no `|details` link — because the
    // watcher only picks up unclaimed lines, and a pre-formatted one reads as
    // already-taken and is ignored forever.
    //
    // What it adds over appending a line by hand is the note, written at the
    // slug the watcher will independently derive from the same title. That is
    // the whole point: the brief exists before the card does, so the title can
    // be a handle instead of a paragraph.
    const rest = process.argv.slice(3);
    const flagAt = rest.findIndex(a => a.startsWith("--"));
    const title = (flagAt < 0 ? rest : rest.slice(0, flagAt)).join(" ").trim();
    const noteFile = argValue("--file");
    if (!title || !noteFile) {
      process.stderr.write(
        'usage: kanban.ts file-finding "<short title>" --file <body.md> [--tags "#low #bug"] [--parent <ref>] [--column todo|"Need Attention"]\n');
      return 64;
    }
    // web-port-scout parks its questions as raw lines in Need Attention, where
    // Nicholas answers and drags them to `todo` (port) or `Withdrawn` (skip).
    // Only those two intake columns: anything else would bypass the lifecycle.
    const column = argValue("--column") ?? "todo";
    if (column !== "todo" && column !== "Need Attention") {
      process.stderr.write(`--column must be "todo" or "Need Attention", got ${JSON.stringify(column)}\n`);
      return 64;
    }
    const problem = titleProblem(title);
    if (problem) { process.stderr.write(`${problem}\n`); return 1; }

    const categoryKey = argValue("--category");
    const category = categoryKey ? categoryFor(categoryKey) : undefined;
    if (categoryKey && !category) {
      process.stderr.write(
        `unknown category ${JSON.stringify(categoryKey)}; choose: ` +
        `${CARD_CATEGORIES.map(value => value.key).join(", ")}\n`);
      return 64;
    }
    let summary: CardSummary | undefined;
    const summaryFile = argValue("--summary");
    if (summaryFile) {
      try { summary = JSON.parse(readFileSync(summaryFile, "utf8")) as CardSummary; }
      catch (e) { process.stderr.write(`invalid summary JSON: ${(e as Error).message}\n`); return 1; }
      const summaryError = summaryProblem(summary);
      if (summaryError) { process.stderr.write(`${summaryError}\n`); return 1; }
    }

    const body = readFileSync(noteFile, "utf8");
    if (body.trim().length < 80) {
      // The same threshold `noteProblem` gates the `in progress` move on. Fail
      // here, where the reporter still has the finding in hand, rather than
      // hours later in an owner's run.
      process.stderr.write(
        `note body is a stub (${body.trim().length} chars, need 80+): ${noteFile}\n` +
        "The note is the brief — surface, observed behaviour with screenshot" +
        " paths, the reference, and the one-sentence fix.\n");
      return 1;
    }

    const stray = strayHeadings(body);
    if (stray.length) {
      process.stderr.write(
        `the note uses ${stray.length} heading(s) the card note template does not have:\n` +
        `${stray.map(h => `  ## ${h}`).join("\n")}\n` +
        `Use only: ${CARD_NOTE_SECTIONS.map(h => `## ${h}`).join(", ")}.\n` +
        "`kanban.ts note` refuses to drop a section a card already has, so an" +
        " invented heading strands this finding when the owner writes its note.\n");
      return 1;
    }

    // A follow-up inherits its PARENT's priority unless --tags names one. Without
    // this every finding started at DEFAULT_PRIORITY, so a family Nicholas had
    // ruled #high (the mobile restyle wave, 2026-09-19) kept re-appearing at
    // #low as its owners fanned out, and he found them in the queue first. An
    // explicit priority in --tags still wins; the play-around cap below still
    // applies after. An unknown --parent refuses rather than falling back to
    // #low, because a silent fallback is the exact bug this closes.
    const parentRef = argValue("--parent");
    let inherited: string | null = null;
    if (parentRef) {
      const parent = Object.values(readTasks(tasksPath))
        .find(task => String(task.ref ?? "").toLowerCase() === parentRef.toLowerCase());
      if (!parent) {
        process.stderr.write(`--parent ${parentRef}: no task with that ref in ${tasksPath}\n`);
        return 1;
      }
      const priority = String(parent.priority ?? "").toLowerCase();
      inherited = PRIORITY_TAGS.has(`#${priority}`) ? priority : null;
    }
    const givenTags = argValue("--tags")?.trim();
    let tags = givenTags ?? `#${inherited ?? DEFAULT_PRIORITY}`;
    if (givenTags && inherited && linePriority(givenTags) === null) {
      tags = `${givenTags} #${inherited}`;
    }
    if (inherited && linePriority(givenTags ?? "") === null) {
      process.stdout.write(`inherited #${inherited} from parent ${parentRef}\n`);
    }
    const hasTag = (tag: string) =>
      tags.split(/\s+/).some(value => value.toLowerCase() === tag);
    if (hasTag("#bug")) {
      const repro = noteSection(body, "Reproduction steps");
      if (repro === null || !hasNumberedStep(repro)) {
        process.stderr.write(
          'a #bug finding needs a "## Reproduction steps" section with numbered steps' +
          " from a cold app, ending with **Expected:** and **Actual:** lines — the owner" +
          " reproduces from it before touching code.\n");
        return 1;
      }
    }
    if (hasTag("#feature")) {
      const howTo = noteSection(body, "How to try it");
      if (howTo === null || !hasNumberedStep(howTo)) {
        process.stderr.write(
          'a #feature finding needs a "## How to try it" section with numbered steps from' +
          ' a cold app to the surface, headed "Current behaviour (not built yet):", showing' +
          " where the gap is.\n");
        return 1;
      }
    }

    // mobile-charts is exempt: Nicholas ruled every mobile-charts card #high
    // (2026-10-02), and web-port-scout files ported fixes as #bug.
    if (hasTag("#high") && !hasTag("#feature") && !hasTag("#mobile-charts")) {
      tags = tags.split(/\s+/)
        .map(tag => tag.toLowerCase() === "#high" ? "#medium" : tag)
        .join(" ");
      process.stdout.write(
        "capped #high → #medium: a play-around finding that is not a #feature maxes out at medium (Nicholas, 2026-09-17)\n");
    }

    const slug = argValue("--slug") ?? slugify(title);
    const note = cardNotePath(board, slug);
    if (existsSync(note) && readFileSync(note, "utf8").trim()) {
      // Two findings whose first five words match would silently share a note
      // AND a slug, and the second would overwrite the first. Refuse loudly:
      // the fix is one distinguishing word in the title.
      process.stderr.write(
        `a card note already exists at ${note}\n` +
        `"${title}" slugs to "${slug}", which is taken. Retitle it so the slug` +
        " differs, or pass --slug <unique> if this really is the same card.\n");
      return 1;
    }
    const markers = [
      SOURCE_MARKER,
      category ? categoryMarkerLine(category.key) : null,
      summary ? summaryMarkerLine(summary) : null,
    ].filter(Boolean).join("\n");
    atomicWrite(note, `${markers}\n${filedFindingNote(title, body)}`);

    const raw = `- [ ] ${title}${tags ? ` ${tags}` : ""}`;
    atomicWrite(board, insertIntoColumn(
      readFileSync(board, "utf8").split("\n"), column, raw).join("\n"));
    process.stdout.write(`filed · ${slug}\n${raw}\n  note: ${note}\n`);
    return 0;
  }

  // ── traincard ───────────────────────────────────────────────────────────
  // One card per open MR (Nicholas, 2026-09-18). The card is an INDEX: a bug's
  // problem, repro and before/after images live in the MR description, and the
  // reasoning lives in its plan. What stays on the board is a generated summary
  // plus the human's own open questions.
  //
  // The summary is regenerated from tasks.json on every call and must NEVER be
  // hand-edited — re-rendering a board line by hand has silently dropped tags
  // and images in this pipeline before, which is exactly why this is mechanical.
  // `## Open Questions` is the opposite: it is Nicholas's, so it is lifted out
  // of the existing note and written back byte-for-byte.
  //
  // `!important` marks the lines he has said he must read himself. That set is
  // not a second list to keep in sync: it is exactly the categories already
  // flagged `grouped: false` in CARD_CATEGORIES (4 raw-data, 6 write-safety,
  // 8 dead-ends, 10 product-decision, 12 pipeline-infra).
  if (command === "traincard") {
    const key = process.argv[3];
    if (!key || key.startsWith("--")) {
      process.stderr.write(
        "usage: kanban.ts traincard <train-key> [--column <col>]\n");
      return 64;
    }
    const tasks = readTasks(tasksPath);
    const field = <T,>(task: TaskLike, name: string): T | undefined =>
      (task as unknown as Record<string, T>)[name];
    const refNum = (task: TaskLike): number => {
      const hit = /^[A-Za-z](\d+)$/.exec(String(task.ref ?? ""));
      return hit ? Number(hit[1]) : Number.MAX_SAFE_INTEGER;
    };
    const members = Object.values(tasks)
      .filter(task => field<string>(task, "train") === key)
      .sort((a, b) => refNum(a) - refNum(b));
    if (members.length === 0) {
      process.stderr.write(`no tasks on train ${JSON.stringify(key)}\n`);
      return 1;
    }

    // Every MR any member rides. A cross-repo fix contributes a second one —
    // that is the whole "one card, many MRs" case, and the inverse (several
    // cards for one MR) is what this command exists to make impossible.
    // An MR that is another train's own PR is already on that train's card, so a
    // cross-repo member's second URL stays there (#945 sat on both the settings
    // and mobile-redesign cards, 2026-09-28).
    const ownedElsewhere = new Set(Object.values(tasks)
      .filter(task => { const t = field<string>(task, "train"); return t && t !== key; })
      .map(task => field<string>(task, "mrUrl"))
      .filter((url): url is string => !!url));
    const mrUrls: string[] = [];
    for (const task of members) {
      const urls = [field<string>(task, "mrUrl"), ...(field<string[]>(task, "mrUrls") ?? [])];
      for (const url of urls) {
        if (url && !mrUrls.includes(url) && (url === field<string>(task, "mrUrl") || !ownedElsewhere.has(url))) {
          mrUrls.push(url);
        }
      }
    }
    if (mrUrls.length === 0) {
      process.stderr.write(`train ${key} has no MR yet — nothing to index\n`);
      return 1;
    }

    // A train is re-shipped as PRs close, so members accumulate URLs of PRs that
    // are already merged or abandoned. Titling the card after mrUrls[0] named a
    // long-merged #933 for a train whose live PR is #942 — so ask the host which
    // one is actually open rather than trusting ledger order.
    const stateOf = new Map<string, string>();
    for (const url of mrUrls) {
      const gitlab = /^https:\/\/([^/]+)\/(.+)\/-\/merge_requests\/(\d+)\/?$/.exec(url);
      if (gitlab) {
        try {
          const raw = execFileSync(process.env.KANBAN_GLAB ?? process.env.TRAIN_GLAB ?? "glab", [
            "api", "--hostname", gitlab[1]!,
            `projects/${encodeURIComponent(gitlab[2]!)}/merge_requests/${gitlab[3]}`,
          ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
          const state = String(JSON.parse(raw).state ?? "").toLowerCase();
          stateOf.set(url, state === "merged" ? "merged"
            : state === "opened" || state === "locked" ? "open" : "closed");
        } catch { /* offline: treat as unknown, still listed */ }
        continue;
      }
      const parsed = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
      if (!parsed) continue;
      try {
        const raw = execFileSync("gh", [
          "api", `repos/${parsed[1]}/${parsed[2]}/pulls/${parsed[3]}`,
          "-q", ".state + (if .merged then \" merged\" else \"\" end)",
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        stateOf.set(url, raw.includes("merged") ? "merged"
          : raw.startsWith("open") ? "open" : "closed");
      } catch { /* offline: treat as unknown, still listed */ }
    }
    const isOpen = (url: string) => (stateOf.get(url) ?? "open") === "open";
    mrUrls.sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)));

    const lines = summaryLines(members, board);

    const slug = `train-${key}`;
    const note = cardNotePath(board, slug);
    const previous = existsSync(note) ? readFileSync(note, "utf8") : "";
    const carried = /##\s+Open Questions\s*\n([\s\S]*?)$/.exec(previous);
    const questions = (carried?.[1] ?? "").trim();

    atomicWrite(note, [
      ...mrUrls.map(url => {
        const state = stateOf.get(url);
        return `MR: ${url}${state && state !== "open" ? ` (${state})` : ""}`;
      }),
      "",
      "## Summary",
      ...lines,
      "",
      "## Open Questions",
      questions === "" ? "- none" : questions,
      "",
    ].join("\n"));

    // GitLab trains (the mobile repo) link /-/merge_requests/<n>; matching only
    // /pull/ titled openmarket-chat-app's first train "PR ?".
    const hit = /\/(pull|merge_requests)\/(\d+)/.exec(mrUrls[0]!);
    const number = hit?.[2] ?? "?";
    // "PR 951", not "#951": a leading # in a card title is indexed by Obsidian
    // as a tag, which put a junk #951 into the board's tag list on first run.
    const title = `${hit?.[1] === "merge_requests" ? "MR" : "PR"} ${number} · ${key} — ${members.length} fixes`;
    const tooLong = titleProblem(title);
    if (tooLong) { process.stderr.write(`${tooLong}\n`); return 1; }
    // A train whose live MR is already merged is history, not a review queue
    // item — rail-shell's #937 landed days ago and would otherwise have sat in
    // Review asking to be looked at again.
    const allMerged = mrUrls.length > 0 &&
      mrUrls.every(url => stateOf.get(url) === "merged");
    const column = argValue("--column") ?? (allMerged ? "Done" : "Review");
    // A train card inherits its loudest member: defaulting to #low would file a
    // card carrying a #medium fix under a tag that says "skip me".
    const rank = ["low", "medium", "high"];
    const priority = members.reduce((worst, task) => {
      const own = String(field<string>(task, "priority") ?? DEFAULT_PRIORITY);
      return rank.indexOf(own) > rank.indexOf(worst) ? own : worst;
    }, "low");
    // A train is one product's work; tagging every train with the default put
    // the mobile-redesign train under #openmarket instead of #mobile.
    const products = new Set(members.map(task =>
      String(field<string>(task, "product") ?? DEFAULT_PRODUCT)));
    const trainProduct = products.size === 1 ? [...products][0]! : DEFAULT_PRODUCT;
    atomicWrite(board, moveCard(readFileSync(board, "utf8"), slug, column,
      title, board, priority, trainProduct));

    const marked = lines.filter(line => line.endsWith("!important")).length;
    process.stdout.write(
      `${title}\n  ${mrUrls.length} MR(s), ${marked} line(s) marked !important\n  note: ${note}\n`);
    return 0;
  }

  // ── lanecard ────────────────────────────────────────────────────────────
  // The queue's answer to `traincard`. Work that has not shipped has no MR, so
  // it cannot be a train card — but it can be read the same way: one card per
  // lane, one line per task, the same `!important` marks and the same three
  // document links. Selection is by STATUS, not by which cards sit in the
  // column, so the command stays correct after the individual cards are gone.
  if (command === "lanecard") {
    const lane = process.argv[3];
    const SELECT: Record<string, { statuses: string[]; column: string; label: string }> = {
      todo: { statuses: ["new"], column: "todo", label: "queue" },
      "in-progress": {
        statuses: ["investigating", "planned", "implementing"],
        column: "in progress", label: "in flight",
      },
    };
    const spec = lane ? SELECT[lane] : undefined;
    if (!spec) {
      process.stderr.write("usage: kanban.ts lanecard (todo|in-progress)\n");
      return 64;
    }
    const tasks = readTasks(tasksPath);
    const rank = ["high", "medium", "low"];
    // The queue card indexes everything unstarted that is NOT already visible as
    // its own card in this lane (Nicholas, 2026-09-20). Two rules meet here and
    // only one of them belongs in this command:
    //
    //   * WHAT STAYS LOOSE is an origin question, and `fold` answers it — a card
    //     Nicholas filed by hand keeps its own row, a sweep finding is binned.
    //   * WHAT THIS CARD LISTS is a POSITION question. The index exists so that
    //     unstarted work is findable, and a task is findable already if its card
    //     is sitting in the column. Listing it twice was the whole complaint.
    //
    // Selecting by origin here instead looked equivalent and is not: on
    // 2026-09-20 that predicate would have dropped 61 unstarted tasks whose
    // cards sit in `Withdrawn` or nowhere, because `origin` only exists on cards
    // filed after the source marker landed on 2026-09-17. They would have been
    // on no card and in no column — invisible to the coordinator, which reads
    // this index to choose. Position cannot lose a task that way: anything not
    // in the column is, by construction, still listed here.
    // Keyed by column, because this card carries two sections: `## Summary`
    // covers the lane's own column and `## Backlog` covers `backlog`. A card
    // loose in one must not be struck from the other's list.
    const looseIn = new Map<string, string>();
    for (const [slug, card] of readBoardCards(board)) {
      if (!/^(lane|train|group)-/.test(slug)) looseIn.set(slug, card.column);
    }
    const queued = (column: string) => (task: { slug?: string }) =>
      looseIn.get(String(task.slug ?? "")) !== column;
    const members = Object.values(tasks)
      .filter(task => spec.statuses.includes(String(task.status)))
      .filter(task => /^[TFR]\d+$/i.test(String(task.ref ?? "")))
      .filter(queued(spec.column))
      .sort((a, b) => {
        const pa = rank.indexOf(String((a as unknown as Record<string, string>).priority ?? "low"));
        const pb = rank.indexOf(String((b as unknown as Record<string, string>).priority ?? "low"));
        if (pa !== pb) return pa - pb;   // #high first — dispatch order
        const na = Number(/\d+/.exec(String(a.ref))?.[0] ?? 0);
        const nb = Number(/\d+/.exec(String(b.ref))?.[0] ?? 0);
        return na - nb;
      });
    if (members.length === 0) {
      process.stderr.write(`nothing in ${lane}\n`);
      return 1;
    }
    // The todo card also carries the backlog, as a second section rather than a
    // second card: Nicholas asked that nothing unstarted sit loose on the board,
    // and two "big chunks" is still two things to find.
    const backlog = lane !== "todo" ? [] : Object.values(tasks)
      .filter(task => String(task.status) === "backlog")
      .filter(task => /^[TFR]\d+$/i.test(String(task.ref ?? "")))
      .filter(queued("backlog"))
      .sort((a, b) => Number(/\d+/.exec(String(a.ref))?.[0] ?? 0)
                    - Number(/\d+/.exec(String(b.ref))?.[0] ?? 0));
    const slug = `lane-${lane}`;
    const note = cardNotePath(board, slug);
    const previous = existsSync(note) ? readFileSync(note, "utf8") : "";
    const carried = /##\s+Open Questions\s*\n([\s\S]*?)$/.exec(previous);
    const questions = (carried?.[1] ?? "").trim();
    atomicWrite(note, [
      `*Generated by \`kanban.ts lanecard ${lane}\` — ${spec.label}, highest priority first.`,
      `Each task's brief is its \`details\` link; this card is an index.*`,
      "",
      "## Summary",
      ...summaryLines(members, board, true),
      ...(backlog.length > 0 ? [
        "",
        `## Backlog (${backlog.length})`,
        "",
        "*Captured but not promoted. Nothing here is dispatched until it moves to `todo`.*",
        "",
        ...summaryLines(backlog, board, true),
      ] : []),
      "",
      "## Open Questions",
      questions === "" ? "- none" : questions,
      "",
    ].join("\n"));
    const title = `Queue · ${lane} — ${members.length} tasks`;
    const tooLong = titleProblem(title);
    if (tooLong) { process.stderr.write(`${tooLong}\n`); return 1; }
    atomicWrite(board, moveCard(readFileSync(board, "utf8"), slug, spec.column,
      title, board, "low", DEFAULT_PRODUCT));
    const marked = summaryLines(members, board, true)
      .filter(line => line.endsWith("!important")).length;
    process.stdout.write(
      `${title}\n  ${marked} line(s) marked !important\n  note: ${note}\n`);
    return 0;
  }

  // ── fold ────────────────────────────────────────────────────────────────
  // Nothing that is not `#human` should sit loose on the board (Nicholas,
  // 2026-09-18): a task lives as a line on a queue or train card, and its own
  // card goes to `Withdrawn`, which is a BIN, not a verdict — the ledger status
  // is never touched.
  //
  // AMENDED 2026-09-20: that rule now applies to om-play-around findings only.
  // A card Nicholas filed himself is feature-scale, wants its own review, and is
  // dispatched ahead of the queue, so binning it into an index is exactly wrong
  // — it would make the more important work the harder work to find. The two
  // sets are disjoint by construction: `lanecard todo` no longer indexes a
  // hand-filed card, so the `indexed` guard below would already keep it, and the
  // explicit origin check states the rule rather than leaving it as a side
  // effect of another command.
  //
  // Four exclusions, each of which cost something when it was missing:
  //   * a card with NO ledger entry is raw intake that nobody has consumed.
  //     Folding it destroys work the watcher will never re-offer, because
  //     `dispatched` is a permanent guard rather than a filter.
  //   * a card whose task has a LIVE owner stays put. An ad-hoc sweep folded
  //     T246 while its owner was working, and the owner reasonably read its own
  //     card sitting in Withdrawn as the task having been cancelled.
  //   * a generated card is identified by having no ledger entry — never by a
  //     `train-` prefix. T212, T217 and T224 are tasks ABOUT train.ts, and a
  //     prefix filter silently left all three behind.
  if (command === "fold") {
    const LIVE = new Set(["investigating", "planned", "implementing", "reviewing"]);
    const FROM = new Set(["todo", "backlog"]);
    const tasks = readTasks(tasksPath);
    const indexed = new Set<string>();
    const dir = join(dirname(board), "cards");
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (!/^(lane|train)-/.test(file)) continue;
        for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
          const hit = /^- ([A-Za-z]\d+) ·/.exec(line);
          if (hit) indexed.add(hit[1]!.toUpperCase());
        }
      }
    }
    const dry = process.argv.includes("--dry-run");
    let folded = 0; const skipped: string[] = [];
    for (const [slug, card] of readBoardCards(board)) {
      if (!FROM.has(card.column)) continue;
      if (/^(lane|train|group)-/.test(slug) && !tasks[slug]) continue;
      const task = tasks[slug];
      if (!task) { skipped.push(`${slug} — raw intake, never consumed`); continue; }
      const ref = String(task.ref ?? "").toUpperCase();
      if (LIVE.has(String(task.status))) {
        skipped.push(`${ref} — live owner (${task.status})`); continue;
      }
      if (task.origin !== PLAY_AROUND_ORIGIN) {
        skipped.push(`${ref} — filed by hand; stays loose, dispatched first`); continue;
      }
      if (!indexed.has(ref)) {
        skipped.push(`${ref} — on no queue or train card`); continue;
      }
      if (!dry) {
        atomicWrite(board, moveCard(readFileSync(board, "utf8"), slug, "Withdrawn"));
      }
      folded++;
    }
    process.stdout.write(`${dry ? "would fold" : "folded"} ${folded} card(s)\n`);
    for (const why of skipped) process.stdout.write(`  kept: ${why}\n`);
    return 0;
  }

  if (command === "backlog") {
    // Stop at the first flag rather than filtering flags out: a flag's VALUE is
    // a separate argv element that does not start with "--", so filtering would
    // splice `--board`'s path into the title.
    const rest = process.argv.slice(3);
    const flagAt = rest.findIndex(a => a.startsWith("--"));
    const title = (flagAt < 0 ? rest : rest.slice(0, flagAt)).join(" ").trim();
    if (!title) {
      process.stderr.write('usage: kanban.ts backlog "<title>" [--file <note.md>] [--research|--feature]\n');
      return 64;
    }
    // Backlog cards sit on the same board and are read the same way — and they
    // sit there longest, so an unskimmable one costs the most.
    const longTitle = titleProblem(title);
    if (longTitle) { process.stderr.write(`${longTitle}\n`); return 1; }
    const slug = argValue("--slug") ?? slugify(title);
    const tasks = readTasks(tasksPath);
    if (tasks[slug]) {
      process.stdout.write(`already captured: ${tasks[slug]!.ref ?? ""} ${slug}\n`);
      return 0;
    }
    const noteFile = argValue("--file");
    const body = noteFile ? readFileSync(noteFile, "utf8") : undefined;

    const ref = nextRef(tasksPath, refPrefixFlag());
    // Entry FIRST, so the ref is reserved before anything renders it. A crash
    // after this leaves a tracked task with no card, which `list` reports as
    // drift — recoverable. The reverse leaves a card whose ref gets reissued.
    const next = { ...tasks, [slug]: {
      id: null, slug, ref, status: "backlog", repo: null,
      product: argValue("--product") ?? DEFAULT_PRODUCT,
      priority: argValue("--priority") ?? DEFAULT_PRIORITY,
      source: "backlog (captured in session)", stages: {}, seenAt: now,
    } };
    atomicWrite(tasksPath, `${JSON.stringify(next, null, 1)}\n`);

    const note = cardNotePath(board, slug);
    if (!existsSync(note)) atomicWrite(note, backlogNote(title, body));

    atomicWrite(board, moveCard(readFileSync(board, "utf8"), slug, "backlog",
      `${ref} · ${title}`, board, argValue("--priority") ?? DEFAULT_PRIORITY,
      argValue("--product") ?? DEFAULT_PRODUCT));
    stampCard(board, tasksPath, slug, now);
    process.stdout.write(`backlog + ${ref} · ${title}\n  note: ${note}\n`);
    return 0;
  }

  // Escalation only. The coordinator's tier is a guess from the card alone;
  // the owner is the first party to read the code, so it may raise the tier
  // and never lower it — lowering would let the cheaper path grade itself.
  if (command === "tier") {
    const slug = positional;
    const level = process.argv[4];
    const why = argValue("--why");
    if (!slug || !isTier(level) || !why?.trim()) {
      process.stderr.write('usage: kanban.ts tier <task> <normal|hard> --why "<what the code showed>"\n');
      return 64;
    }
    const tasks = readTasks(tasksPath);
    const entry = tasks[slug];
    if (!entry) {
      process.stderr.write(`no entry for "${slug}" in ${tasksPath}\n`);
      return 1;
    }
    if (!isTier(entry.tier) && entry.status === "new") {
      entry.tier = level;
      entry.tierSource = "judged";
      atomicWrite(tasksPath, `${JSON.stringify(tasks, null, 1)}\n`);
      process.stdout.write(`${entry.ref ?? slug}: tiered ${level} (intake)\n`);
      return 0;
    }
    const from = isTier(entry.tier) ? entry.tier : "normal";
    if (tierRank(level) <= tierRank(from)) {
      process.stderr.write(`${entry.ref ?? slug} is ${from}; a tier can only move up\n`);
      return 1;
    }
    entry.tier = level;
    entry.tierEscalations = [...(entry.tierEscalations ?? []), { from, to: level, at: now, why: why.trim() }];
    atomicWrite(tasksPath, `${JSON.stringify(tasks, null, 1)}\n`);
    process.stdout.write(`${entry.ref ?? slug}: ${from} → ${level}\n`);
    return 0;
  }

  if (command === "priority") {
    const slug = positional;
    const level = process.argv[4];
    if (!slug || !level || level.startsWith("--")) {
      process.stderr.write("usage: kanban.ts priority <task> <low|medium|high>\n");
      return 64;
    }
    const tasks = existsSync(tasksPath)
      ? JSON.parse(readFileSync(tasksPath, "utf8")) as Record<string, TaskLike>
      : {};
    if (!tasks[slug]) {
      process.stderr.write(`no entry for "${slug}" in ${tasksPath}\n`);
      return 1;
    }
    const entry = tasks[slug]!;
    const note = cardNotePath(board, slug);
    const playAround = entry.origin === PLAY_AROUND_ORIGIN ||
      (existsSync(note) && hasPlayAroundMarker(readFileSync(note, "utf8")));
    const feature = isFeatureCard(entry.ref,
      entry.groupedIn && typeof entry.groupedLine === "string"
        ? (entry.groupedLine.match(TAG_RE) ?? [])
        : boardCardTags(board, slug));
    if (level.toLowerCase() === "high" && playAround && !feature) {
      const ref = entry.ref ?? slug;
      process.stderr.write(
        `refusing #high for ${ref}: cards filed by om-play-around cap at #medium unless they are #feature — Nicholas's rule (2026-09-17). If he wants an exception, he edits the board line by hand.\n`);
      return 1;
    }
    const beforeEntry = JSON.stringify(entry);
    entry.priority = level;
    if (entry.groupedIn && typeof entry.groupedLine === "string") {
      const display = entry.ref ? `${entry.ref} · ${entry.title ?? slug}` : String(entry.title ?? slug);
      entry.groupedLine = stripReviewSkipMark(
        rerenderLine(entry.groupedLine, slug, display, board, level, entry.product));
    }
    if (JSON.stringify(entry) !== beforeEntry) {
      atomicWrite(tasksPath, `${JSON.stringify(tasks, null, 1)}\n`);
    }
    // Re-render the card line in place so the board tag never disagrees with
    // tasks.json — the same reason the status block is machine-owned.
    const card = readBoardCards(board).get(slug);
    if (card && !entry.groupedIn) {
      const ref = tasks[slug]!.ref;
      const title = ref ? `${ref} · ${card.title}` : card.title;
      atomicWrite(board, moveCard(readFileSync(board, "utf8"), slug,
        card.column, title, board, level, tasks[slug]!.product));
    }
    stampCard(board, tasksPath, slug, now);
    syncGroups(board, tasksPath);
    process.stdout.write(`${slug} → #${level}\n`);
    return 0;
  }

  if (command === "status") {
    const slug = positional;
    const status = process.argv[4];
    if (!slug || !status || !(TERMINAL_STATUSES as readonly string[]).includes(status)) {
      process.stderr.write(
        `usage: kanban.ts status <task> (${TERMINAL_STATUSES.join("|")})\n`);
      return 64;
    }
    const tasks = existsSync(tasksPath)
      ? JSON.parse(readFileSync(tasksPath, "utf8")) as Record<string, TaskLike>
      : {};
    if (!tasks[slug]) {
      process.stderr.write(`no entry for "${slug}" in ${tasksPath}\n`);
      return 1;
    }
    // Read-modify-write of what is on disk, preserving every key we do not
    // own: sibling owners write this file concurrently.
    if (tasks[slug]!.status !== status) {
      tasks[slug]!.status = status;
      atomicWrite(tasksPath, `${JSON.stringify(tasks, null, 1)}\n`);
    }
    stampCard(board, tasksPath, slug, now);
    syncGroups(board, tasksPath);
    process.stdout.write(`${slug} → ${status}\n`);
    return 0;
  }

  if (command === "next-ref") {
    process.stdout.write(`${nextRef(tasksPath, refPrefixFlag(), board)}\n`);
    return 0;
  }

  if (command === "list") {
    const rows = listRows(tasksPath, board);
    const w = (pick: (r: ListRow) => string) =>
      Math.max(0, ...rows.map(r => pick(r).length));
    const [wr, ws, wg, wc] = [w(r => r.ref), w(r => r.status), w(r => r.slug), w(r => r.column)];
    for (const r of rows) {
      const fields = [
        r.ref.padEnd(wr), r.status.padEnd(ws), r.slug.padEnd(wg),
        r.column.padEnd(wc), `${r.title}${r.group ? `  [${r.group}]` : ""}`,
      ];
      process.stdout.write(fields.join("  ") +
        (r.drift ? `  ⚠ drift: ${r.drift}` : "") + "\n");
    }
    return 0;
  }

  if (command === "init") {
    const current = existsSync(board) ? readFileSync(board, "utf8") : "";
    if (current.trim() !== "") {
      process.stderr.write(`refusing to overwrite an existing board: ${board}\n`);
      return 1;
    }
    atomicWrite(board, SKELETON);
    mkdirSync(join(dirname(board), "cards"), { recursive: true });
    mkdirSync(join(dirname(board), "evidence"), { recursive: true });
    process.stdout.write(`initialized ${board}\n`);
    return 0;
  }

  if (command === "upsert") {
    const slug = positional;
    const column = argValue("--column");
    const title = argValue("--title");
    if (!slug || !column) {
      process.stderr.write("usage: kanban.ts upsert <slug> --column <col> [--title <text>]\n");
      return 64;
    }
    // A retitle is the other door onto the card line, and it has to be the same
    // door: a cap the intake enforces and the retitle does not is a cap that
    // lasts until the first `upsert --title`.
    if (title !== undefined) {
      const long = titleProblem(title);
      if (long) { process.stderr.write(`${long}\n`); return 1; }
    }
    if (!existsSync(board)) { process.stderr.write(`no board at ${board}; run init first\n`); return 1; }
    let task = readTasks(tasksPath)[slug];
    const ref = task?.ref ?? boardCardRef(board, slug);
    const problem = noteProblem(board, slug, column, ref);
    if (problem) {
      process.stderr.write(
        `refusing to move "${slug}" into "${column}": ${problem}\n` +
        `write the note first: kanban.ts note ${slug} --file <md>\n`);
      return 1;
    }
    // The last unenforced step of the §7 review gate. Checked only for a task
    // that HAS an entry: this tool never invents task entries, so a board-only
    // card has nothing to check against — the same rule `advance` follows.
    if (column === "Review") {
      const gap = task && featureMapProblem(
        { ...task, slug }, featuresOverride ?? featureMapDir(task.product));
      if (gap) {
        process.stderr.write(`refusing to move "${slug}" into "Review": ${gap}\n`);
        return 1;
      }
    }

    // A retitle has to reach the LEDGER, not just the board line: the queue and
    // train cards render their summary from tasks.json, so a title written only
    // to the line leaves the card showing the old one. Invisible before
    // 2026-09-18, when the board line was the display; not invisible now. This
    // ran only inside the grouped branch below, so every non-grouped retitle was
    // silently half-applied.
    if (title !== undefined && task && existsSync(tasksPath)) {
      const raw = JSON.parse(readFileSync(tasksPath, "utf8")) as Record<string, TaskLike>;
      const entry = raw[slug];
      const clean = stripRefPrefix(title);
      if (entry && entry.title !== clean) {
        entry.title = clean;
        atomicWrite(tasksPath, `${JSON.stringify(raw, null, 1)}\n`);
        task = entry;
      }
    }

    const grouped = task?.groupedIn ? parseGroupId(String(task.groupedIn)) : null;
    if (grouped && grouped.lane === column) {
      if (title !== undefined && existsSync(tasksPath)) {
        const raw = JSON.parse(readFileSync(tasksPath, "utf8")) as Record<string, TaskLike>;
        const entry = raw[slug]!;
        const beforeEntry = JSON.stringify(entry);
        const clean = stripRefPrefix(title);
        entry.title = clean;
        if (typeof entry.groupedLine === "string") {
          const display = entry.ref ? `${entry.ref} · ${clean}` : clean;
          entry.groupedLine = stripReviewSkipMark(rerenderLine(
            entry.groupedLine, slug, display, board,
            String(entry.priority ?? DEFAULT_PRIORITY), entry.product,
          ));
        }
        if (JSON.stringify(entry) !== beforeEntry) {
          atomicWrite(tasksPath, `${JSON.stringify(raw, null, 1)}\n`);
        }
      }
      advance(board, tasksPath, slug, COLUMN_STAGE[column], now,
        !process.argv.includes("--no-stamp"));
      reconcileMembership(board, tasksPath, slug);
      process.stdout.write(`${slug} → ${column}\n`);
      return 0;
    }
    if (grouped) {
      ungroupMember(board, tasksPath, slug);
      task = readTasks(tasksPath)[slug];
    }
    // A folded train member has no line; without this, moveCard would invent
    // one titled with the bare slug (e.g. `train.ts drop` → Need Attention).
    unfoldFromTrain(board, tasksPath, slug);
    const before = readFileSync(board, "utf8");
    const prio = task?.priority ?? DEFAULT_PRIORITY;
    const after = moveCard(before, slug, column, title, board, prio, task?.product);
    if (after !== before) atomicWrite(board, after);
    // The move and the note refresh are ONE command on purpose: a coordinator
    // that has to remember a second call is a coordinator that will eventually
    // leave a card pointing at a stale note.
    advance(board, tasksPath, slug, COLUMN_STAGE[column], now,
      !process.argv.includes("--no-stamp"));
    reconcileMembership(board, tasksPath, slug);
    process.stdout.write(`${slug} → ${column}\n`);
    return 0;
  }

  if (command === "stamp") {
    const slug = positional;
    if (!slug) { process.stderr.write("usage: kanban.ts stamp <slug>\n"); return 64; }
    const r = stampCard(board, tasksPath, slug, now);
    if (!r.ok) { process.stderr.write(`cannot stamp "${slug}": ${r.reason}\n`); return 1; }
    syncGroups(board, tasksPath);
    process.stdout.write(`${cardNotePath(board, slug)}\n`);
    return 0;
  }

  if (command === "stage") {
    const [slug, stage] = [positional, process.argv[4]];
    if (!slug || !stage || !(STAGES as readonly string[]).includes(stage)) {
      process.stderr.write(`usage: kanban.ts stage <slug> (${STAGES.join("|")})\n`);
      return 64;
    }
    if (!readTasks(tasksPath)[slug]) {
      process.stderr.write(`no entry for "${slug}" in ${tasksPath}\n`);
      return 1;
    }
    advance(board, tasksPath, slug, stage as Stage, now, true);
    syncGroups(board, tasksPath);
    process.stdout.write(`${slug} @ ${stage}\n`);
    return 0;
  }

  if (command === "check") {
    const slug = positional;
    const item = argValue("--item");
    if (!slug || !item) {
      process.stderr.write('usage: kanban.ts check <slug> --item "<text>" [--done|--undone]\n');
      return 64;
    }
    const note = cardNotePath(board, slug);
    if (!existsSync(note)) { process.stderr.write(`no card note at ${note}\n`); return 1; }
    const done = !process.argv.includes("--undone");
    let updated: string;
    try {
      updated = checkItem(readFileSync(note, "utf8"), item, done);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 1;
    }
    atomicWrite(note, updated);
    // Ticking a box is a progress event, so refresh the elapsed clock with it.
    stampCard(board, tasksPath, slug, now);
    syncGroups(board, tasksPath);
    process.stdout.write(`${done ? "[x]" : "[ ]"} ${item} — ${note}\n`);
    return 0;
  }

  if (command === "feature") {
    const slug = positional;
    const files = argValues("--file");
    const noneIdx = process.argv.indexOf("--none");
    const none = noneIdx >= 0 ? (process.argv[noneIdx + 1] ?? "") : undefined;
    if (!slug || (files.length === 0 && none === undefined)) {
      process.stderr.write(
        'usage: kanban.ts feature <task> (--file <md> [--file <md>] | --none "<why>")\n');
      return 64;
    }
    if (files.length > 0 && none !== undefined) {
      process.stderr.write(
        "--file and --none are opposites: one records an entry, the other" +
        " declares there is no surface to record.\n");
      return 64;
    }
    // A waiver with no reason is a silent bypass wearing a flag, which is the
    // exact thing this gate exists to stop.
    if (none !== undefined && (none.trim() === "" || none.trim().startsWith("--"))) {
      process.stderr.write(
        'a "no feature surface" declaration needs a reason: --none "why this' +
        ' fix touches no user-reachable surface"\n');
      return 64;
    }

    // Read-modify-write of the file ON DISK: tasks.json has no locking and a
    // concurrent agent may have written it since this process started.
    const before = existsSync(tasksPath)
      ? JSON.parse(readFileSync(tasksPath, "utf8")) as Record<string, TaskLike>
      : {};
    const cur = before[slug];
    if (!cur) { process.stderr.write(`no entry for "${slug}" in ${tasksPath}\n`); return 1; }

    let value: string[];
    if (none !== undefined) {
      value = [`No feature surface — ${none.trim()}`];
    } else {
      const featuresRoot = featuresOverride ?? featureMapDir(cur.product);
      const badLane = featuresOverride ? null : unknownProduct(cur.product);
      if (badLane) {
        process.stderr.write(
          `refusing to record: product \`${badLane}\` is not a known lane ` +
          `(${Object.keys(FEATURE_MAP_DIRS).join(" | ")}).\n`);
        return 1;
      }
      const root = { real: realOrNull(featuresRoot), label: featuresRoot };
      const bad: string[] = [];
      const abs: string[] = [];
      for (const f of files) {
        // NaN: at recording time the entry is being written now, so staleness
        // is not yet a question — the Review gate asks it.
        const problem = entryProblem(f, root, NaN, "");
        // Absolute, but NOT realpath'd: recording the resolved vault path would
        // rot the moment the map moves (it moved twice on 2026-09-02). The
        // link-side spelling stays true, and the gate realpaths at read time.
        if (problem) bad.push(`  ${f} — ${problem}`);
        else abs.push(resolve(expandHome(f)));
      }
      if (bad.length) {
        process.stderr.write(
          `refusing to record a Feature Map entry that does not hold up:\n${bad.join("\n")}\n` +
          `entries live under ${featuresRoot} and carry the four H2 sections` +
          " (Sub-features / How to get to it (user POV) / Driving it" +
          " / Gotchas).\n");
        return 1;
      }
      // Additive and deduped — a second surface adds to the record rather than
      // replacing it — but a real entry supersedes any earlier declaration.
      const kept = featureMapEntries(cur).filter(e => !NO_FEATURE_SURFACE.test(e));
      value = [...new Set([...kept, ...abs])];
    }

    if (JSON.stringify(cur.featureMap) !== JSON.stringify(value)) {
      cur.featureMap = value;
      atomicWrite(tasksPath, `${JSON.stringify(before, null, 1)}\n`);
    }
    stampCard(board, tasksPath, slug, now);
    syncGroups(board, tasksPath);
    process.stdout.write(`${slug} feature map: ${value.join(", ")}\n`);
    return 0;
  }

  if (command === "note") {
    const slug = positional;
    const file = argValue("--file");
    if (!slug || !file) {
      process.stderr.write("usage: kanban.ts note <slug> --file <md>\n");
      return 64;
    }
    if (slug.startsWith("group-")) {
      process.stderr.write("group notes are machine-written; edit a member with kanban.ts categorize\n");
      return 1;
    }
    if (!existsSync(file)) { process.stderr.write(`no such note source: ${file}\n`); return 1; }
    const dest = join(dirname(board), "cards", `${slug}.md`);
    // `note` REPLACES the whole body, and the vault is not git-tracked — so a
    // caller who passes a partial file destroys everything it omitted, with no
    // undo. That happened on T29: Problem, Evidence, Reproduction steps,
    // Solution direction and Work items were silently lost, and cost twenty
    // minutes to reconstruct from the plan.
    //
    // Replacement is still the right semantics (the author owns the body, the
    // tool owns the status block), so this does not merge — it takes a backup
    // and refuses a replacement that looks like an accident.
    let replacement = readFileSync(file, "utf8");
    if (existsSync(dest)) {
      const before = readFileSync(dest, "utf8");
      const heads = (t: string) =>
        new Set((t.match(/^##\s+.+$/gm) ?? []).map(h => h.trim()));
      const lost = [...heads(before)].filter(h => !heads(replacement).has(h));
      // Timestamped backup first, always — cheap, and the only real undo.
      const backup = `${dest}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      writeFileSync(backup, before);
      if (lost.length && !process.argv.includes("--force")) {
        process.stderr.write(
          `refusing to replace ${dest}: the new body drops ${lost.length} section(s) ` +
          `the current card has:\n${lost.map(h => `  ${h}`).join("\n")}\n` +
          `The card body is REPLACED, not merged — read the existing card and ` +
          `include what you mean to keep.\nBackup written: ${backup}\n` +
          `Pass --force if the removal is deliberate.\n`);
        return 1;
      }
      const keptMarkers = before.split(/\r?\n/).filter(line =>
        line.trim() === SOURCE_MARKER || CATEGORY_MARKER.test(line) || SUMMARY_MARKER.test(line));
      const hasKind = (line: string) => line.trim() === SOURCE_MARKER
        ? hasPlayAroundMarker(replacement)
        : CATEGORY_MARKER.test(line) ? CATEGORY_MARKER.test(replacement)
          : SUMMARY_MARKER.test(replacement);
      const missing = keptMarkers.filter(line => !hasKind(line));
      if (missing.length) replacement = `${missing.join("\n")}\n${replacement}`;
    }
    atomicWrite(dest, replacement);
    // `note` replaces the whole file, which would silently drop the
    // machine-owned status block and source marker, and make every note-writing
    // agent hand-carry them byte-for-byte (they will eventually get it wrong).
    // Preserve the source marker and re-stamp the status block: an author only
    // ever writes the body.
    stampCard(board, tasksPath, slug, now);
    syncGroups(board, tasksPath);
    process.stdout.write(`${dest}\n`);
    return 0;
  }

  process.stderr.write([
    "usage: kanban.ts <command> [--board <path>] [--tasks <path>] [--now <iso>]",
    "  (<task> is a ref (T5) or a slug — both work everywhere)",
    "  init",
    "  backlog  \"<title>\" [--file <note.md>] [--research|--feature]",
    "  upsert   <task> --column <col> [--title <t>] [--no-stamp]",
    '  categorize <task> <category-key> [--summary <json-file>] [--individual "<why>"|--grouped]',
    "  note     <task> --file <md>",
    "  stamp    <task>",
    `  stage    <task> (${STAGES.join("|")})`,
    '  check    <task> --item "<text>" [--done|--undone]',
    '  feature  <task> (--file <md> [--file <md>] | --none "<why>")',
    "  list",
    "  status   <task> (shipped|researched|swept|withdrawn|skipped|failed)",
    "  consume <lineNo> --ref <T7|R3> --slug <slug> [--title <short>] [--product chat|chart] [--category <key>] [--summary <json-file>] [--tier trivial|normal|hard]",
    '  tier     <task> <normal|hard> --why "<what the code showed>"',
    '  file-finding "<short title>" --file <body.md> [--tags "#low #bug"] [--category <key>] [--summary <json-file>]',
    "  traincard <train-key> [--column <col>]",
    "  lanecard (todo|in-progress)",
    "  fold [--dry-run]",
    "  next-ref [--research|--feature]",
    "",
  ].join("\n"));
  return 64;
}

if (import.meta.main) process.exit(main());
