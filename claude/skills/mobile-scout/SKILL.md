---
name: mobile-scout
description: Nightly 00:00-08:00 feature-by-feature audit of OpenFloor, the mobile app, on the iOS simulator. Spawns om-play-around-mobile on each feature from the mobile Feature Map, which files findings as raw #mobile cards in the board's todo lane. Owns the mobile burn-down ledger; allocates no refs and dispatches no om-task. Trigger: /mobile-scout
user-invocable: true
---

# mobile-scout

midnight-scout's twin for OpenFloor (`openmarket-chat-app`). Same runner
(`midnight-run.sh`), same phase shape, same stamp marker, same filing path. What
differs is the device, the map, and the account rule below.

You run one **phase** of a night, named by `$ROUTINE_PHASE`. Read
`$ROUTINE_HANDOFF` first; it is the only state that crosses phases. Keep it
small: decisions and short tables inline, paths to anything large.

Everything is local. **Never contact `oms-mac-mini`.**

## The account rule — read this before anything else

OpenFloor has no local backend. The simulator is signed in to **production as
Nicholas himself**. His ruling for this routine (2026-09-21):

- **Reading is allowed everywhere**, knowing it fires read receipts and clears
  his unread state. So every room, DM or thread opened is **disclosed**: each
  feature phase records it in the handoff, and the digest lists them.
- **Writes only inside the `nalo` server.** Nowhere else: no sends, reactions,
  edits, pins, invites, mutes, renames, deletes or joins.
- **Never account-global state, even in `nalo`**: the desk/pinned shelf,
  appearance, notification and privacy settings, profile, friends, sign-out,
  anything behind preference sync. Those reach his desktop.
- **Never start or join a call** (the headphones icon), never grant an OS
  permission prompt, never follow an external link out of the app.

`om-play-around-mobile` carries the same rule in its contract. Do not restate or
loosen it in its prompt.

## What you own, and what you do not

You own the **mobile burn-down ledger**: which mobile features have been
audited, the audit notes, and the nightly report.

You do **not** allocate refs, write card notes, spawn `om-task`, or throttle.
The play agent files raw `#mobile` findings into `todo` with
`kanban.ts file-finding`; the `om-bug-loop` coordinator consumes them.

**Mobile dispatch is frozen** (since 2026-09-21, until Nicholas lifts it): the
coordinator consumes `#mobile` cards but does not dispatch them. So a mobile
card sitting in `todo` is expected, not stuck. Say so in the digest.

## Fixtures (preflight owns them — do not rebuild them)

`preflight` runs before `slice` and has already, or the night did not start:
booted simulator `2BAC3CD5-…` (iPhone 17 Pro), refreshed the scout's own
checkout at `~/.local/share/mobile-scout/openmarket-chat-app` to `origin/main`,
started **its own Metro on :8090**, opened the dev client against it and proven
Maestro can read the app. `$ROUTINE_WORK/build-stamp.txt` names the udid, JS
commit and native build.

Never touch Metro on `:8081` or the Android emulator — those belong to om-task
owners. Never `pkill`/`killall` anything.

## Phase `slice`

1. Confirm the app is **signed in**: `maestro --device <udid> hierarchy` and look
   for the sign-in screen (`src/app/sign-in.tsx`). Signed out means the night
   cannot audit anything: write `status: stop` and `reason: signed out` to the
   handoff, and end. Never sign in yourself.
2. Pick tonight's 8 features as one coherent area from
   `/Users/nicholas/Documents/Obisidian/openmarket-mobile/Feature Map/`
   (skip `README.md` and `audits/`). For each candidate, pipe
   `<filename>\t<its line containing **Audited** , or empty>` into
   `scripts/slice-filter.sh`; it prints the ones still fresh. **Use that
   script** — it and `stamp.sh` share one marker (`audit-mark.sh`), and matching
   by hand is how midnight-scout's burn-down silently broke once.
3. Prefer features reachable **without** opening many real rooms (settings
   views you only read, `nalo`, help, library, search UI) over ones that need
   a tour of his inbox; do not skip a feature for this, just order by it.
4. Check whether an om-bug-loop coordinator is up (`tmux ls`) and record it.

Write to `$ROUTINE_HANDOFF`:

```
slice: <area name>
build: <contents of $ROUTINE_WORK/build-stamp.txt, one line>
features: <8 filenames, one per line>
coordinator: up | absent
findings: (none yet)
opened: (none yet)
```

## Phases `feature-1` .. `feature-8`

One feature per phase, by position in the handoff's `features:` list. **The
clock is the authority**: un-audited ground goes in the audit note.

1. Read the feature's map entry. It was written from **source, not a device**
   (2026-09-18, signed-out app) — a strong lead, not an observation.
2. Spawn **`om-play-around-mobile`** (`subagent_type: "om-play-around-mobile"`,
   blocking, no `model:`). Its prompt carries only: the feature name, the
   absolute path to its map entry, the udid and build line from the handoff,
   and the evidence directory
   `/Users/nicholas/Documents/Obisidian/kanban/evidence/pa-mobile-<slug>/`.
   Do not tell it how to play.
3. Write the audit note from `templates/audit-note.md` into
   `openmarket-mobile/Feature Map/audits/<feature> <date>.md`, from its report —
   including **Rooms opened** and **Feature Map corrections**.
4. Stamp the feature file with the output of
   `scripts/stamp.sh <date> <js> <native> <note-wikilink> <n>`, appended at the
   foot. Use the script's text verbatim.
5. Append to `$ROUTINE_HANDOFF` **before ending your turn**: one line per
   finding under `findings:`, and every room it opened under `opened:`.

Zero findings is a result: write the note, stamp the feature.

## Phase `digest`

1. Run `scripts/metro-stop.sh` (stops this night's Metro by recorded PID).
2. Deliver **exactly one** report with `scout-report.sh`:
   - features audited, findings per feature;
   - findings already consumed by the coordinator (they carry an `F`/`T` ref)
     vs still raw in `todo`, and that mobile dispatch is frozen if it still is;
   - **every room, DM and thread opened on Nicholas's account** tonight;
   - features where the play agent could not reach the surface, or wanted a
     reference it could not capture;
   - the build line (JS commit + native build), and whether the native build is
     older than native changes on `main` (a JS-only audit of new native code is
     not an audit).

If the handoff says `status: stop`, the digest still runs and says why.

Do not report MR counts as yours.
