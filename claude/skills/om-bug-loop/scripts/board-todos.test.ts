// board-todos.test.ts — the fixture is a faithful slice of the real board.
import { describe, expect, test } from "bun:test";
import { readTodoLane } from "./board-todos";

const BOARD = [
  "---", "", "kanban-plugin: board", "", "---", "",
  "## backlog", "",
  "- [ ] something parked #low",
  "",
  "## todo", "",
  "- [ ] midnight workflow #medium #human",
  "- [ ] play around with the right click of the server settings #low #pa",
  "- [ ] copy link om://topic/bc0ccbe5 kinda ugly #low #research",
  "- [ ] restriction for openmarket chat #low ![[Pasted image 20260907171814.png]]",
  "- [ ] [[Invite Link server breaking down]] #low",
  "- [ ] weird logics![[Pasted image 20260908143631.png]]",
  "- [ ] **T90 · The formatting strip's only keyboard door** [[kanban/cards/format-toolbar-altf10-dead|details]] #low #openmarket",
  "- [ ] **T91 · ✓ Composer shortcuts disappear** [[kanban/cards/composer-shortcuts|details]] #low #openmarket",
  "- [ ] **F12 · ✓ ✓ Screen reader labels** [[kanban/cards/screen-reader-labels|details]] #low #feature",
  "- [ ] **C14 · Read retained history** [[kanban/cards/archived-channels-readable|details]] #low",
  "- [ ] **todo · Keyboard & focus (3)** [[kanban/cards/group-todo-keyboard-focus|details]] #openmarket #group",
  "",
  "## in progress", "",
  "- [ ] not in the todo lane #high",
  "",
].join("\n");

const lane = readTodoLane(BOARD);
const byTitle = (t: string) => lane.find(c => c.title === t)!;

describe("readTodoLane", () => {
  test("reads only the todo section", () => {
    expect(lane).toHaveLength(11);
    expect(lane.map(c => c.title)).not.toContain("something parked");
    expect(lane.map(c => c.title)).not.toContain("not in the todo lane");
  });

  test("strips tags from the title but keeps them in tags[]", () => {
    const c = byTitle("midnight workflow");
    expect(c.tags).toEqual(["#medium", "#human"]);
    expect(c.claimed).toBe(false);
  });

  test("strips an image embed from the title and keeps the title intact", () => {
    const c = byTitle("restriction for openmarket chat");
    expect(c.tags).toEqual(["#low"]);
  });

  test("an embed jammed against the text still leaves a clean title", () =>
    expect(byTitle("weird logics").tags).toEqual([]));

  test("a card that is ENTIRELY a wikilink uses the link text as its title", () => {
    const c = byTitle("Invite Link server breaking down");
    expect(c.tags).toEqual(["#low"]);
    expect(c.claimed).toBe(false);
  });

  test("a pipeline card is claimed, and its ref is not part of the title", () => {
    const c = byTitle("The formatting strip's only keyboard door");
    expect(c.claimed).toBe(true);
  });

  test("a legacy-ticked pipeline card stays claimed, with neither ref nor tick in its title", () => {
    const c = byTitle("Composer shortcuts disappear");
    expect(c.claimed).toBe(true);
    expect(c.title).not.toContain("T91");
    expect(c.title).not.toContain("✓");
  });

  test("a legacy-ticked claimed F card has neither its ref nor repeated ticks in its title", () => {
    const c = byTitle("Screen reader labels");
    expect(c.claimed).toBe(true);
    expect(c.title).not.toContain("F12");
    expect(c.title).not.toContain("✓");
  });

  test("another pipeline's C card is claimed too, with no special case", () =>
    expect(byTitle("Read retained history").claimed).toBe(true));

  test("a grouped todo card is claimed and never offered as raw intake", () => {
    const group = byTitle("todo · Keyboard & focus (3)");
    expect(group.claimed).toBe(true);
    expect(group.tags).toEqual(["#openmarket", "#group"]);
  });

  test("lineNo points at the real line", () =>
    expect(BOARD.split("\n")[byTitle("midnight workflow")!.lineNo]).toContain("midnight workflow"));

  test("tags are lowercased", () => {
    const one = readTodoLane(["## todo", "- [ ] x #Research #LOW"].join("\n"));
    expect(one[0]!.tags).toEqual(["#research", "#low"]);
  });
});
