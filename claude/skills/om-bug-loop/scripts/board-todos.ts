// board-todos.ts — read the `todo` lane's raw lines.
//
// `kanban.ts`'s own reader is deliberately blind to these: BOARD_CARD requires
// a bold title AND a `cards/<slug>|details` link, which is the format the
// PIPELINE writes. Everything Nicholas types by hand has neither, so a second
// reader is needed for exactly the cards this intake exists to pick up.
//
// Reading only. Routing lives in routing.ts; writing lives in kanban.ts.

/** A tag: `#` plus word characters. `#/` in a title (as in T70's "the bare
 *  address `#/`") is deliberately NOT a tag. */
const TAG = /#[A-Za-z0-9_-]+/g;
/** `[[link]]`, `[[link|display]]` and the `![[embed]]` image form. */
const LINK = /!?\[\[[^\]]+\]\]/g;
/** The pipeline's own card format — the same shape kanban.ts keys on. */
const CLAIMED = /^-\s*\[.\]\s*\*\*.+?\*\*\s*\[\[(?:[^\]|]*\/)?cards\/[^\]|]+\|/;
const CARD = /^-\s*\[.\]\s*(.*)$/;

export interface BoardTodo {
  /** 0-based index into the board's lines. */
  lineNo: number;
  /** The line exactly as written. */
  raw: string;
  /** Tags, embeds and the ref prefix removed. */
  title: string;
  /** Every tag on the line, lowercased, in order. */
  tags: string[];
  /** Already a pipeline card — never routed, never consumed twice. */
  claimed: boolean;
}

export function readTodoLane(boardText: string): BoardTodo[] {
  const out: BoardTodo[] = [];
  const lines = boardText.split("\n");
  let inLane = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) { inLane = heading[1]!.trim() === "todo"; continue; }
    if (!inLane) continue;

    const card = CARD.exec(line);
    if (!card) continue;
    const body = card[1]!;

    const rawTags = body.match(TAG) ?? [];
    const tags = rawTags.map(t => t.toLowerCase());
    const links = body.match(LINK) ?? [];

    let title = body;
    for (const piece of [...rawTags, ...links]) title = title.replace(piece, " ");
    title = title.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    // Strip a ref prefix and any legacy review-skip tick so a claimed card's
    // title matches its unclaimed form.
    title = title.replace(/^[TRCF]\d+\s*·\s*(?:✓\s*)*/, "");

    // A card whose whole title IS a wikilink — `- [ ] [[Invite Link …]] #low`.
    // Stripping the link would leave nothing, so the link's display text is
    // the title. Image embeds (`![[…]]`) are never titles.
    if (!title) {
      const named = links.find(l => !l.startsWith("!"));
      if (named) {
        title = named.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|").pop()!.trim();
      }
    }
    if (!title) continue; // nothing readable; not a card we can act on

    out.push({ lineNo: i, raw: line, title, tags, claimed: CLAIMED.test(line) });
  }
  return out;
}
