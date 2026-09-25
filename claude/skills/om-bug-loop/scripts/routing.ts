#!/usr/bin/env bun
// routing.ts — which agent owns an incoming board card.
//
// A card reaches the coordinator one way: the `todo` lane of Kanban.md, where
// Nicholas has already tagged it by hand. The tag is authoritative — he looked
// at it and said what it is — so this file is a precedence table and nothing
// more.
//
// It used to also classify untagged free text arriving from ⌗ OM Chat Bugs,
// which is why `looksLikeResearch` existed. That intake is retired: the board
// is the only door, and an untagged card means a defect (Nicholas, 2026-09-11:
// "Untagged always goes to om-task — delete the heuristic"). Nothing is routed
// on a guess about what he meant.

export type Owner = "om-task" | "om-feature" | "om-research" | "om-play-around" | "skip";

export interface IncomingTodo {
  /** The card's title, tags and embeds already stripped. */
  title: string;
  /** The card note's body, when there is one. Unused by routing today; kept
   *  because every caller already has it and a future rule may want it. */
  description?: string;
  /** Every `#tag` on the card line, in order. */
  tags?: string[];
}

export const HUMAN_TAG = "#human";
export const RESEARCH_TAG = "#research";
export const FEATURE_TAG = "#feature";
export const PA_TAG = "#pa";
export const BUG_TAG = "#bug";

/**
 * Route one card to its owning agent. Exactly one owner, highest precedence
 * first.
 *
 *   #human    → nobody. Nicholas's own card; the pipeline does not touch it.
 *   #research → om-research. An open question; ends in a doc and his decision.
 *   #feature  → om-feature. Something missing; ends in a merged MR.
 *   #pa       → om-play-around. Play the surface; ends in new cards.
 *   #bug      → om-task. A defect; ends in a merged MR.
 *   (none)    → om-task, through the same branch as #bug.
 *
 * The order encodes how settled the work is, most-open first. `#research` beats
 * everything because tagging it research is him saying it is not decided yet,
 * and you cannot build or play with an undecided thing. `#feature` beats `#pa`
 * because "build this" is a decision and "go play with it" is not — a card
 * carrying both means he wants it built, not surveyed.
 *
 * `#feature` and `#bug` are deliberately NOT interchangeable even though both
 * end in a merged MR: a defect's plan must prove a root cause and carries
 * reproduction steps, a feature's must write acceptance criteria and carries a
 * user flow. Routing one as the other produces a plan that cannot be verified.
 */
export function route(todo: IncomingTodo): Owner {
  const tags = new Set((todo.tags ?? []).map(t => t.toLowerCase()));
  if (tags.has(HUMAN_TAG)) return "skip";
  if (tags.has(RESEARCH_TAG)) return "om-research";
  if (tags.has(FEATURE_TAG)) return "om-feature";
  if (tags.has(PA_TAG)) return "om-play-around";
  return "om-task"; // `#bug` and untagged are the same branch, deliberately
}

// ---------------------------------------------------------------------------
// Tiers — how much pipeline a card buys (Nicholas, 2026-09-24)
//
// The reason is THROUGHPUT, not the token bill. Running 24/7, a typo, a null
// check or a wrong import went through the same investigate → plan → Codex →
// independent-verifier arc as a session-shape change, and held a dispatch slot
// (a daemon, a browser, a verifier's own arms) for all of it. A tier buys the
// card only the pipeline its risk needs:
//
//   trivial → om-quickfix: confirm the line, Codex, scoped tests, screenshots.
//   normal  → om-task / om-feature dispatched with model "sonnet".
//   hard    → om-task / om-feature on their frontmatter model (Opus).
//
// Routing and tiering are separate questions on purpose: `route` picks the
// lane from what the card IS, `tier` picks the depth from how risky it is, and
// neither tag family affects the other.
// ---------------------------------------------------------------------------

export type Tier = "trivial" | "normal" | "hard";
export const TIERS: readonly Tier[] = ["trivial", "normal", "hard"];
export const TRIVIAL_TAG = "#trivial";
export const HARD_TAG = "#hard";

/** Order for comparisons. Tiers only ever move up (see `kanban.ts tier`). */
export function tierRank(t: Tier): number { return TIERS.indexOf(t); }

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

export interface TierInput {
  /** Every `#tag` on the card line. */
  tags?: string[];
  /** The card's category is one Nicholas reads himself — `grouped: false` in
   *  CARD_CATEGORIES (4 raw-data, 6 write-safety, 8 dead-ends, 10
   *  product-decision, 12 pipeline-infra). Passed as a flag rather than
   *  re-listed here, so there is never a second list to keep in sync. */
  importantCategory?: boolean;
  priority?: string | null;
  feature?: boolean;
  /** The coordinator's read of the card and its note. It never reads code to
   *  make this call — investigating is the owner's job. */
  judged?: Tier;
}

export interface TierDecision {
  tier: Tier;
  source: "tag" | "judged" | "default";
  /** The floor raised the coordinator's judgement. */
  floored: boolean;
}

/**
 * Nicholas's precedence, verbatim:
 *   1. his tag wins — `#trivial` or `#hard` (both → `#hard`, the heavier);
 *   2. an important category, or any `#high` feature, is at least normal;
 *   3. otherwise the coordinator's judgement, and normal when it has none.
 *
 * The floor stops at normal, not hard: those categories need a real owner and
 * an independent verifier, but they do not all need Opus. Hard comes only from
 * his tag or the coordinator's judgement.
 */
export function tier(input: TierInput): TierDecision {
  const tags = new Set((input.tags ?? []).map(t => t.toLowerCase()));
  if (tags.has(HARD_TAG)) return { tier: "hard", source: "tag", floored: false };
  if (tags.has(TRIVIAL_TAG)) return { tier: "trivial", source: "tag", floored: false };

  const floor: Tier =
    input.importantCategory || (input.feature && input.priority?.toLowerCase() === "high")
      ? "normal"
      : "trivial";
  const wanted: Tier = input.judged ?? "normal";
  const floored = tierRank(floor) > tierRank(wanted);
  return {
    tier: floored ? floor : wanted,
    source: input.judged ? "judged" : "default",
    floored,
  };
}
