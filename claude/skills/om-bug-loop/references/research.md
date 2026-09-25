# Research — the method, the evidence bar, and the doc shape

*A reference for `om-research`. The agent definition at
`kanban/Workflow/Agents/om-research.md` carries the policy and the decision
rules; this file carries the mechanics. If the two disagree, the definition
wins and this one is the bug.*

## Why this agent exists

`om-task` is very good at a question that already has a right answer — something
is broken, prove why, fix it, prove it is fixed. It is badly suited to a
question that does not: *should the copy-link affordance look like Discord's?*
Handed to `om-task`, that becomes a diff nobody asked for, defended by a
verification spec that only proves the diff does what the diff says.

So the two lanes differ in exactly one place — **what counts as done**:

| | `om-task` (`T<n>`) | `om-research` (`R<n>`) |
|---|---|---|
| the input | something is broken | something is undecided |
| the proof | a `file:line` root cause | a `file:line` current implementation **and** observed comparables |
| who writes the diff | Codex | nobody, yet |
| the terminal state | a merged MR | a filed doc and a decision Nicholas makes |
| the last 5% | shipping it | the one question you may not answer |

## The evidence bar

This is the whole reason the agent is expensive. Two standards, and they are
not the same standard:

**About our code** — a `file:line`. Same bar as a root cause. If you write "the
client builds the link locally", the reader must be able to click through to the
line that does it.

**About another product** — an artifact *you* captured, in `$EVIDENCE/<slug>/`.
Ranked:

1. **The real client, driven and screenshotted.** Best evidence there is. A
   description of an affordance always loses the thing being asked about.
2. **Public API / developer docs.** Quote it, with the URL and the date you
   fetched it. Their docs change.
3. **Engineering blog, changelog, public RFC.** The only source that tells you
   *why*, and what it cost them.
4. **Open-source client**, where one exists. The actual mechanism.

**A search result is a pointer to evidence, never the evidence.** Neither is
your memory of the product, however sure it feels — competitor behaviour is
remembered wrongly by everyone, confidently, and a doc built on recollection
gets cited for a year.

If you cannot observe something, write **"could not verify — <what you tried>"**.
An honest gap is worth more than a confident paragraph, because it tells
Nicholas precisely where to look himself.

## Picking comparables

Two minimum, and say why you picked them.

| product | what it is the reference for |
|---|---|
| **Discord** | the default for any chat surface — it is what Nicholas is comparing against, and usually what the card means by "like other apps" |
| **Slack** | threading, search, workspace and permission models |
| **Linear** | keyboard-first interaction, command surfaces, speed as a feature |
| **Notion** | documents, blocks, embeds, and doc/chat boundaries |
| **Telegram** | link handling, media, and the low-latency end of chat |

Record for each: the behaviour, the affordance, the edge cases they handle, and
**what they deliberately do not do**. The omissions are the most useful part —
they are someone else's answer to a scope question you are about to have.

## The doc

Lives at `Obisidian/openmarket/architecture/<Topic>.md`, alongside
`Account profiles.md` and `Presence.md`. Titled for the *subject*, not the
ticket: `Invite link affordances.md`, never `R3 research.md` — these docs get
read years after the card is closed.

Every `[[wikilink]]` carries a **vault-root-relative full path**. Obsidian
resolves from the vault root, so a bare `[[cards/foo]]` renders as a dead link
and creates a stray note when clicked.

Write for a newcomer. Nicholas is new to a lot of the domain vocabulary, so
define the jargon on first use — a term used without definition is a defect in
the doc, not a shortcut.

```markdown
# <Topic>

**Question** <the one sentence the card asked>
**Ref** R<n> · **Filed** <date> · **Lane** chat | chart
**Recommendation** <two sentences, the answer first>

## How we do it today

<the current mechanism, with file:line for every claim. What it does well,
not only what it does badly. Why it is this way, where the history says so.>

## How others do it

### <Product>
<observed behaviour · the affordance · edge cases handled · what they don't do>
![[<vault path to the screenshot>]]
> quoted source — URL, retrieved <date>

### <Product>
<…>

**Could not verify** <anything you reached for and could not observe>

## The delta

**Files and contracts that move** <named, with the rough shape of the diff>
**Blast radius** <other readers of the contract · cloud fork · rooms-client
consumers · backends · migrations · version bumps>

| option | what it costs | what it buys |
|---|---|---|
| <recommended, first> | | |
| | | |

**Size** one task · a chain · a project
**Ruled out** <what, and on what evidence>

## The question

<one sentence, answerable in a word>
```

## Parking, which is the terminal state

There is no shipping edge. When the doc is filed:

```bash
K=~/.claude/skills/om-bug-loop/scripts/kanban.ts
bun $K note   R<n> --file <card-note.md>
bun $K upsert R<n> --column "Need Attention"
```

The card note carries the recommendation itself, not just a link to it —
Nicholas reads the board, and a recommendation reachable only by opening a
second file has not been delivered.

**Park before researching** if the card is not a research question:

- it is a **defect with a reproduction** → one line saying so, park for
  promotion to `om-task`. Do not research a bug.
- it needs a **product decision from Nicholas** before any comparison means
  anything → ask that first, research after.

## Refs

Research items get their own namespace so the letter stays load-bearing on a
mixed board:

```bash
bun $K next-ref --research     # → R1, counted separately from T
bun $K backlog "<title>" --research
```

A burned R number stays burned, exactly as a burned T does.
