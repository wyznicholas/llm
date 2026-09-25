import { describe, expect, test } from "bun:test";
import {
  BUG_TAG, FEATURE_TAG, HARD_TAG, HUMAN_TAG, PA_TAG, RESEARCH_TAG, TRIVIAL_TAG,
  route, tier, tierRank,
} from "./routing";

const t = (tags: string[], title = "some card") => route({ title, tags });

describe("route — the tag is Nicholas's classification and nothing overrules it", () => {
  test("#human is a veto: the pipeline never touches the card", () => {
    expect(t([HUMAN_TAG])).toBe("skip");
    expect(t([HUMAN_TAG, BUG_TAG])).toBe("skip");
    expect(t([HUMAN_TAG, RESEARCH_TAG])).toBe("skip");
    expect(t([HUMAN_TAG, PA_TAG, BUG_TAG])).toBe("skip");
  });

  test("#research outranks #pa and #bug", () => {
    expect(t([RESEARCH_TAG])).toBe("om-research");
    expect(t([RESEARCH_TAG, PA_TAG])).toBe("om-research");
    expect(t([RESEARCH_TAG, BUG_TAG])).toBe("om-research");
  });

  test("#pa outranks #bug", () => {
    expect(t([PA_TAG])).toBe("om-play-around");
    expect(t([PA_TAG, BUG_TAG])).toBe("om-play-around");
  });

  test("#bug routes to om-task", () => expect(t([BUG_TAG])).toBe("om-task"));

  test("untagged is IDENTICAL to #bug, not a separate case", () => {
    expect(t([])).toBe("om-task");
    expect(t([])).toBe(t([BUG_TAG]));
    expect(route({ title: "anything at all" })).toBe("om-task");
  });

  test("priority and project tags are not routing tags", () => {
    expect(t(["#low", "#openmarket"])).toBe("om-task");
    expect(t(["#medium", "#charts"])).toBe("om-task");
    expect(t(["#research", "#low", "#openmarket"])).toBe("om-research");
  });

  test("a tag nobody owns does not route", () =>
    expect(t(["#somethingelse"])).toBe("om-task"));

  test("tag matching is case-insensitive", () => {
    expect(t(["#Research"])).toBe("om-research");
    expect(t(["#HUMAN"])).toBe("skip");
    expect(t(["#PA"])).toBe("om-play-around");
  });

  test("a defect-shaped title tagged #research still goes to om-research", () =>
    expect(route({
      title: "The `+` button opens the attachment menu but can never close it again",
      tags: [RESEARCH_TAG],
    })).toBe("om-research"));
});

// ---------------------------------------------------------------------------
// #feature (2026-09-11). Both #bug and #feature end in a merged MR, so the
// precedence between them and their NON-interchangeability are the two things
// worth pinning: a defect's plan proves a root cause, a feature's writes
// acceptance criteria, and routing one as the other yields a plan the verifier
// cannot check.
// ---------------------------------------------------------------------------
describe("#feature — the build lane, distinct from the fix lane", () => {
  test("#feature routes to om-feature", () =>
    expect(t([FEATURE_TAG])).toBe("om-feature"));

  test("#human still vetoes it, like everything else", () =>
    expect(t([HUMAN_TAG, FEATURE_TAG])).toBe("skip"));

  test("#research outranks #feature — undecided beats build-it", () => {
    // Tagging something research is Nicholas saying it is not settled, and you
    // cannot build a thing that has not been decided.
    expect(t([RESEARCH_TAG, FEATURE_TAG])).toBe("om-research");
    expect(t([FEATURE_TAG, RESEARCH_TAG])).toBe("om-research");
  });

  test("#feature outranks #pa — build-it beats go-play-with-it", () => {
    expect(t([FEATURE_TAG, PA_TAG])).toBe("om-feature");
    expect(t([PA_TAG, FEATURE_TAG])).toBe("om-feature");
  });

  test("#feature outranks #bug: a card carrying both is a build, not a fix", () => {
    // The two lanes are not interchangeable. A feature plan has no root cause
    // to prove, so sending it down the defect lane produces a plan that cannot
    // clear the digest→codex edge.
    expect(t([FEATURE_TAG, BUG_TAG])).toBe("om-feature");
    expect(t([BUG_TAG, FEATURE_TAG])).toBe("om-feature");
  });

  test("the full precedence chain, in one assertion per rung", () => {
    expect(t([HUMAN_TAG, RESEARCH_TAG, FEATURE_TAG, PA_TAG, BUG_TAG])).toBe("skip");
    expect(t([RESEARCH_TAG, FEATURE_TAG, PA_TAG, BUG_TAG])).toBe("om-research");
    expect(t([FEATURE_TAG, PA_TAG, BUG_TAG])).toBe("om-feature");
    expect(t([PA_TAG, BUG_TAG])).toBe("om-play-around");
    expect(t([BUG_TAG])).toBe("om-task");
    expect(t([])).toBe("om-task");
  });

  test("matching is case-insensitive, as for every other tag", () => {
    expect(t(["#Feature"])).toBe("om-feature");
    expect(t(["#FEATURE"])).toBe("om-feature");
  });

  test("UX polish is a feature, not a defect — the tag is what decides", () => {
    // "works but feels wrong" is routed by the tag om-play-around chose, never
    // by anything read out of the title.
    expect(t([FEATURE_TAG], "the profile popup should be a standard place")).toBe("om-feature");
    expect(t([BUG_TAG], "the profile popup should be a standard place")).toBe("om-task");
  });
});

// ---------------------------------------------------------------------------
// Tiers (2026-09-24). A tier decides how much pipeline a card buys: trivial →
// om-quickfix, normal → the owner on Sonnet, hard → the owner on Opus. The goal
// is throughput — a typo should not wait behind an investigation, a plan and a
// second daemon. Precedence is Nicholas's rule, verbatim: his tag wins; then
// the categories he reads himself, and any #high feature, floor at normal;
// otherwise the coordinator's judgement, and normal when it has none.
// ---------------------------------------------------------------------------
describe("tier — Nicholas's tag, then the floor, then the coordinator's judgement", () => {
  test("no tag, no judgement → normal (the when-unsure default)", () =>
    expect(tier({}).tier).toBe("normal"));

  test("the coordinator's judgement stands when nothing floors it", () => {
    expect(tier({ judged: "trivial" }).tier).toBe("trivial");
    expect(tier({ judged: "hard" }).tier).toBe("hard");
  });

  test("an important category floors trivial up to normal", () => {
    const got = tier({ judged: "trivial", importantCategory: true });
    expect(got.tier).toBe("normal");
    expect(got.floored).toBe(true);
  });

  test("the floor never pulls a hard judgement down", () =>
    expect(tier({ judged: "hard", importantCategory: true }).tier).toBe("hard"));

  test("a #high feature floors at normal; a #high bug does not", () => {
    expect(tier({ judged: "trivial", priority: "high", feature: true }).tier).toBe("normal");
    expect(tier({ judged: "trivial", priority: "high", feature: false }).tier).toBe("trivial");
    expect(tier({ judged: "trivial", priority: "medium", feature: true }).tier).toBe("trivial");
  });

  test("his tag beats the floor and the judgement — both ways", () => {
    expect(tier({ tags: [TRIVIAL_TAG], importantCategory: true, judged: "hard" }).tier).toBe("trivial");
    expect(tier({ tags: [HARD_TAG], judged: "trivial" }).tier).toBe("hard");
    expect(tier({ tags: [TRIVIAL_TAG] }).source).toBe("tag");
  });

  test("#trivial and #hard together resolve to the heavier one", () =>
    expect(tier({ tags: [TRIVIAL_TAG, HARD_TAG] }).tier).toBe("hard"));

  test("tier tags are case-insensitive and are not routing tags", () => {
    expect(tier({ tags: ["#Trivial"] }).tier).toBe("trivial");
    expect(t([TRIVIAL_TAG])).toBe("om-task");
    expect(t([HARD_TAG, FEATURE_TAG])).toBe("om-feature");
  });

  test("tierRank orders the tiers for the up-only escalation check", () => {
    expect(tierRank("trivial")).toBeLessThan(tierRank("normal"));
    expect(tierRank("normal")).toBeLessThan(tierRank("hard"));
  });
});
