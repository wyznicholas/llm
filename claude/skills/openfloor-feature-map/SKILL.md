---
name: openfloor-feature-map
description: One-night build of the complete Feature Map for OpenFloor, the mobile OM Chat app (openmarket-chat-app, Expo/React Native). Runs under midnight-run.sh in phases — inventory, map-1..map-6, digest. Writes agent-facing entries into the vault's openmarket-mobile/Feature Map/. Writes no product code, files no cards, opens no MR. Trigger: /openfloor-feature-map
user-invocable: true
---

# openfloor-feature-map

You run one **phase** of a night, named by `$ROUTINE_PHASE`. Read
`$ROUTINE_HANDOFF` first; it is the only state that crosses phases. Keep it
small: decisions and short lists inline, paths to anything large.

Everything is local. **Never contact `oms-mac-mini`.** Write no product code,
commit nothing, file no Kanban cards: tonight the map is the only output.

## Inputs

| what | where |
|---|---|
| app repo | `/Users/nicholas/Documents/GitlabRepos/openmarket-chat-app` (read-only) |
| commit being catalogued | `$ROUTINE_WORK/commit.txt` (written by preflight) |
| repo's own guides | `CLAUDE.md`, `AGENTS.md`, `docs/NAVIGATION.md`, `docs/ARCHITECTURE.md`, `docs/WEB_PARITY_GAPS.md`, `docs/PUSH_NOTIFICATIONS.md`, `docs/UIUX.md` |
| web map (the quality bar) | `/Users/nicholas/Documents/Obisidian/openmarket/Feature Map/` — read `README.md` and `settings-notification-tones.md` before writing anything |
| output | `/Users/nicholas/Documents/Obisidian/openmarket-mobile/Feature Map/` (the mobile map's own home; the web map stays read-only tonight) |

**Reading `~/Documents` under launchd:** use the Read, Glob and Grep tools, not
`cat`/`sed`/`ls` in Bash. Apple's system binaries are TCC-denied there while
*creating* files still succeeds, so a Bash read that comes back empty and is then
written out clobbers real content. Never write a file whose previous contents you
read through Bash. For git, run it through `/opt/homebrew/bin/node -e` with
`child_process.execFileSync`.

## Where OpenFloor differs from the web map

- It is **one app on two platforms**, not two forks. Bundle id
  `sh.openmarket.openfloor` (iOS), package `com.openmarket.chat` (Android), URL
  scheme `openfloor://`; Android also filters `om://`.
- It always talks to **production** (`openmarket.xyz/chat`). There is no local
  backend.
- Routes live under `src/app/` (expo-router), but `_layout.tsx` is the only
  layout and parked screens stay mounted. Read `docs/NAVIGATION.md` §1–§3 before
  writing any "How to get to it". The four home tabs are **one** route (`?tab=`).
- Native surfaces exist outside `src/`: `modules/openfloor-canvas`,
  `modules/openfloor-composer`, `targets/openfloor-nse` (iOS notification service
  extension), `plugins/`. A feature that depends on them is a **dev-build-only**
  feature, and the entry says so.
- `export:smoke` builds a web target that deliberately lacks durable credentials,
  Rooms and push. **A surface is never "verified" from the web export.**

## Entry contract

`openmarket-mobile/Feature Map/README.md` is the map: a provenance table (commit from
`commit.txt`, date, emulator state), then categories with one linked bullet per
feature. Every feature file is `openmarket-mobile/Feature Map/<kebab-slug>.md` with a one-paragraph
lead and exactly these H2s, in order:

1. `## Sub-features`
2. `## How to get to it (user POV)` — taps from a cold, signed-in launch. Never
   invent a click path: derive it from the route tree and the component that
   renders the entry point, and cite `file:line`.
3. `## Driving it (iOS simulator / Android emulator)` — the route, any deep link
   (`openfloor://…`, `adb shell am start -W -a android.intent.action.VIEW -d …`),
   the testIDs or accessibility labels to target, and which platform it has been
   *observed* on, if any.
4. `## Web counterpart` — a wikilink to the matching web entry as a
   **vault-relative full path**, e.g. `[[openmarket/Feature Map/app-shell]]`, plus
   the parity state from `docs/WEB_PARITY_GAPS.md`. Links between mobile
   entries use `[[openmarket-mobile/Feature Map/<slug>]]`. Write `none` if there is no
   counterpart. Obsidian resolves `[[…]]` from the vault root.
5. `## Gotchas` — platform splits, dev-build-only dependencies, auth or push
   preconditions, and anything that would mislead a verifier.

End every file with the provenance line
`_Catalogued from openmarket-chat-app @ <short sha>, <date>. Observed: <ios|android|none>._`

**Read versus observed.** Everything is source-read unless you actually saw it on
a device tonight. Write "observed" only with a screenshot path beside it. Getting
this wrong is what makes a map dangerous rather than useless.

## Emulator (optional)

If `adb get-state` says `device` and `com.openmarket.chat` is installed, you may
observe a surface: launch it by deep link, `adb exec-out screencap -p >
"/Users/nicholas/Documents/Obisidian/openmarket-mobile/Feature Map/evidence/<slug>.png"`, and `adb exec-out uiautomator dump
/dev/tty` for labels. **Never sign in, enter credentials, post, react, or change
settings.** If the app sits on the sign-in screen, observe only the signed-out
surfaces and say so in the digest. If there is no emulator, go straight on with
source-read entries; that is not a failure.

## Phase `inventory`

1. Read the inputs above. Enumerate every user-visible surface: each route in
   `src/app/`, each sheet, modal, panel or overlay reachable from them (grep
   `src/rooms`, `src/ui`, `src/auth`, `src/push`, `src/voice`, `src/apps`), the
   signed-out and two-factor flows, push/notification surfaces, and native
   module surfaces. Size features as the web map does: one file per thing a user
   would name ("channel pins", not "details.tsx").
2. Group them into categories and split the list into **six batches of roughly
   equal effort**, keeping each category inside one batch where you can.
3. Write `openmarket-mobile/Feature Map/README.md` with provenance, categories and a bullet per
   feature (links resolve once the files exist).
4. Do **not** edit anything under `openmarket/Feature Map/` — midnight-scout owns
   that folder and its audit stamps. Cross-links go one way: mobile → web.
5. Write to `$ROUTINE_HANDOFF`:

```
commit: <sha>
emulator: up-installed | up-no-app | absent
batch-1: slug, slug, …
…
batch-6: slug, slug, …
done: (none yet)
```

## Phases `map-1` .. `map-6`

Write every entry in batch N. **The clock is the authority:** each phase gets
about an hour. Write finished entries first and leave any remaining slugs
unwritten rather than half-writing all of them. Before ending your turn, append
to `$ROUTINE_HANDOFF`:

```
map-N: wrote <n>/<m>; skipped: <slugs or none>; observed: <slugs or none>
```

You may spawn up to four `Explore` subagents in parallel to trace entry points
for a batch. They return conclusions; you write the files.

## Phase `digest`

1. Pick up any slugs a phase skipped and write them if budget remains.
2. Reconcile `openmarket-mobile/Feature Map/README.md` against the files on disk: every bullet
   links to a file that exists, and every file has a bullet.
3. Deliver **exactly one** report with `scout-report.sh`, covering: commit
   catalogued; features written per category; which were observed on a device
   and which were source-read only; skipped slugs; and the top five gotchas a
   newcomer to the mobile app would hit. Link the map as
   `[[openmarket-mobile/Feature Map/README]]`.

Do not claim verification you did not do.
