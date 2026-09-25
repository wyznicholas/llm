# om-bug-loop: multi-product design

**Date:** 2026-09-09 · **Status:** approved by Nicholas, pending implementation
**Supersedes:** the single-product repo scope in `SKILL.md` §3 step 5

## Why

The pipeline has exactly one environment story and it is hardcoded to OM Chat in
seven places. An investigator sent at a chart bug today would read the chat env
reference, try to drive `:31417`, and find no watchlist.

The change is not "add a repo". It is "make the environment lane a parameter".

## The abstraction: one field

`tasks.json` gains `product: "chat" | "chart"`. Every repo-specific instruction
keys off it. No new scripts, no new state files, no watcher change.

`kanban.ts` renders it in the machine-owned status block:

```
**T61** · **Status** investigating · **Product** chart · **Repo** kiyotaka-frontend
```

## Repo scope is two-tier

The old flat list conflated two different permissions. They separate:

**Fix repos** — where a Codex diff may land. Chosen by `product`.

| product | fix repos                                                      |
| ------- | -------------------------------------------------------------- |
| `chat`  | `openmarket-chat`, `rooms-client`, `kiyotaka-chat-service`     |
| `chart` | `kiyotaka-frontend` (package `kiyotaka-chart`), `titan-charts` |

`openmarket-chat-cloud` remains out of scope (Nicholas, 2026-09-08).

**Read repos** — anything cloned under `~/Documents/GitlabRepos/`, unrestricted,
for tracing a root cause. The user-data backends are named explicitly because
they sit behind both products:

| repo | remote |
|---|---|
| `auth-service-backend` | `openmarketxyz/common/` |
| `tharamine-user-service` | `openmarketxyz/js-backend/` |
| `orange-v2-backend` | `openmarketxyz/js-backend/` |

Nicholas, 2026-09-09: *"if anytime u need to have access to more repos, they are
probably already cloned, feel free to look at the repo when necessary."*

Reading is cheap — the global graphify graph (`~/.graphify/global-graph.json`,
symlinked from `GitlabRepos/graphify-out/graph.json`) already indexes all of
them. The failure this tier removes is an investigator stopping at the frontend
boundary and writing "probably a backend issue" instead of proving it.

A fix that must land in a read repo is a **follow-up task**, under the rule
`SKILL.md` §6 already carries: *"a plan step spanning a SECOND repo is out of
scope for the Codex run… it is a follow-up task."*

## Classification

Intake stays manual (§3b) — the watcher keeps polling ⌗ OM Chat Bugs only.
The coordinator classifies at capture, in this precedence:

1. **Nicholas said so.** "chart bug:" / "chat bug:" wins outright.
2. **The surface named.** Watchlist, workspace, chart, indicator, alert, symbol,
   scanner, orderbook → `chart`. Room, topic, DM, message, space, member,
   thread → `chat`.
3. **Ambiguous → ask.** One question, never a guess.

**The digest states the classification** ("T61 · chart · kiyotaka-frontend") so a
wrong call costs one word to correct, before an agent has burned 40 minutes in
the wrong repo.

## The env reference becomes a parameter

`om-task` today reads `references/openmarket-chat-env.md` unconditionally. It
becomes: *read the env reference your dispatch prompt names.*

- `references/openmarket-chat-env.md` — unchanged, gains a "this is the CHAT
  lane" header.
- `references/kiyotaka-chart-env.md` — **new**, contents below.

### Verified facts for the chart lane

| fact | why it matters |
|---|---|
| **`.env` is gitignored and untracked** | A fresh worktree gets no `.env` — vite boots with no `VITE_PORT`, no CME token, no API URLs, silently. Every chart worktree must copy `.env` from the shared checkout. This is the chart lane's "never `bun install`". |
| **`pnpm`, not `bun`** | Different lockfile; plus the `pnpm approve-builds` gotcha that silently blocks `pnpm dev`. |
| **Shared checkout is on `nicholas/production-alerts-C1`**, not main | It cannot serve as a base arm even read-only. Worktrees come off `origin/main`. |
| **`VITE_CME_API_MODE=mock`** | Local charts render synthetic data while the UI still says "Real-time". A data bug may be unreproducible locally until this is flipped. |
| **`pnpm typecheck` red on main (~1428 errors)** | Diff the error set, never expect green. `scripts/typecheck-ratchet.mjs` exists for it. |
| **`pnpm lint` clean on main**; browser lane needs `playwright install chromium-headless-shell` | What is actually trustworthy as a gate. |
| **`regression-impact-check` skill required** when kiyotaka-frontend is touched | Already named in `templates/plan-template.md`; now it has a lane that triggers it. |

Anything not verified by running it is marked **UNVERIFIED** in the file, and the
first chart task's owner is told to confirm and correct it — the way
`openmarket-chat-env.md` grew to 30 KB.

### titan-charts is publish-gated

The app consumes the engine as a published package,
`@orangecharts/titan-charts-next@0.0.4-alpha.861`, while the local checkout sits
at `alpha.816`. A fix there means publish a new alpha, then bump the pin — the
same shape as `rooms-client` in the chat lane.

**So `titan-charts` is a fix repo but never a fix step in a `kiyotaka-frontend`
task's Codex run.** A chart task whose root cause is in the engine writes the
finding into its plan and stops; the engine fix is dispatched as its own task,
with the pin bump as a third. This is the existing §6 second-repo rule applied,
not a new one — one worktree cannot reach two repos.

## Driving and evidence

Chart tasks do not touch `:31417`. The owner boots vite on `VITE_PORT=80NN`
(NN = task ref, the same namespacing that stopped T7/T8 killing each other's
daemons), once in the base worktree and once in the fix worktree, and
screenshots both arms.

**§8b2's wall-clock machinery is therefore chat-only** — `arm-env.sh`,
`clone_home`, `base_dist`, the 347 MB home clone, the `:31417` base-arm
shortcut. None applies to chart. What survives is the *obligation*: report build
and boot cost as a number, so the chart lane earns its own baseline instead of
inheriting an argument.

## Feature Map

`kanban.ts`'s gate checks existence, location, ≥80 chars and mtime — **not
heading text** (`entryProblem()`, kanban.ts:175). So the fourth H2 changing from
`## Driving it (testing-harness / :31417)` to `## Driving it` with the product's
own URL is a prose change with zero code risk.

**The map root becomes product-aware.** The vault already splits the two products
at its root — `openmarket/` and `openmarket-charts/`, each with its own
`architecture/` and `plans/`. Chart Feature Map entries belong under
`openmarket-charts/Feature Map/`, not in a `chart/` subfolder of the chat map.

This is small: `featuresRoot` is already threaded as a parameter through
`featureProblem()` (kanban.ts:215) and overridable with `--features`; only the
default — the `FEATURE_MAP_DIR` constant — is single-valued. It becomes a lookup
on `task.product`. `references/features` gains a `features-charts` sibling
symlink so both roots are nameable from the skill.

## Where markdown lands

**Every markdown a human reads goes in the vault, and exists exactly once.**

Nicholas, 2026-09-09: *"i can never read your md files, can u make sure i can
click on it and read them wtf? make them always put in obsidian could you?"*

This is not only convenience. This document's predecessor existed as BOTH
`openmarket/plans/26-09-01 om-bug-loop design.md` and the skill's
`docs/2026-09-01-om-bug-loop-design.md`, and the two had **drifted out of sync**
— the readable copy and the authoritative copy disagreed. Two copies is the
failure; one file plus a symlink is the fix, and it is the pattern the pipeline
already uses for `~/.claude/agents/om-{task,verifier}.md` and
`references/features`.

So: plans and specs to `openmarket/plans/` or `openmarket-charts/plans/` by
product, matching the sibling files' naming; anything the tooling expects at its
own path is **symlinked** there, never copied. Agents inherit this — a report an
agent writes for Nicholas lands in the vault too.

Two pre-existing copies (`docs/2026-09-01-om-bug-loop-{design,plan}.md`) are
already drifted. Reconciling them is out of scope here and worth its own task.

## Files touched

| file | change |
|---|---|
| `SKILL.md` | §3/§3b classification, §5 two-tier scope, §6/§7 product-aware env + driving, §8b2 marked chat-only, `tasks.json` schema, Feature Map heading |
| `references/kiyotaka-chart-env.md` | new |
| `references/openmarket-chat-env.md` | one-line lane header |
| `kanban/Workflow/Agents/om-task.md` | env reference parameterised; `:31417` assumptions marked chat-only |
| `kanban/Workflow/Agents/om-verifier.md` | same |
| `templates/*.md` | sweep for `:31417` / bun / openmarket-chat assumptions |
| `references/features-charts` | new symlink → `openmarket-charts/Feature Map/` |
| `scripts/kanban.ts` + `kanban.test.ts` | `product` in the status block; product-aware Feature Map root |

Agent definitions are edited at their **vault** paths under
`kanban/Workflow/Agents/`; `~/.claude/agents/om-{task,verifier}.md` are symlinks
to them.

## Testing

- `kanban.test.ts` gains coverage for `product` rendering: present, absent
  (renders without the field, nothing breaks), and unchanged across a re-stamp.
- End-to-end proof is the first chart task: the HIP-3 watchlist bug, dispatched
  through §3b as `product: chart`.

## Risk

- **A task entry predating `product`** renders its status block without the
  field — the same tolerance `ref` already has. No migration.
- **The chart env reference will be thin on first write.** It documents a lane
  nobody has run agents through. Expect the first chart task to be slower and to
  spend some of its time correcting that file. That is the cost of opening the
  lane, not a defect.
- **Rollback:** the `product` field is additive and ignored by every existing
  code path except the status block; reverting `SKILL.md` and deleting the new
  reference restores the single-product pipeline.
