# Scoping your own test run

Your scoped run is the task owner's **inner loop**, not regression evidence —
the full suite is `om-verifier`'s and only its. What this file answers is the
one question the inner loop keeps getting wrong: *given the files I changed,
which tests actually have to run?*

Every rule below was paid for by a task that got it wrong. The cost is quoted
because it is the argument: a scope that looks thorough and is one hop short
fails at the most expensive possible moment, after implementation and after a
full capture matrix.

**Scope by the TRANSITIVE importer closure, not direct importers.** Walk the
importer graph outward from every file you changed until it stops growing, then
take every test file in the closure. One level is not enough and has already
cost a full verify-fix-reverify cycle:

```bash
# every module that reaches the changed file, at any depth
names="RightPanels"                      # basenames of what you changed, |-separated
for i in 1 2 3 4; do
  next=$(grep -rlaE "from ['\"][^'\"]*($names)['\"]" src test \
           --include='*.ts' --include='*.tsx' \
         | sed 's|.*/||; s|\.[jt]sx\?$||' | sort -u | paste -sd'|' -)
  [ "$next" = "$names" ] && break
  names="$names|$next"
done
grep -rlaE "from ['\"][^'\"]*($names)['\"]" test --include='*.ts' --include='*.tsx' | sort -u
```

Include lazy/dynamic references, not just `import` statements — a static grep
silently misses every test that mounts a component through a dynamic import,
which is how one review understated its own coverage by 43%.

**Why it must be transitive.** T23 changed `RightPanels.tsx`. Its scoped run
was green. The full suite then found `topic-list-view.test.ts` going
**77 pass → 18 pass / 59 fail** and `center-column-boundary.test.tsx` going
**3 → 0**, both deterministic, both clean on the merge-base, all with the same
error: `TypeError: session.rightRegionOpen is not a function`. Those tests
exercise `ChatPane` and `TopicListView`, which *import* `RightPanels` — so they
were two hops out and the one-level scan never saw them. The break surfaced at
the most expensive possible moment, after implementation and after a full
capture matrix, and cost an entire re-verification.

**God-file exception — scope by SYMBOL, not file.** `src/lib/session.ts` has
**397 direct importers**, so its transitive closure is the entire suite and the
rule degenerates to no scoping at all. When the file you changed has fan-in like
that, find every reader of the **symbol** you touched, then take the transitive
closure of *those* call sites. Say in your report which scoping you used, so a
reader can tell a deliberate narrowing from a missed one.

**Hub-module escape hatch — stop expanding at an app root.** The closure
saturates uselessly on any file whose importers reach a root component. Measured
on T26: `ChannelHeaderMenus.tsx` reached **543 of 829 test files (65%)** in three
hops via `ChannelToolbar -> ChatPane -> Shell -> App`. That is a hub artefact,
not a dependency signal — `Shell` and `App` reach everything, so "run every test
in the closure" degenerates into "run the full suite", which is the verifier's
job and does not complete on this machine anyway.

So: **stop expanding the moment the frontier reaches an app-root module**
(`Shell`, `App`, or anything that mounts the whole tree), and scope by **symbol**
from there — the same escape hatch the god-file rule already uses. Bound it, and
**say in your report where you bounded and why**, so a narrow scope reads as a
decision rather than an omission.

**Scope by the symbol you change AND by any interface you widen.** The two are
different, and the second is the one that bites. T24 changed `rightRegionOpen`
— five readers, trivially tractable — but the real risk was the *structural
session reads* its change widened, which reached test fixtures carrying stubs
with none of the new fields. Symbol scoping alone would have missed them.

So: if your change adds a field, a union member, a prop, or a required shape,
find every construction site of that interface — **fixtures and test stubs
especially**, since they are hand-written and will not have the new member — and
put them in scope.

**A cast is a construction site.** `... as unknown as ChatSession` names no
symbol you changed and imports nothing you touched, so a symbol-scoped run
cannot reach it — and a hand-written fake behind such a cast is *guaranteed* to
lack whatever member you just added. T49 round 4 was FAILed by exactly one of
these: a fixture with `active: {kind:"room"}` and no `consumeDockedDocRestore`,
found only by the full suite after a `bindRouting`-scoped run came back clean.
Grep the interface's name in `test/` including its casts, not just its
importers.

The remedy for such a fixture is to **complete the fixture**, never to soften
the production call site. Optional-chaining a call that is typed non-optional
weakens real code to fit an incomplete double, and hides the next one that
drifts.

**And scope by any INVARIANT you widen, not just interfaces.** A file-size
ratchet, a god-file accretion budget, a manifest hash — these are construction
sites of nothing and import nothing, so no importer closure can reach them.
T27's verifier FAILed on exactly this: `session.ts` grew five lines and tripped
the accretion ratchet, which no bounded scope could have seen. If your change
adds lines to a ratcheted file, touches a manifest, or moves a counted number,
put that gate in scope by name.

## Why `--shards 2`, and not the default

`bun tools/test-fast.ts --shards 2 <path-filter>`. The default is one shard per
core, which assumes you own the machine — **you do not.** Other agents are
working and Nicholas is at the keyboard; a full-width run starves them.

**`--shards` belongs to `tools/test-fast.ts`, NOT to `bun test`.**
`bun test --shards 2 <path>` does not error — bun parses the bare `2` as another
**path filter** and silently pulls in unrelated test files. If you invoke
`bun test` directly, pass files and nothing else.

## The short version

1. Walk the importer graph **transitively**, not one level.
2. Stop at an app root (`Shell`, `App`) and switch to symbol scoping.
3. For a god-file (400+ importers), scope by symbol from the start.
4. Add every **construction site** of an interface you widened — fixtures and
   casts included, which no importer walk can reach.
5. Add by name any **invariant** you moved: a ratchet, a budget, a manifest hash.
6. **Say in your report where you bounded the scope and why.** A narrow scope
   must read as a decision, never as an omission.
